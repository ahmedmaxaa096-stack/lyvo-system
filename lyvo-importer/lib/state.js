/* ============================================================
 * حالة المشروع: تحميل/حفظ مستمر للسماح بالاستكمال دون إعادة
 * المنتجات المكتملة. كل العمل يُحفظ في data/project.json
 * ============================================================ */

const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const UPLOADS_DIR = path.join(ROOT, "uploads");
const EXPORTS_DIR = path.join(ROOT, "exports");
const IMAGES_DIR = path.join(DATA_DIR, "images");
const IMAGES_ORIGINAL_DIR = path.join(IMAGES_DIR, "originals");
const IMAGES_LABELED_DIR = path.join(IMAGES_DIR, "labeled");
const PROJECT_FILE = path.join(DATA_DIR, "project.json");

function ensureDirs() {
  for (const d of [DATA_DIR, UPLOADS_DIR, EXPORTS_DIR, IMAGES_DIR, IMAGES_ORIGINAL_DIR, IMAGES_LABELED_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function blankProject() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    sheet: {
      fileName: "",
      sheetName: "",
      columnHeader: "",
      columnIndex: 0,
      hasHeader: true,
    },
    brand: "",
    siteUrl: "",
    currency: "",
    writeSkuOnImage: true,
    duplicatesDetected: [],
    sku: {
      raw: "",
      prefix: "",
      start: 0,
      width: 0,
      assigned: false,
      nextNumber: 0,
    },
    rows: [],
    processing: {
      active: false,
      cancel: false,
      currentIndex: -1,
      startedAt: null,
    },
    logs: [],
  };
}

function loadProject() {
  ensureDirs();
  if (fs.existsSync(PROJECT_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(PROJECT_FILE, "utf8"));
      if (data && Array.isArray(data.rows)) return data;
    } catch (e) {
      console.error("تعذّر قراءة project.json", e.message);
    }
  }
  return blankProject();
}

function saveProject(state) {
  ensureDirs();
  state.updatedAt = new Date().toISOString();
  state.logs = (state.logs || []).slice(-1000);
  fs.writeFileSync(PROJECT_FILE, JSON.stringify(state, null, 2), "utf8");
}

function resetProject() {
  ensureDirs();
  for (const d of [EXPORTS_DIR, IMAGES_DIR]) {
    try {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    } catch (e) { /* ignore */ }
  }
  ensureDirs();
  try {
    const up = path.join(UPLOADS_DIR, "input.xlsx");
    if (fs.existsSync(up)) fs.unlinkSync(up);
  } catch (e) { /* ignore */ }
  return blankProject();
}

/** إضافة سطر لسجل العمليات */
function addLog(state, message, level = "info") {
  const entry = {
    t: new Date().toISOString(),
    level,
    msg: String(message),
  };
  state.logs = state.logs || [];
  state.logs.push(entry);
  if (state.logs.length > 1200) state.logs.splice(0, state.logs.length - 1200);
  const ts = new Date(entry.t).toLocaleTimeString("en-GB");
  const prefix = level === "error" ? "✗" : level === "warn" ? "⚠" : "●";
  console.log(`[${ts}] ${prefix} ${entry.msg}`);
  return entry;
}

function dirs() {
  return {
    ROOT, DATA_DIR, UPLOADS_DIR, EXPORTS_DIR, IMAGES_DIR,
    IMAGES_ORIGINAL_DIR, IMAGES_LABELED_DIR, PROJECT_FILE,
  };
}

module.exports = { ensureDirs, blankProject, loadProject, saveProject, addLog, resetProject, dirs };