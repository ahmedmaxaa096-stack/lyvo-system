/* ============================================================
 * قراءة ملف Excel: سرد الشيتات والأعمدة ثم استخراج أسماء
 * المنتجات مع الكشف عن الأسماء المكررة
 * ============================================================ */

const XLSX = require("xlsx");
const { normalizeKey } = require("./normalize");

function cellText(v) {
  if (v == null) return "";
  if (typeof v === "object") {
    if (v.t === "n") return String(v.v);
    if (v.h || v.w) return String(v.h || v.w);
    if (v.v != null) return String(v.v);
    return "";
  }
  return String(v).trim();
}

/** تفقد ملف: الشيتات وأعمدة أول صف به بيانات */
function inspectFile(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const sheets = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
    const columns = [];
    const maxCols = Math.max(0, ...rows.map((r) => r.length));
    for (let c = 0; c < maxCols; c++) {
      let header = cellText(rows[0] ? rows[0][c] : "");
      if (!header) {
        // تحقق من وجود أي بيانات في هذا العمود أسفل الصف الأول
        let hasData = false;
        for (let r = 1; r < Math.min(rows.length, 15); r++) {
          if (cellText(rows[r] && rows[r][c])) { hasData = true; break; }
        }
        if (!hasData) continue;
        header = `عمود ${c + 1}`;
      }
      columns.push({ index: c, header });
    }
    sheets.push({ name, rowCount: rows.length, columns: columns.slice(0, 50) });
  }
  return sheets;
}

/**
 * استخراج عمود الأسماء من الشيت المختار.
 * hasHeader: هل الصف الأول هو الترويسة؟
 * يعيد { rows, duplicates }
 */
function extractColumn(filePath, sheetName, columnIndex, hasHeader = true) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  if (!wb.SheetNames.includes(sheetName)) throw new Error(`الشيت «${sheetName}» غير موجود`);
  const ws = wb.Sheets[sheetName];
  const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

  const rows = [];
  for (let r = 0; r < allRows.length; r++) {
    if (hasHeader && r === 0) continue; // تخطي الترويسة
    const value = cellText(allRows[r] && allRows[r][columnIndex]);
    if (!value) continue;
    rows.push({ sheetRow: hasHeader ? r + 2 : r + 1, name: value });
  }

  // كشف الأسماء المكررة
  const counts = new Map();
  for (const { name } of rows) {
    const k = normalizeKey(name).replace(/\s+/g, "");
    if (!k) continue;
    const entry = counts.get(k) || { name, count: 0, rows: [] };
    entry.count++;
    counts.set(k, entry);
  }
  const duplicates = [...counts.values()].filter((e) => e.count > 1);

  return { rows, duplicates };
}

module.exports = { inspectFile, extractColumn };