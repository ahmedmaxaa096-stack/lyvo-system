/* LYVO Product Importer — منطق الواجهة (client) */
"use strict";

const API = {
  get: async (p) => {
    const r = await fetch("/api/" + p, { cache: "no-store" });
    return r.json();
  },
  post: async (p, body, isForm) => {
    const opts = { method: "POST", cache: "no-store" };
    if (isForm) {
      opts.body = body;
    } else {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body || {});
    }
    const r = await fetch("/api/" + p, opts);
    return r.json();
  },
};

const $ = (id) => document.getElementById(id);
let STATE = { rows: [], sheet: {}, sku: {}, logs: [], duplicatesDetected: [] };
let slidesInit = false;

function setError(msg) {
  const b = $("errorBox");
  if (!msg) { b.style.display = "none"; return; }
  b.textContent = msg;
  b.style.display = "block";
}
function setSuccess(msg) {
  const b = $("successBox");
  if (!msg) { b.style.display = "none"; return; }
  b.textContent = msg;
  b.style.display = "block";
  setTimeout(() => (b.style.display = "none"), 3200);
}

const SLIDES = [
  { id: 1, label: "الإعدادات", icon: "⚙️" },
  { id: 2, label: "الأسماء", icon: "📋" },
  { id: 3, label: "المعالجة", icon: "🔎" },
  { id: 4, label: "المراجعة", icon: "✅" },
  { id: 5, label: "الصور", icon: "🖼️" },
  { id: 6, label: "التصدير", icon: "📦" },
];
let currentSlide = 1;

function renderNav() {
  const nav = $("slideNav");
  if (slidesInit) return;
  nav.innerHTML = "";
  for (const s of SLIDES) {
    const el = document.createElement("button");
    el.className = "slide-dot";
    el.dataset.slide = s.id;
    el.innerHTML = `<span>${s.icon}</span><small>${s.label}</small>`;
    el.addEventListener("click", () => goSlide(s.id));
    nav.appendChild(el);
  }
  slidesInit = true;
}

