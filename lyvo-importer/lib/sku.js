/* ============================================================
 * توليد الـ SKU: بادئة + رقم متسلسل مع الحفاظ على عدد الأصفار
 * مثال: "LYVO-000100" → "LYVO-000100" ثم "LYVO-000101" ...
 * مثال: "10000" → "" → "10000" ثم "10001" ...
 * ============================================================ */

/**
 * يحلل أول SKU يدخله المستخدم.
 * يعيد { prefix, start, width } حيث:
 *  - prefix: الجزء غير الرقمي مثل "LYVO-"
 *  - start : الرقم الذي سيبدأ منه العد
 *  - width : عدد خانات الرقم مع الأصفار السابقة (من الرقم الأول)
 */
function parseFirstSku(input) {
  const raw = String(input == null ? "" : input).trim().toUpperCase();
  if (!raw) throw new Error("يرجى إدخال أول SKU (مثال: LYVO-000100 أو 10000)");

  const numMatch = raw.match(/^(.*?)(\d+)$/);
  if (!numMatch) {
    // لا يحتوي على أي رقم — نضيف لاحقة رقمية تلقائية
    throw new Error("أول SKU يجب أن يحتوي على رقم في نهايته، مثل: LYVO-000100 أو 10000");
  }

  const prefix = numMatch[1];
  const digits = numMatch[2];
  const width = digits.length;
  const start = parseInt(digits, 10);
  if (!Number.isFinite(start)) throw new Error("رقم غير صالح في أول SKU");

  return { prefix, start, width, raw };
}

/** يعيد SKU الصف المعطى مع تشكيل خانات الرقم حسب العرض المطلوب */
function skuForRow(skuCfg, rowIndex) {
  const number = skuCfg.start + rowIndex;
  const padded = String(number).padStart(Math.max(skuCfg.width, String(number).length), "0");
  return skuCfg.prefix + padded;
}

/** إعداد صفوف SKU لكل صفوف المشروع حسب ترتيب الإكسل — يُثبّت ولا يتغير لاحقًا */
function assignSkus(state) {
  const cfg = state.sku;
  if (!cfg || !cfg.prefixSet) throw new Error("لم يتم إعداد أول SKU بعد");
  cfg.nextNumber = cfg.start;
  for (const row of state.rows) {
    row.sku = skuForRow(cfg, row.rowIndex);
  }
  state.sku.assigned = true;
  state.sku.nextNumber = cfg.start + state.rows.length;
}

/** تنظيف قيمة SKU لتكون صالحة كاسم ملف */
function skuToFileName(sku) {
  return String(sku || "").replace(/[^A-Za-z0-9_-]/g, "_").trim() || "SKU";
}

module.exports = { parseFirstSku, skuForRow, assignSkus, skuToFileName };