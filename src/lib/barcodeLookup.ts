import ExcelJS from "exceljs";
import JSZip from "jszip";
import * as XLSX from "xlsx";

export const MAX_BARCODE_PRODUCTS = 20_000;

export interface BarcodeInputRow {
  index: number;
  sourceName: string;
  englishName: string;
  barcode: string;
  price: number | null;
  sku: string;
}

export interface BarcodeLookupResult extends BarcodeInputRow {
  productName: string;
  description: string;
  imageUrl: string;
  productUrl: string;
  source: string;
  matchScore: number;
  barcodeVerified: boolean;
  candidates: BarcodeLookupCandidate[];
  status: "found" | "review" | "not_found";
}

export interface BarcodeLookupCandidate {
  productName: string;
  description: string;
  imageUrl: string;
  productUrl: string;
  source: string;
  matchScore: number;
  barcodeVerified: boolean;
}

function parsePrice(value: string): number | null {
  const normalized = value.replace(/[^\d.,-]/g, "").replace(/,(?=\d{3}(?:\D|$))/g, "").replace(/,/g, ".");
  const price = Number(normalized);
  return Number.isFinite(price) ? price : null;
}

export function generateBarcodeSku(startSku: string, offset: number): string {
  const match = startSku.trim().toUpperCase().match(/^([A-Z]{4})(\d{4})$/);
  if (!match) throw new Error("أدخل SKU مكوّنًا من 4 حروف و4 أرقام، مثال: ABCD0001");
  const sequence = Number(match[2]) + offset;
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("رقم SKU الناتج غير صالح");
  return `${match[1]}${String(sequence).padStart(4, "0")}`;
}

export async function parseBarcodeSheet(buffer: ArrayBuffer, startSku: string): Promise<BarcodeInputRow[]> {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
  const rows: BarcodeInputRow[] = [];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const sheetRows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, raw: true, defval: "" });
    const headerIndex = sheetRows.findIndex((row) =>
      row.some((cell) => /barcode|باركود|ean|upc|gtin|price|سعر|product|اسم|منتج|title/i.test(String(cell ?? "")))
    );
    const headers = headerIndex >= 0 ? sheetRows[headerIndex].map((cell) => String(cell ?? "").trim()) : [];
    const findColumn = (pattern: RegExp) => headers.findIndex((header) => pattern.test(header));
    const headerBarcodeColumn = findColumn(/barcode|باركود|ean|upc|gtin/i);
    const headerPriceColumn = findColumn(/price|سعر/i);
    const headerNameColumn = findColumn(/product|اسم|منتج|title/i);
    const headerEnglishColumn = findColumn(/english|انجليزي|إنجليزي/i);
    const hasBarcodeHeader = headerBarcodeColumn >= 0;
    const barcodeColumn = hasBarcodeHeader ? headerBarcodeColumn : 1;
    const priceColumn = hasBarcodeHeader && headerPriceColumn >= 0 ? headerPriceColumn : 2;
    const nameColumn = hasBarcodeHeader ? headerNameColumn : 0;
    const englishColumn = hasBarcodeHeader ? headerEnglishColumn : 3;

    for (const [rowIndex, row] of sheetRows.entries()) {
      if (rowIndex === headerIndex) continue;
      const firstCell = String(row[0] ?? "").trim();
      const secondCell = String(row[1] ?? "").trim();
      const firstCellBarcode = firstCell.replace(/\D/g, "");
      const secondCellBarcode = secondCell.replace(/\D/g, "");
      const barcodeInFirstColumn = !hasBarcodeHeader &&
        /^\d{8,14}$/.test(firstCellBarcode) &&
        !/^\d{8,14}$/.test(secondCellBarcode);
      const selectedBarcodeColumn = barcodeInFirstColumn ? 0 : barcodeColumn;
      const selectedPriceColumn = barcodeInFirstColumn ? 1 : priceColumn;
      const rawBarcode = String(row[selectedBarcodeColumn] ?? "").trim();
      const barcode = rawBarcode.replace(/\D/g, "");
      const sourceName = barcodeInFirstColumn ? "" : String(row[nameColumn] ?? "").trim();
      const englishName = String(row[englishColumn] ?? "").trim();
      if (!barcode || !/^\d{8,14}$/.test(barcode)) continue;
      if (rows.length >= MAX_BARCODE_PRODUCTS) {
        throw new Error(`الحد الأقصى المسموح به هو ${MAX_BARCODE_PRODUCTS.toLocaleString("en-US")} منتج`);
      }
      rows.push({
        index: rows.length + 1,
        sourceName,
        englishName,
        barcode,
        price: parsePrice(String(row[selectedPriceColumn] ?? "").trim()),
        sku: generateBarcodeSku(startSku, rows.length),
      });
    }
    if (rows.length) break;
  }

  if (!rows.length) throw new Error("لم يتم العثور على صفوف تحتوي على باركود صالح. ضع الباركود في العمود A أو B.");
  return rows;
}