function goSlide(n) {
  currentSlide = Math.max(1, Math.min(6, n));
  document.querySelectorAll(".slide").forEach((el) => (el.classList.remove("active")));
  const sec = $("slide-" + currentSlide);
  if (sec) sec.classList.add("active");
  document.querySelectorAll(".slide-dot").forEach((el) => {
    const id = parseInt(el.dataset.slide, 10);
    el.classList.toggle("active", id === currentSlide);
    const row = STATE.rows[id - 1];
    el.classList.toggle("done", !!row && (row.status === "matched" || row.reviewed));
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (currentSlide === 4) renderReview();
  if (currentSlide === 5) renderImages();
  if (currentSlide === 6) renderExportCheck();
}

function badgeFor(status) {
  const map = {
    matched: ["مطابق", "matched"],
    review: ["يحتاج مراجعة", "review"],
    not_found: ["غير موجود", "not_found"],
    fetch_failed: ["تعذر الجلب", "fetch_failed"],
    pending: ["بانتظار", "pending"],
    processing: ["جاري المعالجة", "pending"],
  };
  const [txt, cls] = map[status] || map.pending;
  return `<span class="badge ${cls}">${txt}</span>`;
}

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function money(v) {
  if (v == null || v === "") return "—";
  return Number(v).toLocaleString("en-US");
}
/* ---------- تحميل الحالة ---------- */
async function loadState() {
  try {
    const res = await API.get("state");
    if (res.ok && res.state) STATE = res.state;
  } catch (e) { /* الخادم متوقف — نتعامل لاحقًا */ }
  return STATE;
}

function fillSettings() {
  if (STATE.brand) $("brandInput").value = STATE.brand;
  if (STATE.siteUrl) $("siteInput").value = STATE.siteUrl;
  if (STATE.currency) $("currencyInput").value = STATE.currency;
  if (STATE.sku && STATE.sku.raw) $("skuInput").value = STATE.sku.raw;
  $("writeSkuToggle").checked = STATE.writeSkuOnImage !== false;
}

/* ---------- رفع الإكسل + عرض الشيتات ---------- */
async function handleUpload() {
  const file = $("excelFile").files[0];
  if (!file) return setError("اختر ملف إكسل أولاً");
  setError(null);
  const form = new FormData();
  form.append("file", file);
  const res = await API.post("upload", form, true);
  if (!res.ok) return setError(res.error || "فشل رفع الملف");
  setSuccess("تم رفع الملف: " + file.name);
  const sheets = res.sheets || [];
  const shell = $("sheetSelects");
  if (!sheets.length) { shell.innerHTML = '<p class="empty">لا توجد شيتات في الملف</p>'; return; }
  shell.innerHTML = `
    <div>
      <label>الشيت</label>
      <select id="sheetSelect">${sheets.map((s, i) =>
        `<option value="${esc(s.name)}" ${i === 0 ? "selected" : ""}>${esc(s.name)} (${s.rowCount} صف)</option>`
      ).join("")}</select>
    </div>
    <div>
      <label>عمود اسم المنتج</label>
      <select id="columnSelect">${sheets[0].columns.map((c) =>
        `<option value="${c.index}">${esc(c.header)}</option>`
      ).join("")}</select>
    </div>
    <div style="grid-column:1/-1">
      <label style="display:flex;align-items:center;gap:8px;margin-top:2px">
        <input type="checkbox" id="hasHeaderToggle" checked style="width:18px;height:18px;accent-color:var(--primary)" />
        الصف الأول هو عناوين الأعمدة (يُتخطى أثناء الاستخراج)
      </label>
    </div>`;
  $("sheetSelect").addEventListener("change", () => updateColumns(sheets));
  goSlide(2);
}

function updateColumns(sheets) {
  const name = $("sheetSelect").value;
  const sheet = sheets.find((s) => s.name === name);
  if (!sheet) return;
  const colSel = $("columnSelect");
  colSel.innerHTML = sheet.columns.map((c) =>
    `<option value="${c.index}">${esc(c.header)}</option>`).join("");
}

/* ---------- استخراج الأسماء ---------- */
async function handleExtract() {
  const sheetName = $("sheetSelect").value;
  const columnIndex = parseInt($("columnSelect").value, 10);
  const hasHeader = $("hasHeaderToggle").checked;
  if (sheetName == null || Number.isNaN(columnIndex)) return setError("اختر الشيت والعمود أولاً");
  $("extractBtn").disabled = true;
  $("extractStatus").textContent = "جارٍ الاستخراج...";
  try {
    const res = await API.post("extract", { sheetName, columnIndex, hasHeader });
    if (!res.ok) return setError(res.error || "فشل الاستخراج");
    STATE = res.state || STATE;
    setSuccess(`تم استخراج ${res.count} اسم`);
    renderDuplicates();
    renderRowsPreview();
  } catch (e) {
    setError(e.message);
  } finally {
    $("extractBtn").disabled = false;
    $("extractStatus").textContent = "";
  }
}

function renderDuplicates() {
  const box = $("duplicatesBox");
  const list = $("duplicatesList");
  const dups = STATE.duplicatesDetected || [];
  if (!dups.length) { box.style.display = "none"; return; }
  list.innerHTML = dups.map((d) => `<div>• ${esc(d)}</div>`).join("");
  box.style.display = "block";
}

function renderRowsPreview() {
  const rows = STATE.rows || [];
  const box = $("rowsPreview");
  if (!rows.length) { box.innerHTML = ""; return; }
  box.innerHTML = `
    <div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:8px">تم تجهيز ${rows.length} منتج:</div>
    <div style="max-height:280px;overflow-y:auto">
      <table>
        <thead><tr><th>#</th><th>الاسم من الإكسل</th><th>SKU</th><th>الحالة</th></tr></thead>
        <tbody>
          ${rows.slice(0, 100).map((r, i) => `<tr>
            <td>${i + 1}</td><td>${esc(r.original_name)}</td><td dir="ltr">${esc(r.sku)}</td>
            <td>${badgeFor(r.status)}</td></tr>`).join("")}
        </tbody>
      </table>
      ${rows.length > 100 ? `<div class="empty">... و ${rows.length - 100} آخرون — انظر في المراجعة</div>` : ""}
    </div>`;
}
/* ---------- المعالجة ---------- */
let pollTimer = null;
let processingStarted = false;

async function startProcessing() {
  setError(null);
  const res = await API.post("process/start", {});
  if (!res.ok) return setError(res.error || "تعذر بدء المعالجة");
  setSuccess("بدأت المعالجة — يمكنك متابعة التقدم هنا أو التنقل بين الأقسام");
  processingStarted = true;
  if (currentSlide !== 3) goSlide(3);
  startPolling();
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const res = await API.get("process/status");
      if (res.ok) {
        renderProcessStatus(res.processing, res.rows);
        if (!res.processing.active && res.processing.done >= res.processing.total && processingStarted) {
          processingStarted = false;
          stopPolling();
          await loadState();
          renderAll();
        }
      }
    } catch (e) { /* الخادم غير متاح مؤقتًا */ }
  }, 1200);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function renderProcessStatus(p, total) {
  const fill = $("processFill");
  const label = $("processLabel");
  const statsBox = $("processStats");
  if (!p) { fill.style.width = "0%"; label.textContent = "—"; return; }
  const pct = total ? Math.round((p.done / total) * 100) : 0;
  fill.style.width = pct + "%";
  label.textContent = p.active
    ? `جارٍ المعالجة: ${p.done}/${total} · ${esc(p.currentName || "")}`
    : `اكتملت: ${p.done}/${total}`;
  statsBox.innerHTML = `
    <div class="stat"><div class="num green">${p.matched}</div><div class="lbl">مطابق ✅</div></div>
    <div class="stat"><div class="num amber">${p.review}</div><div class="lbl">يحتاج مراجعة</div></div>
    <div class="stat"><div class="num gray">${p.notFound}</div><div class="lbl">غير موجود</div></div>
    <div class="stat"><div class="num red">${p.failed}</div><div class="lbl">تعذر الجلب</div></div>
    <div class="stat"><div class="num">${p.done}</div><div class="lbl">المكتمل</div></div>`;
}

