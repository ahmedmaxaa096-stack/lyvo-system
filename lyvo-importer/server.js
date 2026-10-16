/* ============================================================
 * LYVO Product Importer — الخادم الخلفي
 * معالجة الإكسل، البحث، الجلب، الصور، التصدير
 * ============================================================ */

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const { loadProject, saveProject, addLog, dirs } = require("./lib/state");
const { inspectFile, extractColumn } = require("./lib/excel");
const { parseFirstSku, assignSkus } = require("./lib/sku");
const { startProcessing, cancelProcessing, status } = require("./lib/worker");
const { preExportCheck, exportExcel, buildZipArchive, cleanupOldExports } = require("./lib/exporters");
const { fetchProductDetails } = require("./lib/searcher");
const { saveRowImages } = require("./lib/images");

const app = express();
const PORT = process.env.PORT || 4176;
app.use(express.json({ limit: "12mb" }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, dirs().UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, "input.xlsx"),
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(xlsx|xls|ods)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error("يُرجى رفع ملف Excel بصيغة .xlsx أو .xls"));
  },
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  try {
    const state = loadProject();
    addLog(state, "تم رفع ملف الإكسل: " + (req.file ? req.file.originalname : ""));
    state.sheet.fileName = req.file ? req.file.originalname : "";
    state.rows = [];
    state.duplicatesDetected = [];
    saveProject(state);
    const sheets = inspectFile(path.join(dirs().UPLOADS_DIR, "input.xlsx"));
    res.json({ ok: true, sheets, sheet: state.sheet });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/sheets", (req, res) => {
  try {
    const pathFile = path.join(dirs().UPLOADS_DIR, "input.xlsx");
    if (!fs.existsSync(pathFile)) return res.status(400).json({ error: "لا يوجد ملف مرفوع بعد" });
    const sheets = inspectFile(pathFile);
    res.json({ ok: true, sheets });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/extract", (req, res) => {
  try {
    const { sheetName, columnIndex, hasHeader } = req.body;
    const pathFile = path.join(dirs().UPLOADS_DIR, "input.xlsx");
    if (!fs.existsSync(pathFile)) return res.status(400).json({ error: "ارفع ملف الإكسل أولاً" });
    const { rows, duplicates } = extractColumn(pathFile, sheetName, columnIndex, hasHeader !== false);
    const state = loadProject();
    state.sheet.sheetName = sheetName;
    state.sheet.columnIndex = columnIndex;
    state.sheet.hasHeader = hasHeader !== false;
    state.rows = rows.map((r, i) => ({
      rowIndex: i,
      sheetRow: r.sheetRow,
      original_name: r.name,
      product_name: "",
      sku: "",
      price: null,
      currency: "",
      description: "",
      image_url: "",
      image_filename: "",
      image_labeled_file: "",
      product_url: "",
      status: "pending",
      match_score: null,
      match_detail: "",
      candidates: [],
      error: "",
    }));
    state.duplicatesDetected = duplicates;
    saveProject(state);
    res.json({ ok: true, count: rows.length, duplicates: duplicates.map((d) => d.name) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/settings", (req, res) => {
  try {
    const { brand, siteUrl, currency, writeSkuOnImage } = req.body || {};
    const state = loadProject();
    if (brand != null) state.brand = String(brand).trim();
    if (siteUrl) {
      const raw = String(siteUrl).trim();
      const goodUrl = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
      new URL(goodUrl);
      state.siteUrl = goodUrl;
    }
    if (currency) state.currency = String(currency).trim().toUpperCase();
    if (typeof writeSkuOnImage === "boolean") state.writeSkuOnImage = writeSkuOnImage;
    saveProject(state);
    res.json({ ok: true, state: publicState(state) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* SKU */
app.post("/api/sku", (req, res) => {
  try {
    const { firstSku } = req.body || {};
    const state = loadProject();
    if (!state.rows.length) return res.status(400).json({ error: "لا توجد صفوف بعد — استخرج المنتجات أولاً" });
    const cfg = parseFirstSku(firstSku);
    state.sku.raw = cfg.raw;
    state.sku.prefix = cfg.prefix;
    state.sku.width = cfg.width;
    state.sku.prefixSet = true;
    state.sku.assigned = false;
    assignSkus(state);
    addLog(state, "تم تخصيص الـ SKU بدءًا من " + cfg.raw + " لـ " + state.rows.length + " صف");
    saveProject(state);
    res.json({ ok: true, skus: state.rows.map((r) => r.sku), state: publicState(state) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/process/start", (req, res) => {
  try {
    const state = loadProject();
    if (status().active) return res.status(400).json({ error: "المعالجة تعمل بالفعل" });
    if (!state.sku.assigned) return res.status(400).json({ error: "اضبط الـ SKU أولاً" });
    if (!state.siteUrl) return res.status(400).json({ error: "أدخل رابط الموقع أولاً" });
    if (!state.rows.length) return res.status(400).json({ error: "لا توجد منتجات" });
    startProcessing(state);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/process/cancel", (req, res) => {
  cancelProcessing();
  res.json({ ok: true });
});

app.get("/api/process/status", (req, res) => {
  const state = loadProject();
  res.json({ ok: true, processing: status(), rows: state.rows.length });
});
// إعادة ضبط المشروع
app.post("/api/reset", (req, res) => {
  try {
    const fresh = resetFresh();
    saveProject(fresh);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function resetFresh() {
  const st = require("./lib/state");
  const blank = st.resetProject();
  blank.createdAt = new Date().toISOString();
  return blank;
}

app.post("/api/review", (req, res) => {
  try {
    const { rowId, updates } = req.body || {};
    const state = loadProject();
    const row = state.rows.find((r) => r.rowIndex === rowId);
    if (!row) return res.status(404).json({ error: "الصف غير موجود" });
    if (updates.product_name != null) row.product_name = String(updates.product_name);
    if (updates.price != null) row.price = Number(updates.price) || null;
    if (updates.currency != null) row.currency = String(updates.currency).toUpperCase();
    if (updates.description != null) row.description = String(updates.description);
    if (updates.image_url != null) row.image_url = String(updates.image_url);
    if (updates.product_url != null) row.product_url = String(updates.product_url);
    if (updates.status != null) {
      row.status = String(updates.status);
      if (updates.approve) row.reviewed = true;
    }
    saveProject(state);
    res.json({ ok: true, state: publicState(state) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/fetch-one", async (req, res) => {
  try {
    const { rowId, url } = req.body || {};
    if (!url) return res.status(400).json({ error: "أدخل رابط المنتج" });
    const state = loadProject();
    const row = state.rows.find((r) => r.rowIndex === rowId);
    if (!row) return res.status(404).json({ error: "الصف غير موجود" });
    const data = await fetchProductDetails(url);
    row.product_name = data.product_name || row.original_name;
    row.price = data.price;
    row.currency = data.currency;
    row.description = data.description;
    row.image_url = data.image_url_high || data.image_url || "";
    row.product_url = url;
    row.status = "matched";
    row.match_score = null;
    row.match_detail = "تم الجلب يدويًا";
    try {
      row.writeSku = state.writeSkuOnImage !== false; // نسخة مكتوب عليها SKU حسب الإعداد
      const saved = await saveRowImages(row, row.product_url);
      row.image_filename = saved.image_filename;
      row.image_labeled_file = saved.image_labeled_file;
    } catch (imgErr) {
      row.error = "فشل تنزيل الصورة: " + imgErr.message;
    }
    saveProject(state);
    res.json({ ok: true, row: publicRow(row) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* الصور */
app.get("/api/images", (req, res) => {
  const state = loadProject();
  res.json({
    ok: true,
    count: state.rows.filter((r) => r.image_filename).length,
    dirs: {
      originals: fs.existsSync(dirs().IMAGES_ORIGINAL_DIR) ? fs.readdirSync(dirs().IMAGES_ORIGINAL_DIR).length : 0,
      labeled: fs.existsSync(dirs().IMAGES_LABELED_DIR) ? fs.readdirSync(dirs().IMAGES_LABELED_DIR).length : 0,
    },
  });
});

app.use("/api/images/originals", express.static(dirs().IMAGES_ORIGINAL_DIR));
app.use("/api/images/labeled", express.static(dirs().IMAGES_LABELED_DIR));

/* التصدير */
app.post("/api/export/excel", (req, res) => {
  try {
    const state = loadProject();
    const check = preExportCheck(state);
    const result = exportExcel(state, req.body && req.body.fileName);
    res.json({ ok: true, name: result.name, urlPath: result.urlPath, check });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/export/zip", async (req, res) => {
  try {
    const state = loadProject();
    const { labeled } = req.body || {};
    const report = buildZipArchive(state, { writeImages: !!labeled });
    const zipPath = await report.promise;
    const base = path.basename(zipPath);
    res.json({ ok: true, name: base, urlPath: "/api/exports/" + encodeURIComponent(base), missing: report.missing });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.use("/api/exports", express.static(dirs().EXPORTS_DIR, { fallthrough: true }));

/* الحالة العامة */
app.get("/api/state", (req, res) => {
  res.json({ ok: true, state: publicState(loadProject()) });
});

function publicState(state) {
  return {
    brand: state.brand,
    siteUrl: state.siteUrl,
    sheet: state.sheet,
    duplicatesDetected: state.duplicatesDetected,
    sku: state.sku,
    currency: state.currency,
    writeSkuOnImage: state.writeSkuOnImage,
    rows: state.rows.map(publicRow),
    processing: state.processing,
    logs: (state.logs || []).slice(-200).map((l) => ({ ...l })),
  };
}

function publicRow(row) {
  return {
    rowIndex: row.rowIndex,
    sheetRow: row.sheetRow,
    original_name: row.original_name,
    product_name: row.product_name || "",
    sku: row.sku,
    price: row.price,
    currency: row.currency || "",
    description: row.description || "",
    image_url: row.image_url || "",
    image_filename: row.image_filename || "",
    image_labeled_file: row.image_labeled_file || "",
    product_url: row.product_url || "",
    status: row.status || "pending",
    reviewed: !!row.reviewed,
    match_score: row.match_score,
    match_detail: row.match_detail || "",
    candidates: (row.candidates || []).map((c) => ({
      url: c.url, title: c.title, image_url: c.image_url || "",
      price_text: c.price_text || "", score: c.score, detail: c.detail || "",
    })),
    error: row.error || "",
  };
}

/* الواجهة الأمامية */
const clientDir = path.join(__dirname, "client");
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

cleanupOldExports();
app.listen(PORT, () => {
  console.log("LYVO Product Importer يعمل على http://localhost:" + PORT);
});