export async function lookupBarcodes(
  rows: BarcodeInputRow[],
  onBatchComplete?: (completed: number, total: number, results: BarcodeLookupResult[]) => void
): Promise<BarcodeLookupResult[]> {
  const batchSize = 4;
  const results: BarcodeLookupResult[] = [];
  for (let start = 0; start < rows.length; start += batchSize) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 180000);
    try {
      let response: Response;
      try {
        response = await fetch("/api/barcode-lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: rows.slice(start, start + batchSize) }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new Error("انتهت مهلة البحث. تحقق من اتصال الإنترنت وحاول مرة أخرى.");
        if (error instanceof TypeError) {
          throw new Error("تعذر الاتصال بخادم البحث. تأكد من تشغيل الخادم ثم أعد المحاولة.");
        }
        throw error;
      }
      const payload = await response.json() as { results?: BarcodeLookupResult[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "فشل البحث عن بيانات الباركود");
      results.push(...(payload.results || []));
      onBatchComplete?.(results.length, rows.length, [...results]);
    } catch (error) {
      if (controller.signal.aborted) throw new Error("انتهت مهلة البحث. تحقق من اتصال الإنترنت وحاول مرة أخرى.");
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return results;
}

export interface BarcodeExportProgress {
  stage: "images" | "workbook" | "zip";
  completed: number;
  total: number;
  failedImages: number;
}

export async function exportBarcodeResults(
  results: BarcodeLookupResult[],
  onProgress?: (progress: BarcodeExportProgress) => void
): Promise<number> {
  const workbook = new ExcelJS.Workbook();
  const zip = new JSZip();
  const sheet = workbook.addWorksheet("Barcode Lookup", { views: [{ rightToLeft: true }] });
  sheet.columns = [
    { header: "SKU", key: "sku", width: 16 },
    { header: "اسم المنتج", key: "name", width: 38 },
    { header: "الباركود", key: "barcode", width: 20 },
    { header: "السعر", key: "price", width: 14 },
    { header: "أفضل تطابق %", key: "score", width: 15 },
    { header: "عدد المرشحين", key: "candidateCount", width: 15 },
    { header: "روابط المرشحين", key: "candidates", width: 80 },
    { header: "الصورة", key: "image", width: 18 },
    { header: "الوصف", key: "description", width: 56 },
    { header: "حالة المطابقة", key: "status", width: 22 },
    { header: "رابط المصدر", key: "url", width: 50 },
  ];

  for (const [index, result] of results.entries()) {
    const excelRow = index + 2;
    sheet.addRow({
      sku: result.sku,
      name: result.productName || result.sourceName,
      barcode: result.barcode,
      price: result.price,
      score: `${Math.round(result.matchScore * 100)}%`,
      candidateCount: result.candidates.length,
      candidates: result.candidates.map((candidate) =>
        `${candidate.productName} | ${candidate.source} | ${Math.round(candidate.matchScore * 100)}% | ${candidate.barcodeVerified ? "Barcode verified" : "Name match only"} | ${candidate.productUrl}`
      ).join("\n"),
      image: "",
      description: result.description,
      status: result.status === "found" ? "مطابق للباركود" : result.status === "review" ? "مرشح بالاسم، راجع الباركود" : "غير موجود",
      url: result.productUrl,
    });
    sheet.getRow(excelRow).height = 76;
  }

  const imageResults = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => Boolean(result.imageUrl));
  let completedImages = 0;
  let failedImages = 0;
  let nextImageIndex = 0;
  onProgress?.({ stage: "images", completed: 0, total: imageResults.length, failedImages });

  const downloadImage = async (item: typeof imageResults[number]) => {
    const { result, index } = item;
    const imageUrl = upgradeBarcodeImageUrl(result.imageUrl);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`/api/image-proxy?url=${encodeURIComponent(imageUrl)}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`تعذر تنزيل الصورة (${response.status})`);
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      const extension = contentType.includes("png") ? "png"
        : contentType.includes("gif") ? "gif"
          : contentType.includes("webp") ? "webp"
            : contentType.includes("avif") ? "avif"
              : /\.png(?:$|[?#])/i.test(imageUrl) ? "png"
                : /\.gif(?:$|[?#])/i.test(imageUrl) ? "gif"
                  : /\.webp(?:$|[?#])/i.test(imageUrl) ? "webp"
                    : /\.avif(?:$|[?#])/i.test(imageUrl) ? "avif" : "jpeg";
      const imageBuffer = await response.arrayBuffer();
      if (imageBuffer.byteLength === 0) throw new Error("الصورة التي تم تنزيلها فارغة");
      const safeSku = result.sku.replace(/[^A-Za-z0-9_-]/g, "_") || String(index + 1);
      const fileExtension = extension === "jpeg" ? "jpg" : extension;
      zip.file(`images/${safeSku}.${fileExtension}`, imageBuffer);

      if (extension === "jpeg" || extension === "png" || extension === "gif") {
        const imageId = workbook.addImage({ buffer: imageBuffer, extension });
        sheet.addImage(imageId, {
          tl: { col: 4, row: index + 1 },
          ext: { width: 68, height: 68 },
        });
      }
    } catch {
      failedImages += 1;
    } finally {
      clearTimeout(timeoutId);
      completedImages += 1;
      onProgress?.({
        stage: "images",
        completed: completedImages,
        total: imageResults.length,
        failedImages,
      });
    }
  };

  const concurrency = Math.min(6, imageResults.length);
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextImageIndex < imageResults.length) {
      const currentIndex = nextImageIndex++;
      await downloadImage(imageResults[currentIndex]);
    }
  }));

  onProgress?.({ stage: "workbook", completed: 0, total: 1, failedImages });
  zip.file("barcode-lookup-results.xlsx", await workbook.xlsx.writeBuffer());
  onProgress?.({ stage: "zip", completed: 0, total: 1, failedImages });
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" }, (metadata) => {
    onProgress?.({
      stage: "zip",
      completed: Math.round(metadata.percent),
      total: 100,
      failedImages,
    });
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "barcode-lookup-results.zip";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return failedImages;
}

function upgradeBarcodeImageUrl(value: string): string {
  try {
    const url = new URL(value);
    url.pathname = url.pathname
      .replace(/\._AC_(?:SY|SX|UY|UX|UL)\d+_/i, "._AC_SL1500_")
      .replace(/\._SL\d+_/i, "._SL1500_")
      .replace(/image_\d+x\d+_/i, "image_1200x1200_")
      .replace(/-(?:\d{2,4})x(?:\d{2,4})-converted/gi, "-1200x1200-converted");
    if (url.searchParams.has("width")) url.searchParams.set("width", "2000");
    return url.toString();
  } catch {
    return value;
  }
}