async function renderLogs() {
  const box = $("logBox");
  const logs = STATE.logs || [];
  box.innerHTML = logs.slice(-120).map((l) =>
    `<span class="log-line" data-level="${l.level}">${esc(l.msg)}</span>`).join("");
  box.scrollTop = box.scrollHeight;
}

function renderAll() {
  renderNav();
  renderRowsPreview();
  renderDuplicates();
  renderLogs();
  renderReview();
  renderImages();
  renderExportCheck();
}
/* ---------- المراجعة ---------- */
function renderReview() {
  const rows = STATE.rows || [];
  const statsBox = $("reviewStats");
  const matched = rows.filter((r) => r.status === "matched" || r.reviewed);
  const review = rows.filter((r) => r.status === "review");
  const notFound = rows.filter((r) => r.status === "not_found");
  const failed = rows.filter((r) => r.status === "fetch_failed" || (r.error && r.status !== "matched"));
  statsBox.innerHTML = `
    <div class="stat"><div class="num green">${matched.length}</div><div class="lbl">مطابق / معتمد</div></div>
    <div class="stat"><div class="num amber">${review.length}</div><div class="lbl">يحتاج مراجعة</div></div>
    <div class="stat"><div class="num gray">${notFound.length}</div><div class="lbl">غير موجود</div></div>
    <div class="stat"><div class="num red">${failed.length}</div><div class="lbl">تعذر الجلب</div></div>`;

  if (!rows.length) { $("reviewTable").innerHTML = '<p class="empty">لا توجد منتجات بعد — ابدأ من القسم الأول</p>'; return; }

  $("reviewTable").innerHTML = `
    <div style="max-height:560px;overflow:auto">
    <table>
      <thead><tr>
        <th>الاسم الأصلي</th><th>الاسم من الموقع</th><th>SKU</th><th>السعر</th><th>العملة</th>
        <th>الوصف</th><th>الصورة</th><th>رابط المنتج</th><th>الحالة</th><th>إجراءات</th>
      </tr></thead>
      <tbody>
        ${rows.map((r, i) => reviewRowHtml(r, i)).join("")}
      </tbody>
    </table></div>`;
}

