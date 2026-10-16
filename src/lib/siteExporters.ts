import ExcelJS from "exceljs";
import JSZip from "jszip";
import { fetchImageAsBlob } from "./scraper";
import type { DeepSiteProduct } from "./siteScraper";
import { normalizeSkuFileName } from "./imageSku";

const ZIP_CONCURRENCY = 12;

/** تنظيف اسم المنتج ليصبح اسم ملف صالح على الويندوز */
export function sanitizeFileName(name: string, fallback: string): string {
  let cleaned = Array.from(String(name || ""))
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code === 0x7f || (code >= 0x00 && code <= 0x1f)) return " ";
      return /[\\/:*?"<>|]/.test(char) ? " " : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  cleaned = cleaned.replace(/[.\s]+$/, "");
  if (cleaned.length > 100) {
    cleaned = cleaned.slice(0, 100).trim().replace(/[.\s]+$/, "");
  }
  return cleaned || fallback;
}

function extensionFromUrlOrMime(url: string, mime: string): string {
  const fromMime = mime.replace("image/", "").split(";")[0].toLowerCase();
  if (["jpeg", "jpg", "png", "webp", "gif", "avif", "bmp"].includes(fromMime)) {
    return fromMime === "jpeg" ? "jpg" : fromMime;
  }
  const match = url.match(/\.(jpe?g|jfif|png|webp|gif|avif|bmp)(?:$|[?#])/i);
  if (match) return match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  return "jpg";
}

/** أسماء ملفات كل منتج (نفس الاسم الذي سيظهر في الشيت) */
export function buildFileNames(products: DeepSiteProduct[]): string[][] {
  const usedNames = new Set<string>();

  return products.map((product, index) => {
    const preferredBase = product.sku ? normalizeSkuFileName(product.sku) : `SKU-${index + 1}`;
    const base = sanitizeFileName(preferredBase || `SKU-${index + 1}`, `SKU-${index + 1}`);
    const imageCount = Math.max(product.images.length, product.image_url ? 1 : 0);
    const names = imageCount === 0
      ? [base]
      : Array.from({ length: imageCount }, (_, i) => (i === 0 ? base : `${base}_${i + 1}`));

    return names.map((name) => {
      let uniqueName = name;
      let duplicateIndex = 2;
      while (usedNames.has(uniqueName.toLowerCase())) {
        uniqueName = `${name} (${duplicateIndex})`;
        duplicateIndex += 1;
      }
      usedNames.add(uniqueName.toLowerCase());
      return uniqueName;
    });
  });
}

/** شيت Excel بكل بيانات المنتجات مع فصل حقول الاسم والوصف حسب اللغة */
export async function buildSiteExcel(
  products: DeepSiteProduct[],
  fileNames: string[][]
): Promise<Blob> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("المنتجات", {
    views: [{ rightToLeft: true }],
  });

  worksheet.columns = [
    { header: "م", key: "index", width: 6 },
    { header: "SKU", key: "sku", width: 20 },
    { header: "اسم المنتج (إنجليزي)", key: "nameEn", width: 45 },
    { header: "اسم المنتج (عربي)", key: "nameAr", width: 45 },
    { header: "السعر (EGP)", key: "price", width: 15 },
    { header: "الوصف (إنجليزي)", key: "descriptionEn", width: 60 },
    { header: "الوصف (عربي)", key: "descriptionAr", width: 60 },
    { header: "عدد الصور", key: "imageCount", width: 10 },
    { header: "أسماء ملفات الصور", key: "imageFiles", width: 55 },
    { header: "الرابط", key: "url", width: 50 },
  ];

  worksheet.getRow(1).font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1a56db" },
  };
  worksheet.getRow(1).alignment = { horizontal: "center", vertical: "middle" };
  worksheet.getRow(1).height = 25;

  products.forEach((product, index) => {
    const names = fileNames[index] || [];
    const row = worksheet.addRow({
      index: index + 1,
      sku: product.sku || "—",
      nameEn: product.product_name || "—",
      nameAr: product.product_name_ar || "—",
      price: product.price ? product.price.toLocaleString("en-US") : "—",
      descriptionEn: product.description_en || product.description || "—",
      descriptionAr: product.description_ar || "—",
      imageCount: product.images.length,
      imageFiles: names.join(" | ") || "—",
      url: product.url,
    });
    if (product.url) {
      row.getCell("url").value = { text: product.url, hyperlink: product.url } as ExcelJS.CellValue;
    }
    row.alignment = { vertical: "top", horizontal: "right", wrapText: true };
    row.height = 60;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/** ZIP بكل صور كل منتج بالجودة الأصلية الكاملة — اسم كل صورة = اسم منتجها */
export async function buildSiteImagesZip(
  products: DeepSiteProduct[],
  fileNames: string[][],
  onProgress?: (done: number, total: number) => void
): Promise<Blob> {
  const zip = new JSZip();
  const usedPaths = new Set<string>();
  const imageUrls: Array<{ productIndex: number; imageIndex: number; url: string }> = [];

  products.forEach((product, productIndex) => {
    const names = fileNames[productIndex] || [`منتج-${productIndex + 1}`];
    const urls = product.images.length > 0 ? product.images : product.image_url ? [product.image_url] : [];
    urls.forEach((url, imageIndex) => {
      imageUrls.push({ productIndex, imageIndex, url });
      void names;
    });
  });

  let done = 0;
  const total = imageUrls.length;
  onProgress?.(0, total);

  const pathFor = (productIndex: number, imageIndex: number, ext: string): string => {
    const names = fileNames[productIndex] || [`منتج-${productIndex + 1}`];
    const base = names[imageIndex] || `${names[0]} (${imageIndex + 1})`;
    let path = `${base}.${ext}`;
    let counter = 2;
    while (usedPaths.has(path.toLowerCase())) {
      path = `${base} (${counter}).${ext}`;
      counter++;
    }
    usedPaths.add(path.toLowerCase());
    return path;
  };

  const results: Array<{ path: string; blob: Blob } | null> = new Array(imageUrls.length).fill(null);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < imageUrls.length) {
      const index = nextIndex++;
      const item = imageUrls[index];
      try {
        const blob = await fetchImageAsBlob(item.url);
        const ext = extensionFromUrlOrMime(item.url, blob.type || "");
        results[index] = { path: pathFor(item.productIndex, item.imageIndex, ext), blob };
      } catch {
        // تجاهل الصور التي تفشل — نكمل الباقي
      }
      done++;
      onProgress?.(done, total);
    }
  };

  await Promise.all(Array.from({ length: Math.min(ZIP_CONCURRENCY, Math.max(1, imageUrls.length)) }, worker));

  for (const result of results) {
    if (result) zip.file(result.path, result.blob);
  }

  const readmeLines = [
    "ملف الصور — كل صورة تحمل اسم منتجها المطابق لعمود «اسم المنتج» في شيت الإكسل.",
    "",
    ...products.map((product, index) => {
      const names = fileNames[index] || [];
      return `${index + 1}. ${names[0] || product.product_name} — ${product.images.length} صورة`;
    }),
  ];
  zip.file("أسماء-المنتجات.txt", "\uFEFF" + readmeLines.join("\n"));

  return zip.generateAsync({ type: "blob" });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}