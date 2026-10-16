import ExcelJS from "exceljs";

/* ============================================================
 * أداة مطابقة صور الجيف (GIF) المدمجة داخل الشيت
 * مع مجموعة الصور الخارجية، وتوليد الـ SKU وإعادة التسمية
 * ============================================================ */

const CONCURRENCY = 6;
const MAX_DHASH_DIST = 40; // أقصى مسافة (من 256) تعتبر تطابقاً

export interface EmbeddedSheetImage {
  id: string;
  sheetRow: number; // رقم الصف (يبدأ من 1)
  extension: string;
  blob: Blob;
  bytesHash: string; // بصمة البايتات الدقيقة
  dHash: string; // بصمة إدراكية (dHash)
}

export interface SheetProductRow {
  sheetRow: number;
  productName: string;
  price: string;
  sku: string; // الـ SKU المقروء من عمود SKU في الشيت (إن وجد)
  imageRef: string;
  link: string;
  image: EmbeddedSheetImage | null;
}

export interface ZipImageEntry {
  name: string;
  extension: string;
  blob: Blob;
  bytesHash: string;
  dHash: string;
}

function normalizeProductName(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/\s*(?:\(\d+\)|\[\d+\]|[_-]\s*\d+|\s+\d+)\s*$/i, "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactProductName(value: string): string {
  return normalizeProductName(value).replace(/[^a-z0-9\u0600-\u06ff]/gi, "");
}

export interface MatchAssignment {
  zipIndex: number | null;
  distance: number;
}

export type ProgressFn = (current: number, total: number, label: string) => void;

export interface SheetSkuMatchResult {
  index: number;
  sku: string;
  productName: string;
  price: string;
  link: string;
  originalName: string;
  newName: string;
  source: "zip" | "embedded" | "none";
  imageBlob: Blob | null;
  extension: string;
}

/* ---------- أدوات صغيرة عامة ---------- */

export function normalizeSkuValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const raw = trimmed.toUpperCase();
  const compact = raw.replace(/[^A-Z0-9]/g, "");

  const trailingVariant = raw.match(/^([A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*\d+)(?:[\s_-]+\d+)+$/i);
  if (trailingVariant) {
    return trailingVariant[1].toUpperCase();
  }

  return compact;
}

export function normalizeSkuFileName(value: string): string {
  const cleaned = normalizeSkuValue(value)
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[_\-\s]+/g, "")
    .replace(/[^A-Za-z0-9]/g, "");
  return cleaned || "SKU";
}

export function generateSku(start: string, index: number): string {
  const sanitized = normalizeSkuFileName(start);
  const match = sanitized.match(/^([A-Za-z]+)(\d+)$/);
  if (!match) {
    return `${sanitized}${String(index + 1).padStart(3, "0")}`;
  }
  const letters = match[1].toUpperCase();
  const numStr = match[2];
  const num = parseInt(numStr, 10) + index;
  return `${letters}${String(num).padStart(numStr.length, "0")}`;
}

export function fnv1a64Hex(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n; // FNV offset basis 64-bit
  const prime = 0x100000001b3n;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]);
    h *= prime;
    h &= 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

function extensionToMime(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "png") return "image/png";
  if (e === "gif") return "image/gif";
  if (e === "webp") return "image/webp";
  if (e === "bmp") return "image/bmp";
  if (e === "avif") return "image/avif";
  if (e === "tiff" || e === "tif") return "image/tiff";
  return "image/png";
}

/** تحويل الـ extension لصيغة يدعمها ExcelJS عند الدمج داخل الشيت */
export function excelExtension(ext: string): "jpeg" | "png" | "gif" | null {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg") return "jpeg";
  if (e === "png") return "png";
  if (e === "gif") return "gif";
  return null;
}