function reviewRowHtml(r, i) {
  const img = r.image_url
    ? `<img class="img-thumb" src="/api/images/originals/${esc(r.image_filename || "")}" onerror="this.style.display='none'" alt="" style="${r.image_filename ? "" : "display:none"}"/>`
    : "";
  const candidates = (r.candidates || []).slice(0, 5);
  return `<tr id="row-${r.rowIndex}" data-idx="${i}">
    <td><strong>${esc(r.original_name)}</strong></td>
    <td>
      <input value="${esc(r.product_name)}" data-field="product_name" data-row="${r.rowIndex}" style="min-width:150px" />
      ${candidates.length ? candidatePicker(r) : ""}
    </td>
    <td dir="ltr">${esc(r.sku)}</td>
    <td><input value="${r.price == null ? "" : r.price}" data-field="price" data-row="${r.rowIndex}" style="width:80px" dir="ltr" /></td>
    <td><input value="${esc(r.currency)}" data-field="currency" data-row="${r.rowIndex}" style="width:64px" dir="ltr" /></td>
    <td><textarea data-field="description" data-row="${r.rowIndex}" rows="2" style="min-width:200px">${esc(r.description)}</textarea></td>
    <td>
      ${img}
      <input value="${esc(r.image_url)}" data-field="image_url" data-row="${r.rowIndex}" placeholder="رابط الصورة" style="min-width:150px;margin-top:4px" dir="ltr" />
    </td>
    <td><input value="${esc(r.product_url)}" data-field="product_url" data-row="${r.rowIndex}" placeholder="رابط المنتج" style="min-width:180px" dir="ltr" /></td>
    <td>${badgeFor(r.status)}${r.error ? `<div style="font-size:11px;color:#ff9999;margin-top:2px">${esc(r.error)}</div>` : ""}</td>
    <td>
      <div class="row-actions">
        <button class="small-btn" onclick="saveReviewRow(${r.rowIndex})">💾 حفظ</button>
        <button class="small-btn" onclick="approveReviewRow(${r.rowIndex})">✅ اعتماد</button>
        <button class="small-btn" onclick="manualFetch(${r.rowIndex})">🔗 جلب يدوي</button>
      </div>
      <input placeholder="رابط لجلبه يدويًا" data-field="manual_url" data-row="${r.rowIndex}" style="width:160px;margin-top:6px" dir="ltr" />
    </td>
  </tr>`;
}

function candidatePicker(r) {
  const cands = (r.candidates || []).slice(0, 5);
  return `<div style="margin-top:6px" class="candidate-list" data-row="${r.rowIndex}">
    ${cands.map((c, i) => `
      <label style="display:flex;gap:8px;align-items:flex-start;font-weight:400;font-size:11px;line-height:1.5;margin:4px 0">
        <input type="radio" name="cand-${r.rowIndex}" value="${esc(c.url)}" ${i === 0 ? "checked" : ""} style="width:14px;height:14px" data-url="${esc(c.url)}" />
        <span>${esc(c.title)}<br/><span style="color:var(--muted)">تطابق ${Math.round((c.score || 0) * 100)}% · ${esc(c.detail || "")}</span></span>
      </label>`).join("")}
  </div>`;
}

