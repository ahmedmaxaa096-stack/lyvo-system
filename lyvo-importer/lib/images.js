/* ============================================================
 * الصور: تنزيل بأعلى جودة + تسمية بملف SKU +
 * كتابة SKU في شريط أبيض أسفل الصورة دون تغطية المنتج
 * ============================================================ */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const sharp = require("sharp");
const { dirs } = require("./state");
const { skuToFileName } = require("./sku");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** تنزيل صورة من رابط — يعيد Buffer أو يرمي خطأ */
async function downloadImage(url, referer = "") {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 45000,
    headers: {
      "User-Agent": UA,
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      Referer: referer || undefined,
    },
    maxRedirects: 6,
  });
  if (!res.data || !Buffer.isBuffer(res.data)) throw new Error("استجابة غير صورة");
  const type = String(res.headers["content-type"] || "");
  if (!type.startsWith("image/") && !/\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(url)) {
    throw new Error("الرابط لا يقدّم صورة");
  }
  return { buffer: res.data, contentType: type };
}

/** استنتاج صيغة ملف من الرابط أو الـ content-type */
function extFrom(url, contentType) {
  const m = String(contentType).match(/image\/(jpeg|png|webp|gif|bmp|avif|svg\+xml)/);
  if (m) {
    const e = m[1] === "svg+xml" ? "svg" : m[1] === "jpeg" ? "jpg" : m[1];
    if (["jpg", "png", "webp", "gif", "bmp", "avif", "svg"].includes(e)) return e;
  }
  const u = String(url || "").match(/\.(jpe?g|png|webp|gif|bmp|avif|svg)(?:$|[?#])/i);
  if (u) return u[1].toLowerCase() === "jpeg" ? "jpg" : u[1].toLowerCase();
  return "jpg";
}

/**
 * حفظ الصورة الأصلية باسم <SKU>.jpg في مجلد originals
 * (توحيد كل الصور إلى JPEG عالي الجودة لضمان تطابق image_filename)
 */
async function saveOriginalImage(sku, url, referer) {
  const d = dirs();
  fs.mkdirSync(d.IMAGES_ORIGINAL_DIR, { recursive: true });
  const safeSku = skuToFileName(sku);

  let lastErr = null;
  try {
    const { buffer, contentType } = await downloadImage(url, referer);
    const processed = await sharp(buffer)
      .rotate()
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
    const fileName = `${safeSku}.jpg`;
    fs.writeFileSync(path.join(d.IMAGES_ORIGINAL_DIR, fileName), processed);
    return fileName;
  } catch (e) { lastErr = e; }
  throw lastErr || new Error("فشل تنزيل الصورة");
}

/** كتابة SKU على الصورة في شريط أبيض أسفلها — يُحفظ في مجلد labeled */
async function saveLabeledImage(sku, originalFile) {
  const d = dirs();
  fs.mkdirSync(d.IMAGES_LABELED_DIR, { recursive: true });
  const safeSku = skuToFileName(sku);
  const sourcePath = path.join(d.IMAGES_ORIGINAL_DIR, originalFile);
  const img = sharp(sourcePath);
  const meta = await img.metadata();
  const width = Math.min(meta.width || 1000, 1600);
  const resized = await img.resize({ width, withoutEnlargement: true }).toBuffer();
  const m = await sharp(resized).metadata();
  const w = m.width || 1000;
  const h = m.height || 1000;

  const barH = Math.max(48, Math.round(h * 0.1));
  const fontSize = Math.max(26, Math.round(w * 0.045));
  const escText = String(sku)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${barH}">` +
      `<rect width="100%" height="100%" fill="#ffffff"/>` +
      `<line x1="0" y1="1" x2="${w}" y2="1" stroke="#e5e7eb" stroke-width="1"/>` +
      `<text x="50%" y="52%" font-family="Arial, 'Segoe UI', sans-serif" font-size="${fontSize}" ` +
      `font-weight="700" fill="#111111" text-anchor="middle" dominant-baseline="middle" ` +
      `letter-spacing="${Math.max(1, Math.round(w * 0.004))}">${escText}</text></svg>`
  );

  const labeled = await sharp(resized)
    .extend({ bottom: barH, background: "#ffffff" })
    .composite([{ input: svg, top: h, left: 0 }])
    .jpeg({ quality: 92 })
    .toBuffer();

  const fileName = `${safeSku}.jpg`;
  fs.writeFileSync(path.join(d.IMAGES_LABELED_DIR, fileName), labeled);
  return fileName;
}

/** تجهيز صف واحد: أصلية + مكتوبة (حسب الإعداد) — يرجع صورة أو يرمي */
async function saveRowImages(row, referer) {
  if (!row.image_url) throw new Error("لا يوجد رابط صورة لهذا الصف");
  const originalFile = await saveOriginalImage(row.sku, row.image_url, referer);
  row.image_filename = originalFile;
  row.image_original_file = originalFile;
  row.image_labeled_file = "";
  if (row.writeSku) {
    const labeledFile = await saveLabeledImage(row.sku, originalFile);
    row.image_labeled_file = labeledFile;
  }
  return row;
}

module.exports = { downloadImage, extFrom, saveOriginalImage, saveLabeledImage, saveRowImages };