export function readCellText(cell: ExcelJS.Cell): string {
  const value = cell.value;

  // تحقق من الرابط المباشر في الخلية (ExcelJS hyperlink property)
  const directHyperlink = (cell as unknown as { hyperlink?: string }).hyperlink;
  if (directHyperlink) {
    return String(directHyperlink).trim();
  }

  if (value && typeof value === "object" && "hyperlink" in value) {
    return String((value as { hyperlink: string }).hyperlink).trim();
  }
  if (value && typeof value === "object" && "formula" in value) {
    const formula = String((value as { formula: string }).formula);
    const formulaUrl = formula.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
    if (formulaUrl) return formulaUrl.replace(/[),.;]+$/, "");
  }
  if (value && typeof value === "object" && "text" in value) {
    return String((value as { text: string }).text).trim();
  }
  if (value && typeof value === "object" && "richText" in value) {
    const richText = (value as {
      richText: Array<{ text: string; font?: { strike?: boolean } }>;
    }).richText;
    const visibleText = richText
      .filter((part) => !part.font?.strike)
      .map((part) => part.text)
      .join("")
      .trim();
    return visibleText || richText.map((part) => part.text).join("").trim();
  }
  if (value && typeof value === "object" && "result" in value) {
    return String((value as { result: string | number }).result || "").trim();
  }
  return value === null || value === undefined ? "" : String(value).trim();
}

export function extractSalePriceFromText(value: string): string {
  const text = String(value ?? "").replace(/<[^>]+>/g, " ");
  if (!text.trim()) return "";

  const numberMatches = Array.from(text.matchAll(/\d[\d,]*(?:\.\d{1,2})?/g));
  if (numberMatches.length === 0) return "";

  const candidateNumbers = numberMatches
    .map((match) => ({
      value: Number(match[0].replace(/,/g, "")),
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    }))
    .filter((item) => text.slice(item.end).trimStart().startsWith("%") === false)
    .filter((item) => Number.isFinite(item.value) && item.value > 0);

  if (candidateNumbers.length === 0) return "";

  if (/\d+(?:\.\d+)?\s*%\s*off\b/i.test(text)) {
    const salePrice = Math.min(...candidateNumbers.map((item) => item.value));
    return salePrice.toFixed(2).replace(/\.00$/, ".00");
  }

  const saleMatchers = [
    /(?:sale|offer|offers|discount|special|now|save|final|after\s+discount|price\s+after|on\s+sale|limited\s+time|off)/i,
    /(?:was|old|before|previous|regular|list|msrp|strike|struck|crossed|original)/i,
  ];

  for (const matcher of saleMatchers) {
    const matchIndex = text.search(matcher);
    if (matchIndex === -1) continue;
    const afterMarker = candidateNumbers
      .filter((item) => item.start > matchIndex)
      .sort((a, b) => a.start - b.start);
    if (afterMarker.length > 0) {
      return afterMarker[0].value.toFixed(2).replace(/\.00$/, ".00");
    }
  }

  const last = candidateNumbers[candidateNumbers.length - 1];
  return last.value.toFixed(2).replace(/\.00$/, ".00");
}

export function findSalePriceColumn(headers: string[]): number {
  const normalizedHeaders = headers.map((header) => String(header || "").trim().toLowerCase());
  const salePriceColumn = normalizedHeaders.findIndex((header) =>
    /sale\s*price|selling\s*price|current\s*price|offer\s*price|special\s*price|price\s*after\s*discount|سعر\s*البيع|السعر\s*الحالي|السعر\s*بعد\s*الخصم/i.test(header)
  );
  if (salePriceColumn >= 0) return salePriceColumn;
  return normalizedHeaders.findIndex((header) => /price|السعر|سعر/i.test(header));
}

function normalizeLink(value: string): string {
  const link = value.trim();
  if (!link) return "";
  if (/^https?:\/\//i.test(link)) return link;
  if (/^www\./i.test(link)) return `https://${link}`;
  return link;
}

export function basename(name: string): string {
  const parts = name.split(/[/\\]/);
  return parts[parts.length - 1] || name;
}
/* ---------- بصمة الصور ---------- */

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function drawBlobToCanvas(
  blob: Blob,
  width: number,
  height: number
): Promise<Uint8ClampedArray> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("المتصفح لا يدعم الرسم على Canvas");

  try {
    const bitmap = await createImageBitmap(blob);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
  } catch {
    // بديل: تحميل عبر عنصر Image
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("تعذّر فتح الصورة"));
        img.src = url;
      });
      ctx.drawImage(img, 0, 0, width, height);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return ctx.getImageData(0, 0, width, height).data;
}

