/* ============================================================
 * تطبيع النصوص + استخراج صفات المنتج:
 * الحجم، اللون، الموديل، عدد القطع في العبوة
 * ============================================================ */

const AR_DIACRITICS = /[\u064B-\u065F\u0670\u0640]/g;
const AR_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;
const PUNCT = /[-–—_/\\,()\[\]{}.:;|!?«»"'+*#~=<>^@$&%]/g;
const STOP = new Set(["for", "with", "and", "the", "a", "an", "no", "of", "new", "by", "in", "on", "at", "to", "from", "size", "model", "bottle", "bottles"]);

/** تحويل الأرقام العربية/الفارسية إلى لاتينية */
function toLatinDigits(s) {
  return s
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));
}

/** مفتاح بحث موحّد */
function normalizeKey(text) {
  if (text == null) return "";
  let s = String(text)
    .replace(AR_DIACRITICS, "")
    .replace(PUNCT, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return toLatinDigits(s);
}

const COLOR_WORDS = [
  ["black", "black|اسود|أسود|negro|noir"],
  ["white", "white|أبيض|ابيض|blanc"],
  ["red", "red|أحمر|احمر|rouge"],
  ["blue", "blue|أزرق|ازرق|bleu|navy|كحلي"],
  ["green", "green|أخضر|اخضر|vert"],
  ["yellow", "yellow|أصفر|اصفر|jaune"],
  ["gold", "gold|ذهبي|ذهب|doré|dore"],
  ["silver", "silver|فضي|فضة|argent"],
  ["gray", "gray|grey|رمادي|رمادى"],
  ["brown", "brown|بني|marron"],
  ["beige", "beige|بيج|بيژ|ecru"],
  ["pink", "pink|وردي|وردى|rose"],
  ["purple", "purple|violet|بنفسجي|بنفسجى|بنفسج"],
  ["orange", "orange|برتقالي|برتقالى"],
  ["cream", "cream|كريمي|كريمى"],
  ["bronze", "bronze|برونزي|برونزى"],
  ["copper", "copper|نحاسي|نحاسى"],
  ["multicolor", "multicolor|متعدد|الوان|ألوان"],
  ["clear", "clear|شفاف"],
  ["rosegold", "rosegold|وردي ذهبي|ذهبى وردى"],
  ["emerald", "emerald|زمردي|زمردى"],
  ["olive", "olive|زيتوني|زيتونى"],
  ["turquoise", "turquoise|فيروزي|فيروزى"],
  ["camel", "camel|جمل|بيج بنى"],
  ["champagne", "champagne|شمبانيا"],
  ["lilac", "lilac|ليلك"],
  ["coral", "coral|مرجاني|مرجانى"],
  ["ivory", "ivory|عاجي|عاجى"],
];

/** استخراج الصفات من النص — تُرجع مفاتيح مطبّعة */
function extractAttributes(text) {
  const lower = String(text || "").toLowerCase();
  const attrs = { size: [], color: [], model: [], pack: [], sizeRaw: [], colorRaw: [] };

  // الحجم: رقم + وحدة (مل، جرام، عدد...)
  const sizeRx = /\b(\d+(?:[.,]\d+)?)\s*(ml|cl|l(?:tr)?|kg|mg|g|oz|fl\s?oz|pcs|pc|ct|count|capsules|caps|tablets|sheets|pairs?|pack|pieces?|units?|ea|sachets?|w)\b/gi;
  let m;
  while ((m = sizeRx.exec(lower))) {
    if (!attrs.sizeRaw.includes(m[0].toLowerCase())) {
      attrs.size.push(m[1].replace(",", ".") + m[2].toLowerCase().replace(/\s+/g, ""));
      attrs.sizeRaw.push(m[0].toLowerCase());
    }
  }
  // مقاسات الملابس S/M/L/XL
  const letters = lower.match(/\b(?:xs|s|m|l|xl|xxl|xxxl|free|one\s?size)\b/g);
  if (letters) attrs.size.push(...letters.map((x) => x.toLowerCase()));

  // الألوان
  for (const [canonical, pattern] of COLOR_WORDS) {
    const found = pattern.split("|").find((w) => w && new RegExp(`(^|[^a-zا-ي0-9])${w}([^a-zا-ي0-9]|$)`, "i").test(lower));
    if (found) {
      attrs.color.push(canonical);
      attrs.colorRaw.push(found);
    }
  }

  // الموديل / الكود
  const modelMatches = lower.match(/[A-Za-z]{1,5}[-]?\d{2,}[A-Za-z0-9-]*|\d{5,}/g);
  if (modelMatches) attrs.model.push(...modelMatches.map((v) => v.toLowerCase()));

  // عدد القطع في العبوة
  const packRx = /\b(\d+)\s*(?:pcs|pieces|pack|count|capsules|tablets|sheets|units|pairs)\b/gi;
  let pm;
  while ((pm = packRx.exec(lower))) {
    const n = parseInt(pm[1], 10);
    if (n > 1 && n < 100000 && !attrs.pack.includes(n)) attrs.pack.push(n);
  }
  const arPack = lower.match(/(?:عبوة|عدد)[^\d]{0,8}(\d+)/);
  if (arPack) {
    const n = parseInt(arPack[1], 10);
    if (n > 1 && n < 100000 && !attrs.pack.includes(n)) attrs.pack.push(n);
  }
  return attrs;
}

/** نص بحث نظيف للتطابق */
function normalizeSearchText(text) {
  if (text == null) return "";
  let s = normalizeKey(text);
  s = s.replace(/\bال/g, " "); // أداة التعريف العربية
  return s.split(" ").filter((w) => w.length > 1 && !STOP.has(w)).join(" ");
}

/** مجموعة كلمات للتطابق */
function tokenSet(text) {
  const t = normalizeSearchText(text);
  const set = new Set();
  for (const part of t.split(" ")) {
    const tok = part.replace(/[^a-z0-9]/g, "");
    if (tok.length >= 2) set.add(tok);
  }
  return set;
}

/** مقارنة صفات الجانبين — تعيد عدد التطابقات والاختلافات */
function compareAttributes(aO, aF) {
  let sameCount = 0, diffCount = 0;
  for (const k of ["size", "color", "model", "pack"]) {
    const A = aO[k], B = aF[k];
    if (!A.length || !B.length) continue;
    for (const a of A) if (B.includes(a)) sameCount++;
    for (const a of A) if (!B.includes(a)) diffCount++;
  }
  return { sameCount, diffCount };
}

/** مطابقة أسماء — تعيد درجة 0..1 مع تفاصيل لماذا */
function matchName(original, found) {
  const normO = normalizeSearchText(original);
  const normF = normalizeSearchText(found);
  if (!normO || !normF) return { score: 0, detail: "نص فارغ" };

  let base = 0;
  const detail = [];
  if (normO === normF) {
    base = 1;
    detail.push("تطابق تام");
  } else if (normO.includes(normF) || normF.includes(normO)) {
    const ratio = Math.min(normO.length, normF.length) / Math.max(normO.length, normF.length);
    base = 0.55 + ratio * 0.4;
    detail.push("اسم داخل الآخر");
  } else {
    const to = tokenSet(original);
    const tf = tokenSet(found);
    let inter = 0;
    for (const t of to) if (tf.has(t)) inter++;
    const union = new Set([...to, ...tf]);
    const jac = union.size ? inter / union.size : 0;
    let weighted = 0, tw = 0;
    for (const t of to) {
      const w = t.length >= 5 ? 2 : 1;
      tw += w;
      if (tf.has(t)) weighted += w;
    }
    base = tw ? 0.65 * jac + 0.35 * (weighted / tw) : 0;
    detail.push(`كلمات مشتركة ${inter}/${to.size}`);
  }

  const aO = extractAttributes(original);
  const aF = extractAttributes(found);
  const { sameCount, diffCount } = compareAttributes(aO, aF);
  let s = base * 0.72 + Math.min(0.28, sameCount * 0.12) - Math.min(0.4, diffCount * 0.13);
  s = Math.max(0, Math.min(1, s));
  if (sameCount > 0) detail.push(`صفات مشتركة ${sameCount}`);
  if (diffCount > 0) detail.push(`اختلاف صفات ${diffCount}`);
  return { score: Math.round(s * 1000) / 1000, detail: detail.join(" · ") };
}

/** تصنيف نتيجة التطابق ضمن الحالات الأربع */
function classifyMatch(best, candidates) {
  if (best == null || candidates.length === 0) return "not_found";
  const top = candidates[0];
  if (top.score >= 0.75) {
    const second = candidates[1];
    if (!second || top.score - second.score >= 0.2) return "matched";
    return "review"; // أكثر من تطابق قوي
  }
  if (top.score >= 0.5) return "review";
  return "not_found";
}

module.exports = {
  normalizeKey,
  extractAttributes,
  normalizeSearchText,
  tokenSet,
  matchName,
  classifyMatch,
};