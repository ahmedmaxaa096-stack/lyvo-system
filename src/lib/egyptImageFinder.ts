import ExcelJS from "exceljs";
import JSZip from "jszip";

export interface EgyptImageRow {
  index: number;
  productName: string;
  sku: string;
}

export interface EgyptImageResult {
  index: number;
  productName: string;
  sku: string;
  title: string;
  productUrl: string;
  imageUrl: string;
  source: string;
  score: number;
  status: "verified" | "review" | "not_found";
  reason: string;
}

export async function parseProductNames(buffer: ArrayBuffer): Promise<EgyptImageRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const rows: EgyptImageRow[] = [];
  for (const worksheet of workbook.worksheets) {
    const headers: string[] = [];
    worksheet.getRow(1).eachCell((cell) => {
      headers[Number(cell.col) - 1] = String(cell.text || cell.value || "").trim().toLowerCase();
    });
    const nameColumn = headers.findIndex((header) => /name|product|اسم|منتج|title/i.test(header));
    const skuColumn = headers.findIndex((header) => /sku|code|كود|رمز/i.test(header));
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const fallback = row.getCell(1).text?.trim() || "";
      const productName = (nameColumn >= 0 ? row.getCell(nameColumn + 1).text : fallback).trim();
      const sku = skuColumn >= 0 ? row.getCell(skuColumn + 1).text.trim() : "";
      if (productName) rows.push({ index: rows.length + 1, productName, sku });
    });
    if (rows.length > 0) break;
  }
  return rows;
}

export async function findEgyptImages(
  rows: EgyptImageRow[],
  openaiApiKey: string,
  onProgress?: (current: number, total: number) => void
): Promise<EgyptImageResult[]> {
  const response = await fetch("/api/egypt-image-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows, openaiApiKey: openaiApiKey.trim() }),
  });
  const payload = (await response.json()) as { results?: EgyptImageResult[]; error?: string };
  if (!response.ok) throw new Error(payload.error || "فشل البحث عن صور المنتجات");
  const results = payload.results || [];
  results.forEach((_result, index) => onProgress?.(index + 1, results.length));
  return results;
}

export async function exportEgyptResults(results: EgyptImageResult[]): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("صور السوق المصري", { views: [{ rightToLeft: true }] });
  sheet.columns = [
    { header: "م", key: "index", width: 8 },
    { header: "SKU", key: "sku", width: 18 },
    { header: "اسم المنتج", key: "name", width: 42 },
    { header: "اسم صفحة المنتج", key: "title", width: 48 },
    { header: "المصدر", key: "source", width: 20 },
    { header: "نسبة المطابقة", key: "score", width: 16 },
    { header: "الحالة", key: "status", width: 18 },
    { header: "رابط المنتج", key: "url", width: 55 },
    { header: "رابط الصورة", key: "image", width: 55 },
  ];
  for (const result of results) {
    sheet.addRow({
      index: result.index,
      sku: result.sku || "",
      name: result.productName,
      title: result.title || "",
      source: result.source || "",
      score: `${Math.round(result.score * 100)}%`,
      status: result.status === "verified" ? "مؤكدة" : result.status === "review" ? "مراجعة" : "غير موجودة",
      url: result.productUrl || "",
      image: result.imageUrl || "",
    });
  }
  const buffer = await workbook.xlsx.writeBuffer();
  const zip = new JSZip();
  zip.file("نتائج-صور-السوق-المصري.xlsx", buffer);
  for (const result of results.filter((item) => item.status === "verified" && item.imageUrl)) {
    try {
      const image = await fetch(`/api/image-proxy?url=${encodeURIComponent(result.imageUrl)}`);
      if (image.ok) zip.file(`${result.sku || result.index}.jpg`, await image.blob());
    } catch {
      // Keep the result row even when a remote image cannot be downloaded.
    }
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "صور-منتجات-السوق-المصري.zip";
  link.click();
  URL.revokeObjectURL(url);
}