async function saveReviewRow(rowIndex) {
  const tr = document.getElementById("row-" + rowIndex);
  if (!tr) return;
  const updates = {};
  tr.querySelectorAll("[data-row]").forEach((el) => {
    if (el.dataset.field && el.value !== undefined) updates[el.dataset.field] = el.value;
  });
  // الصورة المختارة من المرشحين إن وُجدت
  const radio = tr.querySelector('input[type="radio"][data-url]:checked');
  if (radio && !updates.product_url) updates.product_url = radio.dataset.url;
  const res = await API.post("review", { rowId: rowIndex, updates });
  if (!res.ok) return setError(res.error || "فشل الحفظ");
  STATE = res.state || STATE;
  setSuccess("تم حفظ تعديلات الصف");
  renderReview();
}

async function approveReviewRow(rowIndex) {
  const res = await API.post("review", { rowId: rowIndex, updates: { status: "matched", approve: true } });
  if (!res.ok) return setError(res.error || "فشل الاعتماد");
  STATE = res.state || STATE;
  setSuccess("تم اعتماد المنتج");
  renderAll();
}

async function manualFetch(rowIndex) {
  const tr = document.getElementById("row-" + rowIndex);
  const url = tr.querySelector('[data-field="manual_url"]').value.trim();
  if (!url) return setError("أدخل رابط المنتج في حقل «رابط لجلبه يدويًا»");
  setError(null);
  const res = await API.post("fetch-one", { rowId: rowIndex, url });
  if (!res.ok) return setError(res.error || "تعذر جلب الرابط");
  await loadState();
  setSuccess("تم جلب المنتج وتنزيل صورته");
  renderAll();
}
/* ---------- الصور ---------- */
async function renderImages() {
  const res = await API.get("images");
  const info = res.dirs || {};
  $("imageStats").innerHTML = `
    <div class="stat"><div class="num">${info.originals || 0}</div><div class="lbl">صور أصلية</div></div>
    <div class="stat"><div class="num">${info.labeled || 0}</div><div class="lbl">صور مكتوب عليها SKU</div></div>
    <div class="stat"><div class="num">${res.count || 0}</div><div class="lbl">منتجات لها صورة</div></div>`;
  const rows = (STATE.rows || []).filter((r) => r.image_filename);
  if (!rows.length) {
    $("imagePreview").innerHTML = '<p class="empty">لا توجد صور بعد — أكمل المعالجة أو اعتمد منتجات من المراجعة.</p>';
    return;
  }
  $("imagePreview").innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px">
    ${rows.map((r) => `
      <div style="text-align:center">
        <img class="img-thumb" src="/api/images/originals/${esc(r.image_filename)}" title="الأصلية" />
        <div style="font-size:11px;color:var(--muted);margin-top:4px" dir="ltr">${esc(r.sku)}</div>
      </div>`).join("")}
  </div>`;
}

/* ---------- التصدير ---------- */
async function renderExportCheck() {
  const box = $("exportCheck");
  const rows = STATE.rows || [];
  if (!rows.length) { box.style.display = "none"; return; }
  box.innerHTML = `<div style="font-size:13px;color:var(--muted)">
    ${rows.filter((r) => r.status === "matched").length} من ${rows.length} منتج مطابق له صورة. استخدم أزرار التصدير أدناه.
  </div>`;
  box.style.display = "block";
}

async function exportExcel() {
  setError(null);
  $("exportExcelBtn").disabled = true;
  try {
    const res = await API.post("export/excel", {});
    if (!res.ok) return setError(res.error || "فشل تصدير Excel");
    const box = $("exportResult");
    box.innerHTML = `تم إنشاء <strong>${esc(res.name)}</strong><br/>
      ${res.check && res.check.issues && res.check.issues.length
        ? `<span style="color:#ffd166">⚠ ${res.check.issues.length} مشكلة في الصور (انظر أدناه)</span>`
        : "<span style=\"color:#a5f0c5\">✓ جميع صور SKU مطابقة وحاضرة</span>"}
      <br/><a href="${esc(res.urlPath)}" download style="font-weight:700;color:#fff">⬇ تحميل الملف</a>`;
    box.style.display = "block";
    renderExportCheck();
  } catch (e) { setError(e.message); }
  finally { $("exportExcelBtn").disabled = false; }
}

async function exportZip(labelNames) {
  setError(null);
  const btnId = labelNames ? "exportZipLabeledBtn" : "exportZipBtn";
  $("exportZipBtn").disabled = true;
  $("exportZipLabeledBtn").disabled = true;
  try {
    const res = await API.post("export/zip", { labeled: !!labelNames });
    if (!res.ok) return setError(res.error || "فشل تصدير ZIP");
    const box = $("exportResult");
    box.innerHTML = `تم تجهيز <strong>${esc(res.name)}</strong><br/>
      ${res.missing && res.missing.length
        ? `<span style="color:#ffd166">⚠ فشل ${res.missing.length} ملف في التصدير (صور مفقودة)</span>`
        : "<span style=\"color:#a5f0c0\">✓ كل الصور موجودة في الملف</span>"}<br/>
      <a href="${esc(res.urlPath)}" download style="font-weight:700;color:#fff">⬇ تحميل ZIP</a>`;
    box.style.display = "block";
  } catch (e) { setError(e.message); }
  finally { $("exportZipBtn").disabled = false; $("exportZipLabeledBtn").disabled = false; }
}

function renderExportReport() {
  renderExportCheck();
}

/* ---------- الإعدادات + SKU ---------- */
async function applySettings() {
  setError(null);
  const body = {
    brand: $("brandInput").value,
    siteUrl: $("siteInput").value,
    currency: $("currencyInput").value,
    writeSkuOnImage: $("writeSkuToggle").checked,
  };
  const res = await API.post("settings", body);
  if (!res.ok) return setError(res.error || "فشل حفظ الإعدادات");
  STATE = res.state || STATE;
  setSuccess("حُفظت الإعدادات");
}

async function applySku() {
  setError(null);
  const firstSku = $("skuInput").value.trim();
  if (!STATE.rows.length) return setError("استخرج أسماء المنتجات أولًا من القسم الثاني");
  const res = await API.post("sku", { firstSku });
  if (!res.ok) return setError(res.error || "تعذر تخصيص الـ SKU");
  STATE = res.state || STATE;
  setSuccess(`تم تخصيص الـ SKU: ${res.skus.slice(0, 3).join("، ")} …`);
  renderRowsPreview();
}

async function resetProject() {
  if (!confirm("سيتم مسح كل البيانات والصور والتصديرات. متأكد؟")) return;
  const res = await API.post("reset", {});
  if (!res.ok) return setError(res.error);
  await loadState();
  setSuccess("بدأت مشروعًا جديدًا");
  renderAll();
}

/* ---------- التهيئة ---------- */
function bind() {
  $("excelFile").addEventListener("change", handleUpload);
  $("applySettingsBtn").addEventListener("click", applySettings);
  $("skuInput").addEventListener("change", () => { if (STATE.rows.length) applySku(); });
  $("extractBtn").addEventListener("click", handleExtract);
  $("startProcessBtn").addEventListener("click", startProcessing);
  $("cancelProcessBtn").addEventListener("click", async () => { await API.post("process/cancel", {}); });
  $("resetBtn").addEventListener("click", resetProject);
  $("exportExcelBtn").addEventListener("click", exportExcel);
  $("exportZipBtn").addEventListener("click", () => exportZip(false));
  $("exportZipLabeledBtn").addEventListener("click", () => exportZip(true));
  renderNav();
}

async function init() {
  await loadState();
  fillSettings();
  bind();
  renderNav();
  renderAll();
  const ref = await API.get("process/status");
  if (ref.ok && ref.processing && ref.processing.done < ref.processing.total && ref.processing.active) {
    processingStarted = true;
    startPolling();
  }
  goSlide(1);
}

init();