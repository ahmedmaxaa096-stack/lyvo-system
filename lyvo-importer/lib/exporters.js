/* ============================================================
 * التصدير:
 *  1) Excel بالأعمدة المطلوبة
 *  2) ZIP للصور مع فصلها في مجلدين (originals / labeled)
 *  3) تحقق قبل التصدير: تطابق SKU ↔ اسم الصورة
 * ============================================================ */

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const archiver = require("archiver");
const { dirs } = require("./state");
const { skuToFileName } = require("./sku");

function verifyImages(state) {
  const d = dirs();
  const issues = [];
  const matched = [];
  fs.mkdirSync(d.IMAGES_ORIGINAL_DIR, { recursive: true });
  fs.mkdirSync(d.IMAGES_LABELED_DIR, { recursive: true });

  const originalFiles = new Set(fs.readdirSync(d.IMAGES_ORIGINAL_DIR));
  const labeledFiles = new Set(fs.readdirSync(d.IMAGES_LABELED_DIR));

  for (const row of state.rows) {
    const skuFile = skuToFileName(row.sku) + ".jpg";
    if (row.status === "matched") {
      const hasOrig = originalFiles.has(skuFile);
      const hasLabeled = !state.writeSkuOnImage || labeledFiles.has(skuFile);
      if (!hasOrig) issues.push({ sku: row.sku, name: row.original_name, problem: "الصورة الأصلية مفقودة" });
      if (!hasLabeled) issues.push({ sku: row.sku, name: row.original_name, problem: "الصورة المكتوب عليها SKU مفقودة" });
      if (row.image_filename && row.image_filename !== skuFile) {
        issues.push({ sku: row.sku, name: row.original_name, problem: "اسم الصورة لا يطابق SKU" });
      }
      if (hasOrig && hasLabeled) matched.push(row);
    }
  }
  return { issues, matchedCount: matched.length, originalFiles, labeledFiles };
}

function preExportCheck(state) {
  const report = verifyImages(state);
  return {
    ok: report.issues.length === 0,
    issues: report.issues,
    matchedCount: report.matchedCount,
    rowCount: state.rows.length,
  };
}

function exportStatus(row) {
  if (row.status === "matched") return "matched";
  if (row.status === "review") return "review";
  if (row.status === "not_found") return "not_found";
  if (row.status === "fetch_failed") return "fetch_failed";
  return "pending";
}

function buildExcelBuffer(state) {
  const rows = state.rows.map((row) => ({
    original_name: row.original_name,
    product_name: row.product_name || "",
    sku: row.sku,
    price: row.price == null ? "" : row.price,
    currency: row.currency || state.currency || "",
    description: row.description || "",
    image_filename: row.image_filename || "",
    image_url: row.image_url || "",
    product_url: row.product_url || "",
    status: exportStatus(row),
  }));

  const ws = XLSX.utils.json_to_sheet(rows, {
    header: [
      "original_name", "product_name", "sku", "price", "currency",
      "description", "image_filename", "image_url", "product_url", "status",
    ],
  });
  ws["!cols"] = [
    { wch: 30 }, { wch: 40 }, { wch: 18 }, { wch: 12 }, { wch: 10 },
    { wch: 50 }, { wch: 22 }, { wch: 45 }, { wch: 45 }, { wch: 15 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "products");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function exportExcel(state, fileName) {
  const buffer = buildExcelBuffer(state);
  const d = dirs();
  fs.mkdirSync(d.EXPORTS_DIR, { recursive: true });
  const base = (fileName || "LYVO-products-" + new Date().toISOString().slice(0, 10))
    .replace(/\.xlsx$/i, "") + ".xlsx";
  const out = path.join(d.EXPORTS_DIR, base);
  fs.writeFileSync(out, buffer);
  return { ok: true, name: base, urlPath: "/api/exports/" + encodeURIComponent(base) };
}

function buildZipArchive(state, options) {
  const d = dirs();
  fs.mkdirSync(d.EXPORTS_DIR, { recursive: true });
  const includeLabeled = !!(options && (options.labeled === true || options.writeImages === true));
  const stamp = new Date().toISOString().slice(0, 10);
  const zipName = includeLabeled
    ? "LYVO-images-labeled-" + stamp + ".zip"
    : "LYVO-images-" + stamp + ".zip";
  const zipPath = path.join(d.EXPORTS_DIR, zipName);

  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 6 } });
  const done = new Promise((resolve, reject) => {
    output.on("close", () => resolve(zipPath));
    output.on("error", reject);
    archive.on("error", reject);
  });
  archive.pipe(output);

  const missing = [];
  for (const row of state.rows) {
    const skuFile = skuToFileName(row.sku) + ".jpg";
    const origPath = path.join(d.IMAGES_ORIGINAL_DIR, skuFile);
    if (fs.existsSync(origPath)) {
      archive.file(origPath, { name: "originals/" + skuFile });
    } else {
      missing.push("originals/" + skuFile);
    }
    if (includeLabeled) {
      const labPath = path.join(d.IMAGES_LABELED_DIR, skuFile);
      if (fs.existsSync(labPath)) {
        archive.file(labPath, { name: "labeled/" + skuFile });
      } else {
        missing.push("labeled/" + skuFile);
      }
    }
  }
  archive.finalize();
  return { promise: done, zipPath, zipName, missing };
}

function cleanupOldExports() {
  const d = dirs();
  try {
    for (const f of fs.readdirSync(d.EXPORTS_DIR)) {
      if (/\.(zip|xlsx)$/i.test(f)) {
        const st = fs.statSync(path.join(d.EXPORTS_DIR, f));
        if (Date.now() - st.mtimeMs > 48 * 3600000) fs.unlinkSync(path.join(d.EXPORTS_DIR, f));
      }
    }
  } catch (e) { /* ignore */ }
}

module.exports = {
  verifyImages,
  preExportCheck,
  buildExcelBuffer,
  exportExcel,
  buildZipArchive,
  cleanupOldExports,
};