/** بصمة إدراكية (dHash) بأبعاد 17×16 = 256 بت */
export async function computeDHashHex(blob: Blob): Promise<string> {
  const cols = 17;
  const rows = 16;
  const data = await drawBlobToCanvas(blob, cols, rows);

  const gray: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    gray.push(Math.round(0.299 * r + 0.587 * g + 0.114 * b));
  }

  let bits = "";
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols - 1; x++) {
      bits += gray[y * cols + x] >= gray[y * cols + x + 1] ? "1" : "0";
    }
  }

  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).padEnd(4, "0"), 2).toString(16);
  }
  return hex;
}

export function hammingDistanceHex(a: string, b: string): number {
  let dist = 0;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = parseInt(a[i] ?? "0", 16) ^ parseInt(b[i] ?? "0", 16);
    // عدد البتات الفردية في النوربل (0-15)
    dist += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return dist;
}

export async function hashBlob(blob: Blob): Promise<{ bytesHash: string; dHash: string }> {
  const bytes = await blobToBytes(blob);
  const bytesHash = fnv1a64Hex(bytes);
  const dHash = await computeDHashHex(blob);
  return { bytesHash, dHash };
}

/* ---------- قراءة شيت المنتجات ---------- */

interface RawMedia {
  extension?: string;
  base64?: string;
  buffer?: unknown;
}

function mediaToImage(media: RawMedia): { blob: Blob; extension: string; bytes: Uint8Array } | null {
  const extension = String(media.extension ?? "png").toLowerCase();
  let bytes: Uint8Array | null = null;

  const buffer = media.buffer;
  if (buffer instanceof Uint8Array) {
    bytes = buffer;
  } else if (buffer instanceof ArrayBuffer) {
    bytes = new Uint8Array(buffer);
  } else if (ArrayBuffer.isView(buffer as ArrayBufferView)) {
    const view = buffer as ArrayBufferView;
    bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  if (!bytes && media.base64) {
    const bin = atob(media.base64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  }

  if (!bytes || bytes.length === 0) return null;
  const blob = new Blob([bytes as BlobPart], { type: extensionToMime(extension) });
  return { blob, extension, bytes };
}

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
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    worker
  );
  await Promise.all(workers);
  return results;
}

/**
 * يقرأ الشيت ويستخرج:
 *  - صفوف المنتجات (الاسم، السعر، مرجع الصورة)
 *  - الصور المدمجة (gif/png/jpeg) الملاصقة لكل صف + بصمتها
 */
