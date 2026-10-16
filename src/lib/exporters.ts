import ExcelJS from "exceljs";
import JSZip from "jszip";
import { fetchImageAsBase64, fetchImageAsBlob, compressImage } from "./scraper";
import type { ScrapedProduct } from "./scraper";
import { normalizeSkuValue } from "./imageSku";

export interface ExportProgress {
  current: number;
  total: number;
  label: string;
}

const CONCURRENCY = 10;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

export async function exportToExcel(
  products: ScrapedProduct[],
  onProgress?: (progress: ExportProgress) => void
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("المنتجات", {
    views: [{ rightToLeft: true }],
  });

  worksheet.columns = [
    { header: "م", key: "index", width: 6 },
    { header: "SKU", key: "sku", width: 20 },
    { header: "اسم المنتج", key: "name", width: 40 },
    { header: "اسم المنتج (عربي)", key: "name_ar", width: 40 },
    { header: "اسم المنتج (إنجليزي)", key: "name_en", width: 40 },
    { header: "السعر (EGP)", key: "price", width: 15 },
    { header: "الوصف (عربي)", key: "description_ar", width: 50 },
    { header: "الوصف (إنجليزي)", key: "description_en", width: 50 },
    { header: "الرابط", key: "url", width: 50 },
    { header: "الصورة", key: "image", width: 30 },
  ];

  worksheet.getRow(1).font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1a56db" },
  };
  worksheet.getRow(1).alignment = { horizontal: "center", vertical: "middle" };
  worksheet.getRow(1).height = 25;

  // Add all rows first
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const row = worksheet.addRow({
      index: i + 1,
      sku: product.sku || "—",
      name: product.product_name || "—",
      name_ar: product.product_name_ar || "—",
      name_en: product.product_name_en || "—",
      price: product.price ? product.price.toLocaleString("en-US") : "—",
      description_ar: product.description_ar || "—",
      description_en: product.description_en || "—",
      url: product.url,
      image: "",
    });

    row.alignment = { vertical: "middle", horizontal: "right" };
    row.height = 60;
  }

  // Fetch and compress images in parallel
  const imageData = await mapWithConcurrency(
    products,
    CONCURRENCY,
    async (product, index) => {
      onProgress?.({
        current: index,
        total: products.length,
        label: `تحميل الصور... (${index + 1}/${products.length})`,
      });

      const imageUrls = (product.images && product.images.length > 0
        ? product.images
        : [product.image_url_high || product.image_url]
      ).filter(Boolean);
      if (imageUrls.length === 0) return null;

      try {
        const base64 = await fetchImageAsBase64(imageUrls[0], product.url);
        const compressed = await compressImage(base64, 150, 0.3);
        return compressed.split(",")[1];
      } catch {
        return null;
      }
    }
  );

  // Add images to worksheet
  for (let i = 0; i < imageData.length; i++) {
    const base64Data = imageData[i];
    if (!base64Data) {
      worksheet.getCell(`J${i + 2}`).value = "تعذّر تحميل الصورة";
      continue;
    }

    try {
      const imageId = workbook.addImage({
        base64: base64Data,
        extension: "jpeg",
      });
      worksheet.addImage(imageId, {
        tl: { col: 9, row: i + 1 } as ExcelJS.Anchor,
        br: { col: 10, row: i + 2 } as ExcelJS.Anchor,
      });
    } catch {
      worksheet.getCell(`J${i + 2}`).value = "تعذّر تحميل الصورة";
    }
  }

  onProgress?.({
    current: products.length,
    total: products.length,
    label: "إنشاء ملف Excel...",
  });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "منتجات-نون.xlsx";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function exportToZip(
  products: ScrapedProduct[],
  onProgress?: (progress: ExportProgress) => void
): Promise<void> {
  const zip = new JSZip();
  const productsData: Array<{
    index: number;
    sku: string;
    name: string;
    price: string;
    description_ar: string;
    description_en: string;
    url: string;
    imageFiles: string[];
  }> = [];
  const usedFileNames = new Set<string>();

  // Fetch all images in parallel
  const imageResults = await mapWithConcurrency(
    products,
    CONCURRENCY,
    async (product, index) => {
      onProgress?.({
        current: index,
        total: products.length,
        label: `تحميل الصور... (${index + 1}/${products.length})`,
      });

      const imageUrls = (product.images && product.images.length > 0
        ? product.images
        : [product.image_url_high || product.image_url]
      ).filter(Boolean);
      if (imageUrls.length === 0) return [] as Blob[];

      try {
        const blobs = await Promise.all(
          imageUrls.map((imageUrl) => fetchImageAsBlob(imageUrl, product.url))
        );
        return blobs;
      } catch {
        return [] as Blob[];
      }
    }
  );

  // Add images to zip
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const blobs = imageResults[i] || [];
    const imageFiles: string[] = [];

    blobs.forEach((blob, imageIndex) => {
      const baseName = normalizeSkuValue(product.sku || String(i + 1));
      const imageName = imageIndex === 0 ? baseName || String(i + 1) : `${baseName || i + 1}_${imageIndex + 1}`;
      let fileName = `${imageName}.jpg`;
      let duplicateIndex = 2;
      while (usedFileNames.has(fileName.toLowerCase())) {
        fileName = `${imageName} (${duplicateIndex}).jpg`;
        duplicateIndex += 1;
      }
      usedFileNames.add(fileName.toLowerCase());
      imageFiles.push(fileName);
      zip.file(fileName, blob);
    });

    productsData.push({
      index: i + 1,
      sku: product.sku || "—",
      name: product.product_name || "—",
      price: product.price ? product.price.toLocaleString("en-US") : "—",
      description_ar: product.description_ar || "—",
      description_en: product.description_en || "—",
      url: product.url,
      imageFiles,
    });
  }

  const csvContent = [
    "\uFEFFم,SKU,اسم المنتج,السعر (EGP),الوصف (عربي),الوصف (إنجليزي),الرابط,ملفات الصور",
    ...productsData.map(
      (p) =>
        `${p.index},${p.sku},"${p.name.replace(/"/g, '""')}",${p.price},"${(p.description_ar || "").replace(/"/g, '""')}","${(p.description_en || "").replace(/"/g, '""')}",${p.url},"${p.imageFiles.join(", ")}"`
    ),
  ].join("\n");
  zip.file("بيانات-المنتجات.csv", csvContent);

  onProgress?.({
    current: products.length,
    total: products.length,
    label: "إنشاء ملف ZIP...",
  });

  const content = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(content);
  const a = document.createElement("a");
  a.href = url;
  a.download = "صور-نون-عالية-الجودة.zip";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}