export async function parseSheetFile(
  fileBuffer: ArrayBuffer,
  onProgress?: ProgressFn,
  preferExistingSku = true
): Promise<SheetProductRow[]> {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer);
    console.log("Workbook loaded, worksheets:", workbook.worksheets.length);

    const rows: SheetProductRow[] = [];
    const images: EmbeddedSheetImage[] = [];

    for (const worksheet of workbook.worksheets) {
      const headers: string[] = [];
      worksheet.getRow(1).eachCell((cell) => {
        headers[Number(cell.col) - 1] = readCellText(cell).toLowerCase();
      });

      const nameCandidates = headers
        .map((header, index) => ({ header: header.trim(), index }))
        .filter(({ header }) =>
          /name|title|اسم|منتج/i.test(header) && !/sku|code|كود|رمز/i.test(header)
        );
      const nameColumn = nameCandidates.find(({ header }) =>
        /^(?:product\s*)?(?:name|title)|^(?:اسم\s*)?(?:المنتج|الصنف)$/i.test(header)
      )?.index ?? nameCandidates[0]?.index ?? -1;
      const priceColumn = findSalePriceColumn(headers);
      const imageColumn = headers.findIndex((h) => /img|صورة|صوره|gif|picture|image/i.test(h));
      const linkColumn = headers.findIndex((h) => /link|رابط|url|href|noon/i.test(h));
      const detectedSkuColumn = headers.findIndex((h) => /sku|كود|رمز/i.test(h));
      const skuColumn = preferExistingSku && detectedSkuColumn >= 0
        ? detectedSkuColumn
        : -1;

      console.log("Columns found - name:", nameColumn, "price:", priceColumn, "image:", imageColumn, "link:", linkColumn, "sku:", skuColumn, "preferExistingSku:", preferExistingSku);

      // الصور المدمجة: نحدد رقم الصف من موضع الـ anchor
      let worksheetImages: Array<{
        imageId: number;
        tlRow: number;
        tlCol: number;
      }> = [];
      try {
        worksheetImages = worksheet
          .getImages()
          .map((img) => {
            const tl = (img.range as unknown as { tl?: { row?: number; col?: number } })?.tl;
            if (!tl || typeof tl.row !== "number") return null;
            return {
              imageId: Number(img.imageId),
              tlRow: Math.round(tl.row) + 1,
              tlCol: Math.round(tl.col ?? 0),
            };
          })
          .filter((v): v is NonNullable<typeof v> => v !== null && v.tlRow >= 2);
        console.log("Images found in worksheet:", worksheetImages.length);
      } catch (err) {
        console.error("Error getting worksheet images:", err);
        worksheetImages = [];
      }

      const mediaList = worksheetImages.map((info) => {
        try {
          const media = workbook.getImage(info.imageId) as unknown as RawMedia | undefined;
          return { info, media };
        } catch (err) {
          console.error("Error getting image", info.imageId, err);
          return { info, media: undefined };
        }
      });

      // جمع الصور المحتملة لكل صف
      const imageByRow = new Map<number, EmbeddedSheetImage>();
      for (const { info, media } of mediaList) {
        if (!media) continue;
        try {
          const converted = mediaToImage(media);
          if (!converted) continue;
          const imageInfo: EmbeddedSheetImage = {
            id: String(info.imageId),
            sheetRow: info.tlRow,
            extension: converted.extension,
            blob: converted.blob,
            bytesHash: fnv1a64Hex(converted.bytes),
            dHash: "", // سيتم حسابها لاحقاً
          };
          images.push(imageInfo);
          if (!imageByRow.has(info.tlRow)) {
            imageByRow.set(info.tlRow, imageInfo);
          }
        } catch (err) {
          console.error("Error processing media:", err);
        }
      }

      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber < 2) return;
        const productName = nameColumn >= 0 ? readCellText(row.getCell(nameColumn + 1)) : "";
        const rawPrice = priceColumn >= 0 ? readCellText(row.getCell(priceColumn + 1)) : "";
        const price = extractSalePriceFromText(rawPrice) || rawPrice;
        const imageRef = imageColumn >= 0 ? readCellText(row.getCell(imageColumn + 1)) : "";
        let link = normalizeLink(linkColumn >= 0 ? readCellText(row.getCell(linkColumn + 1)) : "");
        const sku = normalizeSkuValue(skuColumn >= 0 ? readCellText(row.getCell(skuColumn + 1)) : "");

        if (!/^https?:\/\//i.test(link)) {
          // فحص شامل: ابحث عن أي رابط في كل خلايا الصف
          // (يدعم صيغ HYPERLINK والروابط بدون https والروابط في أي عمود)
          row.eachCell({ includeEmpty: true }, (cell) => {
            if (/^https?:\/\//i.test(link)) return;
            const t = readCellText(cell);
            const m = t.match(/\b(?:https?:\/\/|www\.)?noon\.com\/[^\s"'<>]+/i);
            if (m) {
              link = m[0].replace(/[),.;]+$/, "");
              link = normalizeLink(link);
            }
          });
        }

        if (productName || price || imageRef || link || sku || imageByRow.has(rowNumber)) {
          rows.push({
            sheetRow: rowNumber,
            productName,
            price,
            sku,
            imageRef,
            link,
            image: imageByRow.get(rowNumber) ?? null,
          });
        }
      });

      console.log("Total rows parsed:", rows.length);
    }

    // حساب البصمة الإدراكية لكل صورة مُدمجة - مع timeout
    let done = 0;
    const computeWithTimeout = async (img: EmbeddedSheetImage) => {
      try {
        const timeoutPromise = new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout حساب البصمة الإدراكية")), 5000)
        );
        const dHashPromise = computeDHashHex(img.blob);
        const dHash = await Promise.race([dHashPromise, timeoutPromise]);
        img.dHash = dHash;
      } catch (err) {
        console.error("Error computing dHash for image", img.id, err);
        img.dHash = ""; // فارغ إذا فشل
      }
      done++;
      onProgress?.(done, Math.max(images.length, 1), "تحليل الصور المدمجة في الشيت...");
    };

    await mapWithConcurrency(images, CONCURRENCY, computeWithTimeout);

    console.log("Sheet parsing complete, returning", rows.length, "rows");
    return rows;
  } catch (err) {
    console.error("Fatal error in parseSheetFile:", err);
    throw new Error(`فشل معالجة الشيت: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** قراءة صور الـ ZIP + حساب بصمتها */
export async function loadZipImages(
  zipBuffer: ArrayBuffer,
  onProgress?: ProgressFn
): Promise<ZipImageEntry[]> {
  const JSZipMod = (await import("jszip")).default;
  const zip = await JSZipMod.loadAsync(zipBuffer);

  const entries = Object.entries(zip.files).filter(
    ([name, entry]) =>
      !entry.dir && /\.(jpg|jpeg|png|webp|gif|avif|bmp|tiff)$/i.test(name)
  );

  if (entries.length === 0) return [];

  const blobs: { name: string; extension: string; blob: Blob }[] = [];
  for (const [name, entry] of entries) {
    const blob = await entry.async("blob");
    const extension = name.split(".").pop()?.toLowerCase() || "jpg";
    blobs.push({ name, extension, blob });
  }

  let done = 0;
  const images = await mapWithConcurrency(
    blobs,
    CONCURRENCY,
    async ({ name, extension, blob }) => {
      const { bytesHash, dHash } = await hashBlob(blob);
      done++;
      onProgress?.(done, Math.max(blobs.length, 1), "تحليل صور الـ ZIP...");
      return { name, extension, blob, bytesHash, dHash };
    }
  );

  return images;
}

/* ---------- المطابقة ---------- */

/**
 * يطابق كل صف منتج في الشيت مع أفضل صورة مطابقة من الـ ZIP
 * الأولوية: تطابق اسم المنتج مع اسم الصورة ← تطابق الصورة المدمجة كحل احتياطي
 */
export function matchRowsToImages(
  rows: SheetProductRow[],
  zipImages: ZipImageEntry[]
): MatchAssignment[] {
  const used = new Set<number>();

  return rows.map((row): MatchAssignment => {
    if (zipImages.length === 0) {
      return { zipIndex: null, distance: Infinity };
    }

    const rowNames = [normalizeProductName(row.productName)].filter(Boolean);
    const compactRowNames = rowNames.map(compactProductName).filter(Boolean);
    if (rowNames.length > 0) {
      const nameMatch = zipImages.findIndex((zip, index) => {
        if (used.has(index)) return false;
        const imageName = normalizeProductName(basename(zip.name));
        const compactImageName = compactProductName(basename(zip.name));
        if (rowNames.includes(imageName) || compactRowNames.includes(compactImageName)) return true;
        return compactRowNames.some((name) =>
          name.length >= 8 && (compactImageName.includes(name) || name.includes(compactImageName))
        );
      });
      if (nameMatch >= 0) {
        used.add(nameMatch);
        return { zipIndex: nameMatch, distance: 0 };
      }
    }

    if (!row.image) return { zipIndex: null, distance: Infinity };

    let bestIndex: number | null = null;
    let bestScore = Infinity;

    for (let j = 0; j < zipImages.length; j++) {
      if (used.has(j)) continue;
      const zip = zipImages[j];
      let score = Infinity;

      if (row.image.bytesHash && zip.bytesHash && row.image.bytesHash === zip.bytesHash) {
        score = 0; // بايتات متطابقة تماماً
      } else if (row.image.dHash && zip.dHash) {
        const dist = hammingDistanceHex(row.image.dHash, zip.dHash);
        score = 1 + dist; // يتأكد أن التطابق الدقيق له الأسبقية دائماً
      }

      if (score < bestScore) {
        bestScore = score;
        bestIndex = j;
      }
    }

    if (bestIndex !== null) {
      const distance = bestScore === 0 ? 0 : bestScore - 1;
      if (bestScore === 0 || distance <= MAX_DHASH_DIST) {
        used.add(bestIndex);
        return { zipIndex: bestIndex, distance };
      }
    }

    return { zipIndex: null, distance: Infinity };
  });
}

/**
 * مفتاح تجميع صفوف المنتج: الصفوف المتتالية التي تنتمي لنفس المنتج
 * (نفس الـ SKU المقروء من الشيت أو نفس اسم المنتج) تتشارك نفس الـ SKU الأساسي
 * وتحصل الصور المتكررة على لواحق (2) و (3) وهكذا.
 */
function rowGroupKey(row: SheetProductRow): string {
  const sku = normalizeSkuValue(row.sku);
  if (sku) return `sku:${sku.toUpperCase()}`;
  const name = row.productName.trim().toLowerCase().replace(/\s+/g, " ");
  if (name) return `name:${name}`;
  return ""; // صف بدون اسم أو SKU = منتج مستقل
}

function imageNameKey(name: string): string {
  return compactProductName(basename(name));
}

interface RowGroupInfo {
  sku: string; // الـ SKU الأساسي للمنتج
  suffix: string; // "" لأول صورة، "_1" للتانية، "_2" للتالتة...
}

/**
 * حساب الـ SKU الأساسي واللاحقة لكل صف:
 *  - الصفوف المتتالية لنفس المنتج (نفس المفتاح) تتشارك نفس الـ SKU.
 *  - أول صورة تأخذ الـ SKU كما هو، والتانية SKU (2)، والتالتة SKU (3) ...
 *  - الـ SKU الأساسي يُقرأ من عمود SKU في الشيت، وإن لم يوجد يتم توليده
 *    بالتسلسل بدءاً من startSku لكل منتج (وليس لكل صورة).
 */
function computeRowGroupInfos(
  rows: SheetProductRow[],
  startSku: string
): RowGroupInfo[] {
  const infos: RowGroupInfo[] = [];
  let groupIndex = -1;
  let prevKey: string | null = null;
  let imageNumberInGroup = 0;

  for (const row of rows) {
    const key = rowGroupKey(row);
    if (key && key === prevKey) {
      imageNumberInGroup++; // صورة إضافية لنفس المنتج
    } else {
      groupIndex++;
      imageNumberInGroup = 0;
      prevKey = key;
    }

    const sheetSku = normalizeSkuValue(row.sku);
    const baseSku = sheetSku || generateSku(startSku.trim(), groupIndex);
    const suffix = imageNumberInGroup > 0 ? `_${imageNumberInGroup}` : "";
    infos.push({ sku: baseSku, suffix });
  }

  return infos;
}

/** بناء نتائج التسمية النهائية (SKU لكل منتج + لواحق _1/_2 لصوره المتعددة) */
export function getUniqueSkuOptions(rows: SheetProductRow[]): Array<{ sku: string; count: number }> {
  const bySku = new Map<string, number>();

  for (const row of rows) {
    const sku = normalizeSkuValue(row.sku);
    if (!sku) continue;
    bySku.set(sku, (bySku.get(sku) ?? 0) + 1);
  }

  return [...bySku.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map(([sku, count]) => ({ sku, count }));
}

export function filterRowsBySelectedSkus(
  rows: SheetProductRow[],
  selectedSkus: Set<string>
): SheetProductRow[] {
  if (selectedSkus.size === 0) return [];

  const normalized = new Set(
    [...selectedSkus]
      .map((sku) => sku.trim().toUpperCase())
      .filter(Boolean)
  );

  return rows.filter((row) => {
    const sku = normalizeSkuValue(row.sku);
    return normalized.has(sku);
  });
}

export function buildResults(
  rows: SheetProductRow[],
  matches: MatchAssignment[],
  zipImages: ZipImageEntry[],
  startSku: string
): SheetSkuMatchResult[] {
  const groupInfos = computeRowGroupInfos(rows, startSku);
  const expandedRows: Array<{ rowIndex: number; zipIndex: number | null }> = [];
  const usedZipIndexes = new Set<number>();
  const expandedProductKeys = new Set<string>();

  rows.forEach((row, rowIndex) => {
    const matchedZipIndex = matches[rowIndex]?.zipIndex ?? null;
    const rowProductKey = compactProductName(row.productName);
    if (matchedZipIndex !== null && zipImages[matchedZipIndex]) {
      const matchedKey = imageNameKey(zipImages[matchedZipIndex].name);
      if (matchedKey && !expandedProductKeys.has(matchedKey)) {
        const relatedIndexes = zipImages
          .map((zip, index) => ({ zip, index }))
          .filter(({ zip, index }) => !usedZipIndexes.has(index) && imageNameKey(zip.name) === matchedKey)
          .map(({ index }) => index);
        for (const zipIndex of relatedIndexes.length > 0 ? relatedIndexes : [matchedZipIndex]) {
          expandedRows.push({ rowIndex, zipIndex });
          usedZipIndexes.add(zipIndex);
        }
        expandedProductKeys.add(matchedKey);
        return;
      }
      if (usedZipIndexes.has(matchedZipIndex)) return;
    }

    if (rowProductKey && expandedProductKeys.has(rowProductKey)) return;
    expandedRows.push({ rowIndex, zipIndex: null });
  });

  const outputNameKeys = expandedRows.map(({ rowIndex, zipIndex }) => {
    const row = rows[rowIndex];
    if (zipIndex !== null && zipImages[zipIndex]) return imageNameKey(zipImages[zipIndex].name);
    return compactProductName(row.productName) || (row.image ? imageNameKey(row.imageRef) : "");
  });
  const imageNameCounts = new Map<string, number>();
  for (const name of outputNameKeys) {
    if (name) imageNameCounts.set(name, (imageNameCounts.get(name) ?? 0) + 1);
  }
  const imageNameOccurrences = new Map<string, number>();
  const imageNameSkus = new Map<string, string>();

  return expandedRows.map(({ rowIndex, zipIndex }, resultIndex) => {
    const row = rows[rowIndex];
    const { sku, suffix } = groupInfos[rowIndex];
    const zip = zipIndex !== null && zipImages[zipIndex] ? zipImages[zipIndex] : null;
    const outputNameKey = outputNameKeys[resultIndex];
    const baseSku = outputNameKey
      ? (imageNameSkus.get(outputNameKey) ?? normalizeSkuValue(sku))
      : normalizeSkuValue(sku);
    if (outputNameKey && !imageNameSkus.has(outputNameKey)) {
      imageNameSkus.set(outputNameKey, baseSku);
    }
    const normalizedSku = baseSku;
    let occurrence = 0;
    if (outputNameKey) {
      occurrence = (imageNameOccurrences.get(outputNameKey) ?? 0) + 1;
      imageNameOccurrences.set(outputNameKey, occurrence);
    }
    const duplicateSuffix = outputNameKey && (imageNameCounts.get(outputNameKey) ?? 0) > 1
      ? `_${occurrence}`
      : suffix;
    const outputBaseName = normalizeSkuFileName(normalizedSku);

    if (zip) {
      const ext = zip.extension;
      return {
        index: resultIndex + 1,
        sku: normalizedSku,
        productName: row.productName || "—",
        price: row.price || "—",
        link: row.link || "",
        originalName: basename(zip.name),
        newName: `${outputBaseName}${duplicateSuffix}.${ext}`,
        source: "zip",
        imageBlob: zip.blob,
        extension: ext,
      };
    }

    if (row.image) {
      const ext = row.image.extension;
      return {
        index: resultIndex + 1,
        sku: normalizedSku,
        productName: row.productName || "—",
        price: row.price || "—",
        link: row.link || "",
        originalName: row.imageRef || "صورة مدمجة",
        newName: `${outputBaseName}${duplicateSuffix}.${ext}`,
        source: "embedded",
        imageBlob: row.image.blob,
        extension: ext,
      };
    }

    return {
      index: resultIndex + 1,
      sku: normalizedSku,
      productName: row.productName || "—",
      price: row.price || "—",
      link: row.link || "",
      originalName: row.imageRef || "—",
      newName: `${outputBaseName}${duplicateSuffix}.img`,
      source: "none",
      imageBlob: null,
      extension: "img",
    };
  });
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

/** بناء ملف Excel مع خانة SKU والصورة مدمجة لكل منتج */
export async function buildExcel(
  results: SheetSkuMatchResult[]
): Promise<Blob> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("المنتجات", {
    views: [{ rightToLeft: true }],
  });

  worksheet.columns = [
    { header: "م", key: "index", width: 6 },
    { header: "SKU", key: "sku", width: 20 },
    { header: "اسم المنتج", key: "name", width: 45 },
    { header: "السعر", key: "price", width: 14 },
    { header: "الرابط", key: "link", width: 50 },
    { header: "اسم الصورة قبل التسمية", key: "original", width: 40 },
    { header: "اسم الصورة بعد التسمية", key: "renamed", width: 40 },
    { header: "الصورة", key: "image", width: 25 },
  ];

  worksheet.getRow(1).font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1a56db" },
  };
  worksheet.getRow(1).alignment = { horizontal: "center", vertical: "middle" };
  worksheet.getRow(1).height = 25;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const row = worksheet.addRow({
      index: r.index,
      sku: r.sku,
      name: r.productName || "—",
      price: r.price || "—",
      link: normalizeLink(r.link) || "—",
      original: r.originalName,
      renamed: r.newName,
      image: "",
    });
    const link = normalizeLink(r.link);
    if (link) {
      worksheet.getCell(`E${i + 2}`).value = { text: link, hyperlink: link } as ExcelJS.CellValue;
    }
    row.alignment = { vertical: "middle", horizontal: "right" };
    row.height = 60;
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const blob = r.imageBlob;
    if (!blob) {
      worksheet.getCell(`H${i + 2}`).value = "لا توجد صورة";
      continue;
    }
    const ext = excelExtension(r.extension);
    if (!ext) continue;
    try {
      const base64 = await blobToBase64(blob);
      const imageId = workbook.addImage({ base64, extension: ext });
      worksheet.addImage(imageId, {
        tl: { col: 7, row: i + 1 } as ExcelJS.Anchor,
        br: { col: 8, row: i + 2 } as ExcelJS.Anchor,
      });
    } catch {
      worksheet.getCell(`H${i + 2}`).value = "تعذّر دمج الصورة";
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/** بناء ملف ZIP باسم SKU لكل صورة مطابقة + خريطة التسمية CSV */
export async function buildZip(results: SheetSkuMatchResult[]): Promise<Blob> {
  const JSZipMod = (await import("jszip")).default;
  const zip = new JSZipMod();

  const matched = results.filter((r) => r.source === "zip" && r.imageBlob);
  for (const r of matched) {
    zip.file(r.newName, r.imageBlob as Blob);
  }

  const csvContent = [
    "\uFEFFم,SKU,اسم المنتج,السعر,الرابط,اسم الصورة قبل التسمية,اسم الصورة بعد التسمية",
    ...results.map(
      (r) =>
        `${r.index},${r.sku},"${(r.productName || "").replace(/"/g, '""')}",${(r.price || "").replace(/"/g, '""')},"${(r.link || "").replace(/"/g, '""')}","${(r.originalName || "").replace(/"/g, '""')}","${(r.newName || "").replace(/"/g, '""')}"`
    ),
  ].join("\n");
  zip.file("خريطة-التسمية.csv", csvContent);

  const content = await zip.generateAsync({ type: "blob" });
  return content;
}