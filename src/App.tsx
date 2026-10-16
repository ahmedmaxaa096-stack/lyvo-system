import { useState, useRef } from "react";
import {
  Link2,
  Loader2,
  Image as ImageIcon,
  FileSpreadsheet,
  FileArchive,
  Key,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Trash2,
  Sparkles,
  ShoppingBag,
  Upload,
  FileUp,
  Camera,
  Database,
  Images,
  FolderArchive,
  FileJson,
} from "lucide-react";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { scrapeProduct, type ScrapedProduct } from "@/lib/scraper";
import { extractSalePriceFromText, findSalePriceColumn, normalizeSkuValue } from "@/lib/imageSku";
import {
  exportToExcel,
  exportToZip,
  type ExportProgress,
} from "@/lib/exporters";
import SheetSkuTool from "@/components/SheetSkuTool";
import SmartDescriptionTool from "@/components/SmartDescriptionTool";
import BarcodeLookupTool from "@/components/BarcodeLookupTool";
import SkuImageRenamerTool from "@/components/SkuImageRenamerTool";
import SiteExtractorTool from "@/components/SiteExtractorTool";
import type { SiteProduct } from "@/lib/siteScraper";

type ImportedProduct = {
  url: string;
  productName: string;
  productNameAr?: string;
  productNameEn?: string;
  descriptionEn?: string;
  imageUrl?: string;
  price: number | null;
  sku?: string;
};

type ZipImage = { name: string; blob: Blob; extension: string };

type ProductState = ScrapedProduct & {
  status: "pending" | "loading" | "done" | "error";
  error?: string;
};

function App() {
  const [activeSection, setActiveSection] = useState<
    "extractor" | "barcode" | "sku-renamer" | "sheet-sku" | "smart-descriptions"
  >("extractor");
  const [links, setLinks] = useState<ImportedProduct[]>([]);
  const [fileName, setFileName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [skuPrefix, setSkuPrefix] = useState("");
  const [startSku, setStartSku] = useState("");
  const [useExistingSku, setUseExistingSku] = useState(true);
  const [mode, setMode] = useState<"images" | "data" | "full">("full");
  const [products, setProducts] = useState<ProductState[]>([]);
  const [processing, setProcessing] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [exportingZip, setExportingZip] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(
    null
  );
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [zipImages, setZipImages] = useState<ZipImage[]>([]);
  const [zipFileName, setZipFileName] = useState("");
  const [renamingZip, setRenamingZip] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setGlobalError(null);

    try {
      const buffer = await file.arrayBuffer();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);

      if (workbook.worksheets.length === 0) {
        setGlobalError("ملف Excel فارغ");
        return;
      }

      const importedProducts: ImportedProduct[] = [];

      const containsArabic = (value: string): boolean => /[\u0600-\u06FF]/.test(value);
      const getSkuColumn = (headers: string[]): number => {
        const detected = headers.findIndex((header) => /sku|كود|رمز/i.test(header));
        if (detected >= 0) return detected;
        return headers.length >= 2 ? 1 : -1;
      };
      const extractSkuFromRow = (row: ExcelJS.Row, preferredColumn: number): string => {
        const preferredValue = preferredColumn >= 0 ? getCellText(row.getCell(preferredColumn + 1)) : "";
        const preferredNormalized = normalizeSkuValue(preferredValue);
        if (/^[A-Za-z]{4}\d+$/i.test(preferredNormalized)) return preferredNormalized;

        const candidates: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell) => {
          const text = getCellText(cell);
          if (!text) return;
          const normalized = normalizeSkuValue(text);
          if (/^[A-Za-z]{4}\d+$/i.test(normalized)) {
            candidates.push(normalized);
          }
        });

        if (candidates.length === 0) return preferredNormalized || "";
        return candidates[0] || preferredNormalized || "";
      };
      const buildBilingualNames = (nameC: string, nameD: string) => {
        const valueC = nameC.trim();
        const valueD = nameD.trim();
        const primaryName = valueC || valueD;

        if (!valueC && !valueD) {
          return { productName: primaryName, productNameAr: "", productNameEn: "" };
        }

        if (valueC && valueD) {
          const cIsArabic = containsArabic(valueC);
          const dIsArabic = containsArabic(valueD);

          return {
            productName: cIsArabic ? valueC : valueD,
            productNameAr: cIsArabic ? valueC : dIsArabic ? valueD : valueC || valueD,
            productNameEn: cIsArabic ? valueD : dIsArabic ? valueC : valueD || valueC,
          };
        }

        const onlyValue = valueC || valueD;
        const onlyIsArabic = containsArabic(onlyValue);

        return {
          productName: onlyValue,
          productNameAr: onlyIsArabic ? onlyValue : "",
          productNameEn: onlyIsArabic ? "" : onlyValue,
        };
      };

      const getCellText = (cell: ExcelJS.Cell): string => {
        const hyperlink = (cell as ExcelJS.Cell & { hyperlink?: string }).hyperlink;
        if (hyperlink) return hyperlink.trim();
        const value = cell.value;
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
      };

      for (const [worksheetIndex, worksheet] of workbook.worksheets.entries()) {
        const headers: string[] = [];
        worksheet.getRow(1).eachCell((cell) => {
          headers[Number(cell.col) - 1] = getCellText(cell).toLowerCase();
        });

        const nameColumn = headers.findIndex((header) => /name|product|اسم|منتج/i.test(header));
        const priceColumn = findSalePriceColumn(headers);
        const skuColumn = getSkuColumn(headers);
        const englishDescriptionColumn = headers.findIndex((header) =>
          /(?:description|desc).*(?:english|\ben\b)|(?:english|\ben\b).*(?:description|desc)|(?:الوصف|وصف).*(?:الإنجليزي|إنجليزي|انجليزي)|(?:الإنجليزي|إنجليزي|انجليزي).*(?:الوصف|وصف)/i.test(header)
        );
        const descriptionColumn = englishDescriptionColumn >= 0
          ? englishDescriptionColumn
          : headers.findIndex((header) => /description|desc|الوصف|وصف/i.test(header));
        const imageColumn = headers.findIndex((header) => /image|img|picture|photo|صورة|صوره/i.test(header));

        worksheet.eachRow((row, rowNumber) => {
          if (rowNumber === 1) return;

          const rowProducts: ImportedProduct[] = [];
          const collectLinks = (text: string): string[] => {
            const links: string[] = [];
            for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
              const normalized = m[0].replace(/[),.;]+$/, "");
              if (normalized && !links.includes(normalized)) links.push(normalized);
            }
            for (const m of text.matchAll(/(?:www\.)?noon\.com\/[^\s"'<>]+/gi)) {
              const normalized = `https://${m[0].replace(/[),.;]+$/, "")}`;
              if (!links.includes(normalized)) links.push(normalized);
            }
            return links;
          };

          const columnCName = getCellText(row.getCell(3));
          const columnDName = getCellText(row.getCell(4));
          const columnALUrl = getCellText(row.getCell(38));
          const preferredNames = buildBilingualNames(columnCName, columnDName);
          const fallbackName = nameColumn >= 0 ? getCellText(row.getCell(nameColumn + 1)) : preferredNames.productName;
          const rowName = fallbackName || preferredNames.productName;
          const rowDescription = descriptionColumn >= 0 ? getCellText(row.getCell(descriptionColumn + 1)) : "";
          const descriptionEn = /[\u0600-\u06FF]/.test(rowDescription) ? "" : rowDescription;
          const imageCellValue = imageColumn >= 0 ? getCellText(row.getCell(imageColumn + 1)) : "";
          const imageCandidates = collectLinks(imageCellValue);
          row.eachCell({ includeEmpty: true }, (cell) => {
            for (const url of collectLinks(getCellText(cell))) {
              if (getDirectImageProduct(url) && !imageCandidates.includes(url)) imageCandidates.push(url);
            }
          });
          const imageUrl = imageCandidates.find((url) => Boolean(getDirectImageProduct(url))) || "";
          const rowSku = useExistingSku ? extractSkuFromRow(row, skuColumn) : "";
          const directUrlCandidates = collectLinks(columnALUrl).length > 0
            ? collectLinks(columnALUrl)
            : [];
          const resolvedUrlCandidates = directUrlCandidates.length > 0
            ? directUrlCandidates.filter((url) => !getDirectImageProduct(url))
            : (() => {
                const collected: string[] = [];
                row.eachCell({ includeEmpty: true }, (cell) => {
                  const cellText = getCellText(cell);
                  for (const normalizedUrl of collectLinks(cellText)) {
                    if (!getDirectImageProduct(normalizedUrl) && !collected.includes(normalizedUrl)) collected.push(normalizedUrl);
                  }
                });
                return collected;
              })();

          for (const normalizedUrl of resolvedUrlCandidates) {
            const rawPrice = priceColumn >= 0 ? getCellText(row.getCell(priceColumn + 1)) : "";
            const salePriceText = extractSalePriceFromText(rawPrice);
            const parsedPrice = salePriceText ? Number.parseFloat(salePriceText) : null;
            rowProducts.push({
              url: normalizedUrl,
              productName: rowName,
              productNameAr: preferredNames.productNameAr || rowName,
              productNameEn: preferredNames.productNameEn || (!containsArabic(rowName) ? rowName : ""),
              descriptionEn,
              imageUrl: imageUrl || undefined,
              price: Number.isFinite(parsedPrice) ? parsedPrice : null,
              sku: rowSku || undefined,
            });
          }

          if (resolvedUrlCandidates.length === 0 && (rowName || columnALUrl || imageUrl)) {
            const rawPrice = priceColumn >= 0 ? getCellText(row.getCell(priceColumn + 1)) : "";
            const salePriceText = extractSalePriceFromText(rawPrice);
            const parsedPrice = salePriceText ? Number.parseFloat(salePriceText) : null;
            rowProducts.push({
              url: columnALUrl || imageUrl || "",
              productName: rowName,
              productNameAr: preferredNames.productNameAr || rowName,
              productNameEn: preferredNames.productNameEn || (!containsArabic(rowName) ? rowName : ""),
              descriptionEn,
              imageUrl: imageUrl || undefined,
              price: Number.isFinite(parsedPrice) ? parsedPrice : null,
              sku: rowSku || undefined,
            });
          }
          importedProducts.push(...rowProducts);
        });
      }

      if (importedProducts.length === 0) {
        setGlobalError("لم يتم العثور على روابط صالحة في الملف");
        return;
      }

      setLinks(importedProducts);
      setFileName(file.name);
    } catch (err) {
      setGlobalError(
        `فشل قراءة الملف: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const isValidSkuPattern = (value: string): boolean => {
    const cleaned = normalizeSkuValue(value || "");
    return /^[A-Za-z]{4}(\d+)?$/.test(cleaned);
  };

  const generateSku = (start: string, index: number): string => {
    const sanitized = normalizeSkuValue(start || "");
    const match = sanitized.match(/^([A-Za-z]{4})(\d+)$/);
    if (!match) {
      const letters = sanitized.slice(0, 4).toUpperCase() || "ABCD";
      return `${letters}${String(index + 1).padStart(3, "0")}`;
    }
    const letters = match[1].toUpperCase();
    const numStr = match[2];
    const num = parseInt(numStr, 10) + index;
    return `${letters}${String(num).padStart(numStr.length, "0")}`;
  };

  const matchesSkuPrefix = (value: string, prefix: string): boolean => {
    if (!prefix) return true;
    const normalizedValue = normalizeSkuValue(value || "");
    const normalizedPrefix = normalizeSkuValue(prefix || "");
    if (!normalizedValue || !normalizedPrefix) return false;
    return normalizedValue.startsWith(normalizedPrefix);
  };

  const isGoogleImageHost = (hostname: string): boolean =>
    /(^|\.)gstatic\.com$/i.test(hostname) || /(^|\.)googleusercontent\.com$/i.test(hostname);

  const getDirectImageProduct = (url: string): Partial<ScrapedProduct> | null => {
    try {
      const parsedUrl = new URL(url);
      const pathname = parsedUrl.pathname.toLowerCase();
      // روابط Google للصور تُقدَّم بدون امتداد في المسار (encrypted-tbn0.gstatic.com/images?q=tbn:...)
      const isGoogleImage = isGoogleImageHost(parsedUrl.hostname);
      const isImage =
        /\.(jpe?g|jfif|png|webp|gif|avif|bmp|svg)$/i.test(pathname) || isGoogleImage;
      if (!isImage) return null;

      let fileName = decodeURIComponent(parsedUrl.pathname.split("/").pop() || "")
        .replace(/\.[^.]+$/, "")
        .replace(/[-_]+/g, " ")
        .trim();
      // لروابط Google لا نستنتج الاسم من المسار (مثل "images") بل نتركه فارغاً ليُؤخذ
      // اسم المنتج من ملف الإكسل (nameColumn) إن وُجد.
      if (isGoogleImage) fileName = "";

      return {
        product_name: fileName,
        image_url: url,
        image_url_high: url,
      };
    } catch {
      return null;
    }
  };

  // يعرض صور Google عبر الوكيل المحلي حتى تُجلب دائماً من الخادم (يتجنب قفل المتصفح للروابط المباشرة)
  const getImageDisplayUrl = (url: string): string => {
    try {
      const hostname = new URL(url).hostname;
      if (isGoogleImageHost(hostname)) {
        return `/api/image-proxy?url=${encodeURIComponent(url)}`;
      }
    } catch {
      // استخدم الرابط مباشرة إن لم يمكن تحليله
    }
    return url;
  };

  const getBestImageForDisplay = (product: ProductState): string =>
    getImageDisplayUrl(product.images?.[0] || product.image_url_high || product.image_url || "");

  const handleProcess = async () => {
    if (links.length === 0) {
      setGlobalError("من فضلك ارفع ملف Excel يحتوي على روابط");
      return;
    }

    const prefix = skuPrefix.trim().toUpperCase();
    const filteredLinks = prefix
      ? links.filter((product) => matchesSkuPrefix(product.sku || "", prefix))
      : links;

    if (filteredLinks.length === 0) {
      setGlobalError(prefix ? `لا توجد منتجات تبدأ بـ ${prefix} في الـ SKU` : "لا توجد روابط للمعالجة");
      return;
    }

    if (!useExistingSku && !isValidSkuPattern(startSku.trim())) {
      setGlobalError("من فضلك أدخل SKU صحيح (4 أحرف أو 4 أحرف + أرقام، مثال: ABCD أو ABCD001)");
      return;
    }

    setGlobalError(null);
    setProcessing(true);

    const initial: ProductState[] = filteredLinks.map((product, idx) => {
      const fallbackSku = startSku.trim() ? generateSku(startSku.trim(), idx) : "";
      return {
        url: product.url,
        product_name: product.productName || product.productNameEn || product.productNameAr || "",
        price: product.price,
        image_url: "",
        image_url_high: "",
        images: [],
        description_ar: "",
        description_en: "",
        sku: useExistingSku ? (product.sku || fallbackSku) : fallbackSku,
        status: "pending",
      };
    });
    setProducts(initial);
    const processedProducts = initial.map((product) => ({ ...product }));
    let completedCount = 0;
    let lastProductsUpdate = Date.now();

    const processProduct = async (i: number) => {
      processedProducts[i] = { ...processedProducts[i], status: "loading" };

      try {
        const imported = filteredLinks[i];
        const directImage = getDirectImageProduct(imported.imageUrl || imported.url);
        const importedName = imported.productName || "";
        const importedNameIsArabic = /[\u0600-\u06FF]/.test(importedName);
        const sheetNameEn = imported.productNameEn || (!importedNameIsArabic ? importedName : "");
        const hasSheetDetails = Boolean(sheetNameEn && imported.price !== null && imported.descriptionEn);
        const canUseSheetWithoutScraping = hasSheetDetails && (mode === "data" || Boolean(imported.imageUrl));
        const result = canUseSheetWithoutScraping
          ? {
              url: imported.url,
              product_name: sheetNameEn,
              product_name_ar: "",
              product_name_en: sheetNameEn,
              price: imported.price,
              image_url: imported.imageUrl || "",
              image_url_high: imported.imageUrl || "",
              images: imported.imageUrl ? [imported.imageUrl] : [],
              description_ar: "",
              description_en: imported.descriptionEn || "",
              sku: imported.sku || "",
            }
          : mode === "images" && directImage
          ? { ...directImage, images: directImage.image_url ? [directImage.image_url] : [] }
          : await scrapeProduct(
              imported.url,
              apiKey.trim(),
              "",
              imported.price,
              true
            );

        const resultNameIsArabic = /[\u0600-\u06FF]/.test(result.product_name || "");
        const productNameAr = result.product_name_ar ||
          (resultNameIsArabic ? result.product_name : "") ||
          imported.productNameAr ||
          (importedNameIsArabic ? importedName : "");
        const productNameEn = imported.productNameEn ||
          (!importedNameIsArabic ? importedName : "") ||
          result.product_name_en ||
          (result.product_name && !resultNameIsArabic ? result.product_name : "") ||
          "";

        const resolvedImages = mode === "data" ? [] : (result.images && result.images.length > 0
          ? result.images
          : [result.image_url_high || result.image_url || ""]
        ).filter((item): item is string => Boolean(item));

        processedProducts[i] = {
          ...processedProducts[i],
          product_name: productNameEn || result.product_name || importedName || productNameAr || "",
          product_name_ar: productNameAr,
          product_name_en: productNameEn,
          price: imported.price ?? result.price ?? null,
          image_url: mode === "data" ? "" : imported.imageUrl || result.image_url || resolvedImages[0] || "",
          image_url_high: mode === "data" ? "" : imported.imageUrl || result.image_url_high || resolvedImages[0] || result.image_url || "",
          images: mode === "data" ? [] : imported.imageUrl ? [imported.imageUrl] : resolvedImages,
          description_ar: result.description_ar || "",
          description_en: imported.descriptionEn || result.description_en || "",
          status: "done",
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        processedProducts[i] = { ...processedProducts[i], status: "error", error: message };
      }
    };

    const concurrency = 10;
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < filteredLinks.length) {
        const index = nextIndex++;
        await processProduct(index);
        completedCount++;
        const now = Date.now();
        if (completedCount % 25 === 0 || now - lastProductsUpdate >= 100 || completedCount === filteredLinks.length) {
          setProducts([...processedProducts]);
          lastProductsUpdate = now;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, filteredLinks.length) }, worker)
    );

    setProcessing(false);
  };

  const handleExcelExport = async () => {
    const done = products.filter((p) => p.status === "done");
    if (done.length === 0) {
      setGlobalError("لا توجد منتجات جاهزة للتصدير");
      return;
    }
    setGlobalError(null);
    setExportingExcel(true);
    setExportProgress({ current: 0, total: done.length, label: "بدء التصدير..." });
    try {
      await exportToExcel(done, setExportProgress);
    } catch (err) {
      setGlobalError(
        `فشل تصدير Excel: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setExportingExcel(false);
      setExportProgress(null);
    }
  };

  const handleZipExport = async () => {
    const done = products.filter((p) => p.status === "done");
    if (done.length === 0) {
      setGlobalError("لا توجد منتجات جاهزة للتصدير");
      return;
    }
    setGlobalError(null);
    setExportingZip(true);
    setExportProgress({ current: 0, total: done.length, label: "بدء التصدير..." });
    try {
      await exportToZip(done, setExportProgress);
    } catch (err) {
      setGlobalError(
        `فشل تصدير الصور: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setExportingZip(false);
      setExportProgress(null);
    }
  };

  const handleZipUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setGlobalError(null);

    try {
      const buffer = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(buffer);

      const imageEntries = Object.entries(zip.files).filter(
        ([name, entry]) =>
          !entry.dir &&
          /\.(jpg|jpeg|png|webp|gif|avif|bmp|tiff)$/i.test(name)
      );

      if (imageEntries.length === 0) {
        setGlobalError("لم يتم العثور على صور في الملف المضغوط");
        return;
      }

      const images: ZipImage[] = [];
      for (const [name, entry] of imageEntries) {
        const blob = await entry.async("blob");
        const extension = name.split(".").pop()?.toLowerCase() || "jpg";
        images.push({ name, blob, extension });
      }

      setZipImages(images);
      setZipFileName(file.name);
    } catch (err) {
      setGlobalError(
        `فشل قراءة الملف المضغوط: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const handleZipRename = async () => {
    if (zipImages.length === 0) {
      setGlobalError("من فضلك ارفع ملف ZIP يحتوي على صور");
      return;
    }
    if (!isValidSkuPattern(startSku.trim())) {
      setGlobalError("من فضلك أدخل SKU صحيح (4 أحرف أو 4 أحرف + أرقام، مثال: ABCD أو ABCD001)");
      return;
    }

    setGlobalError(null);
    setRenamingZip(true);

    try {
      const zip = new JSZip();
      const nameCounts = new Map<string, number>();
      const nameOccurrences = new Map<string, number>();
      for (const image of zipImages) {
        const baseName = image.name.split(/[\\/]/).pop() || image.name;
        const key = baseName
          .replace(/\.[^.]+$/, "")
          .replace(/\s*(?:\(\d+\)|\[\d+\]|[_-]\s*\d+|\s+\d+)\s*$/i, "")
          .trim()
          .toLowerCase();
        nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
      }

      const nameSkuIndexes = new Map<string, number>();
      let nextSkuIndex = 0;
      zipImages.forEach((image, idx) => {
        const baseName = image.name.split(/[\\/]/).pop() || image.name;
        const key = baseName
          .replace(/\.[^.]+$/, "")
          .replace(/\s*(?:\(\d+\)|\[\d+\]|[_-]\s*\d+|\s+\d+)\s*$/i, "")
          .trim()
          .toLowerCase();
        const occurrence = (nameOccurrences.get(key) ?? 0) + 1;
        nameOccurrences.set(key, occurrence);
        if (!nameSkuIndexes.has(key)) nameSkuIndexes.set(key, nextSkuIndex++);
        const duplicateSuffix = (nameCounts.get(key) ?? 0) > 1
          ? (occurrence === 1 ? "" : ` (${occurrence})`)
          : "";
        const baseSku = generateSku(startSku.trim(), nameSkuIndexes.get(key) ?? idx);
        const newName = `${baseSku}${duplicateSuffix}.${image.extension}`;
        zip.file(newName, image.blob);
      });

      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `renamed-images-${startSku.trim()}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setGlobalError(
        `فشل إعادة تسمية الصور: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setRenamingZip(false);
    }
  };

  const handleClear = () => {
    setProducts([]);
    setLinks([]);
    setFileName("");
    setSkuPrefix("");
    setStartSku("");
    setZipImages([]);
    setZipFileName("");
    setGlobalError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    if (zipInputRef.current) {
      zipInputRef.current.value = "";
    }
  };

  const handleAddSiteLinks = (siteProducts: SiteProduct[], sourceLabel?: string) => {
    void sourceLabel;
    const existing = new Set(links.map((l) => l.url.trim().toLowerCase()));
    const newLinks: ImportedProduct[] = [];
    for (const product of siteProducts) {
      const url = (product.url || "").trim();
      if (!url) continue;
      const key = url.toLowerCase();
      if (existing.has(key)) continue;
      existing.add(key);
      newLinks.push({ url, productName: product.product_name, price: product.price });
    }
    if (newLinks.length === 0) {
      setGlobalError("كل المنتجات المُراد إضافتها موجودة بالفعل في قائمة الاستخراج");
      return;
    }
    setLinks([...links, ...newLinks]);
    setGlobalError(null);
  };

  const doneCount = products.filter((p) => p.status === "done").length;
  const errorCount = products.filter((p) => p.status === "error").length;

  return (
    <div
      dir="rtl"
      className="dashboard-theme min-h-screen text-slate-800"
    >
      {/* Header */}
      <header className="dashboard-header sticky top-0 z-20 border-b backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-rose-700 via-red-900 to-stone-950 rounded-2xl flex items-center justify-center shadow-lg shadow-rose-900/20">
              <ShoppingBag className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-lg sm:text-xl font-bold text-slate-900">
                مستخرج بيانات المنتجات
              </h1>
              <p className="hidden sm:block text-xs text-slate-500">
                مساحة عمل موحدة لإدارة بيانات المنتجات
              </p>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-2 text-xs font-medium text-slate-400 bg-white/60 px-3 py-2 rounded-full border border-slate-200/60">
            <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.65)]" />
            <Sparkles className="w-4 h-4 text-cyan-400" />
            <span>أدوات ذكية للمنتجات</span>
          </div>
        </div>
      </header>

      <div className="dashboard-layout max-w-7xl mx-auto px-4 sm:px-6 py-5 sm:py-7">
        <aside className="dashboard-sidebar" aria-label="القائمة الجانبية للأدوات">
          <div className="sidebar-heading">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-400">مساحة العمل</span>
            <span className="mt-1 block text-sm font-semibold text-slate-800">اختر الأداة</span>
          </div>
          <nav className="sidebar-nav">
            <button
              type="button"
              onClick={() => setActiveSection("extractor")}
              aria-current={activeSection === "extractor" ? "page" : undefined}
              className={`sidebar-nav-button ${activeSection === "extractor" ? "is-active" : ""}`}
            >
              <Link2 className="h-5 w-5 shrink-0" />
              <span><strong>استخراج المنتجات</strong><small>من رابط أو ملف Excel</small></span>
            </button>
            <button
              type="button"
              onClick={() => setActiveSection("barcode")}
              aria-current={activeSection === "barcode" ? "page" : undefined}
              className={`sidebar-nav-button ${activeSection === "barcode" ? "is-active" : ""}`}
            >
              <FileJson className="h-5 w-5 shrink-0" />
              <span><strong>بحث الباركود</strong><small>مطابقة بيانات المنتجات</small></span>
            </button>
            <button
              type="button"
              onClick={() => setActiveSection("sku-renamer")}
              aria-current={activeSection === "sku-renamer" ? "page" : undefined}
              className={`sidebar-nav-button ${activeSection === "sku-renamer" ? "is-active" : ""}`}
            >
              <Images className="h-5 w-5 shrink-0" />
              <span><strong>إعادة تسمية الصور</strong><small>تحديث SKU وملفات الصور</small></span>
            </button>
            <button
              type="button"
              onClick={() => setActiveSection("sheet-sku")}
              aria-current={activeSection === "sheet-sku" ? "page" : undefined}
              className={`sidebar-nav-button ${activeSection === "sheet-sku" ? "is-active" : ""}`}
            >
              <FolderArchive className="h-5 w-5 shrink-0" />
              <span><strong>الشيت والصور</strong><small>مطابقة الصور مع المنتجات</small></span>
            </button>
            <button
              type="button"
              onClick={() => setActiveSection("smart-descriptions")}
              aria-current={activeSection === "smart-descriptions" ? "page" : undefined}
              className={`sidebar-nav-button ${activeSection === "smart-descriptions" ? "is-active" : ""}`}
            >
              <Sparkles className="h-5 w-5 shrink-0" />
              <span><strong>أوصاف ذكية</strong><small>إنشاء الأوصاف عبر AI</small></span>
            </button>
          </nav>
        </aside>

        <main className="dashboard-content min-w-0 flex-1">
        {/* Input Section */}
        {activeSection === "extractor" && <div id="link-extractor" className="dashboard-section card-3d p-5 sm:p-7 mb-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* سحب كل منتجات الموقع */}
                <SiteExtractorTool onAddLinks={handleAddSiteLinks} startSku={startSku} setStartSku={setStartSku} />

            {/* Excel Upload */}
            <div className="lg:col-span-2">
              <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
                <FileSpreadsheet className="w-4 h-4 text-green-600" />
                ملف Excel بالروابط
              </label>

              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={handleFileUpload}
                className="hidden"
              />

              {!fileName ? (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="upload-zone-3d w-full h-40 flex flex-col items-center justify-center gap-3 text-slate-400 cursor-pointer"
                >
                  <Upload className="w-10 h-10" />
                  <span className="text-sm font-medium">
                    اضغط لرفع ملف Excel (.xlsx)
                  </span>
                  <span className="text-xs text-slate-400">
                    يجب أن يحتوي الملف على روابط منتجات في العمود الأول
                  </span>
                </button>
              ) : (
                <div className="upload-zone-3d w-full h-40 border-green-300 bg-green-50 flex flex-col items-center justify-center gap-3">
                  <FileUp className="w-10 h-10 text-green-600" />
                  <span className="text-sm font-semibold text-green-700">
                    {fileName}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="pill-3d text-green-600 bg-green-100">
                      {links.length} رابط
                    </span>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      تغيير الملف
                    </button>
                  </div>
                </div>
              )}

              <p className="text-xs text-slate-400 mt-1.5">
                ارفع ملف Excel يحتوي على روابط المنتجات (كل رابط في خلية بالعمود الأول)
              </p>
            </div>

            {/* ZIP Upload & Rename */}
            <div className="lg:col-span-2">
              <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
                <FolderArchive className="w-4 h-4 text-orange-600" />
                إعادة تسمية صور (ZIP)
              </label>

              <input
                ref={zipInputRef}
                type="file"
                accept=".zip"
                onChange={handleZipUpload}
                className="hidden"
              />

              {!zipFileName ? (
                <button
                  onClick={() => zipInputRef.current?.click()}
                  className="upload-zone-3d w-full h-40 flex flex-col items-center justify-center gap-3 text-slate-400 cursor-pointer"
                >
                  <FolderArchive className="w-10 h-10" />
                  <span className="text-sm font-medium">
                    اضغط لرفع ملف ZIP يحتوي على صور
                  </span>
                  <span className="text-xs text-slate-400">
                    سيتم إعادة تسمية الصور حسب أول SKU
                  </span>
                </button>
              ) : (
                <div className="upload-zone-3d w-full h-40 border-orange-300 bg-orange-50 flex flex-col items-center justify-center gap-3">
                  <FolderArchive className="w-10 h-10 text-orange-600" />
                  <span className="text-sm font-semibold text-orange-700">
                    {zipFileName}
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="pill-3d text-orange-600 bg-orange-100">
                      {zipImages.length} صورة
                    </span>
                    <button
                      onClick={() => zipInputRef.current?.click()}
                      className="text-xs text-blue-600 hover:underline"
                    >
                      تغيير الملف
                    </button>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 mt-3">
                <button
                  onClick={handleZipRename}
                  disabled={renamingZip || zipImages.length === 0 || !isValidSkuPattern(startSku.trim())}
                  className="btn-3d flex-1 bg-gradient-to-r from-orange-500 to-orange-600 py-2.5 px-4 flex items-center justify-center gap-2"
                >
                  {renamingZip ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      جاري إعادة التسمية...
                    </>
                  ) : (
                    <>
                      <Images className="w-5 h-5" />
                      إعادة تسمية الصور وتنزيلها
                    </>
                  )}
                </button>
              </div>

              <p className="text-xs text-slate-400 mt-1.5">
                ارفع ملف ZIP يحتوي على صور، ثم أدخل أول SKU في الخانة المجاورة واضغط زر إعادة التسمية
              </p>
            </div>

            {/* API Key + SKU + Mode + Action */}
            <div className="flex flex-col gap-4">
              <div>
                <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
                  <Key className="w-4 h-4 text-amber-600" />
                  مفتاح OpenAI API
                </label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="input-3d"
                  dir="ltr"
                />
                <p className="text-xs text-slate-400 mt-1.5">
                  يُستخدم مرة واحدة مع كل عملية استخراج
                </p>
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
                  <Link2 className="w-4 h-4 text-blue-600" />
                  أول 4 أحرف من الـ SKU
                </label>
                <input
                  type="text"
                  value={skuPrefix}
                  onChange={(e) => setSkuPrefix(e.target.value.toUpperCase())}
                  placeholder="ABCD"
                  className="input-3d"
                  dir="ltr"
                  maxLength={4}
                />
                <p className="text-xs text-slate-400 mt-1.5">
                  سيُسحب فقط المنتجات التي يبدأ SKU الخاص بها بهذه البادئة
                </p>
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
                  <Link2 className="w-4 h-4 text-blue-600" />
                  أول SKU
                </label>
                <input
                  type="text"
                  value={startSku}
                  onChange={(e) => setStartSku(e.target.value.toUpperCase())}
                  placeholder="AB001"
                  className="input-3d"
                  dir="ltr"
                />
                <div className="mt-3 flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <span className="text-xs font-medium text-slate-600">استخدام SKU الموجود في الملف</span>
                  <button
                    type="button"
                    onClick={() => setUseExistingSku((prev) => !prev)}
                    className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${useExistingSku ? "bg-emerald-500" : "bg-slate-300"}`}
                    aria-label="Toggle existing SKU import"
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${useExistingSku ? "translate-x-6" : "translate-x-1"}`}
                    />
                  </button>
                </div>
                <p className="text-xs text-slate-400 mt-1.5">
                  {useExistingSku
                    ? "ON: يقرأ SKU كما هو في الشيت، ولا يحتاج إلى أول SKU إذا كان موجوداً في الملف." 
                    : "OFF: يجب إدخال أول SKU ليتم توليد الـ SKU تلقائيًا."}
                </p>
              </div>

              {/* Mode Toggle */}
              <div>
                <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
                  <Database className="w-4 h-4 text-purple-600" />
                  نوع الاستخراج
                </label>
                <div className="flex bg-slate-100 rounded-xl p-1 border border-slate-200 shadow-inner">
                  <button
                    onClick={() => setMode("full")}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-sm font-semibold transition-all ${
                      mode === "full"
                        ? "bg-gradient-to-r from-purple-600 to-purple-500 text-white shadow-md shadow-purple-500/30"
                        : "text-slate-500 hover:text-slate-700"
                    }`}
                  >
                    <Database className="w-4 h-4" />
                    البيانات كاملة
                  </button>
                  <button
                    onClick={() => setMode("data")}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-sm font-semibold transition-all ${
                      mode === "data"
                        ? "bg-gradient-to-r from-emerald-600 to-emerald-500 text-white shadow-md shadow-emerald-500/30"
                        : "text-slate-500 hover:text-slate-700"
                    }`}
                  >
                    <FileSpreadsheet className="w-4 h-4" />
                    البيانات فقط
                  </button>
                  <button
                    onClick={() => setMode("images")}
                    className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-sm font-semibold transition-all ${
                      mode === "images"
                        ? "bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-md shadow-blue-500/30"
                        : "text-slate-500 hover:text-slate-700"
                    }`}
                  >
                    <Camera className="w-4 h-4" />
                    الصور فقط
                  </button>
                </div>
                <p className="text-xs text-slate-400 mt-1.5">
                  {mode === "full"
                    ? "استخراج الاسم والسعر والصورة معاً"
                    : mode === "data"
                      ? "استخراج SKU والاسم والسعر والوصف والرابط بدون صور"
                      : "استخراج الصور فقط بدون بيانات"}
                </p>
              </div>

              <button
                onClick={handleProcess}
                disabled={
                  processing ||
                  links.length === 0
                }
                className="btn-3d w-full bg-gradient-to-r from-blue-600 to-indigo-600 py-3 px-4 flex items-center justify-center gap-2"
              >
                {processing ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    جاري المعالجة...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-5 h-5" />
                    استخراج البيانات
                  </>
                )}
              </button>
            </div>
          </div>

          {globalError && (
            <div className="mt-4 flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 animate-glow">
              <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <span>{globalError}</span>
            </div>
          )}

          {exportProgress && (
            <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-xl">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-blue-700 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {exportProgress.label}
                </span>
                <span className="text-xs text-blue-600 font-mono" dir="ltr">
                  {Math.round(
                    (exportProgress.current / exportProgress.total) * 100
                  )}
                  %
                </span>
              </div>
              <div className="w-full h-2 bg-blue-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-600 rounded-full transition-all duration-300"
                  style={{
                    width: `${Math.round(
                      (exportProgress.current / exportProgress.total) * 100
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>}

        {activeSection === "barcode" && <div id="barcode-lookup" className="dashboard-section">
          <BarcodeLookupTool />
        </div>}

        {activeSection === "sku-renamer" && <div id="sku-renamer" className="dashboard-section">
          <SkuImageRenamerTool />
        </div>}

        {/* Sheet + Images SKU tool */}
        {activeSection === "sheet-sku" && <div id="sheet-sku" className="dashboard-section">
          <SheetSkuTool startSku={startSku} setStartSku={setStartSku} />
        </div>}

        {activeSection === "smart-descriptions" && <div id="smart-descriptions" className="dashboard-section">
          <SmartDescriptionTool />
        </div>}

        {/* Results Section */}
        {activeSection === "extractor" && products.length > 0 && (
          <div id="product-results" className="dashboard-section card-3d overflow-hidden">
            {/* Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-slate-200 bg-gradient-to-l from-slate-50 to-white/50">
              <div className="flex items-center gap-3 text-sm">
                <span className="stat-card text-slate-600">
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                  {doneCount} مكتمل
                </span>
                {errorCount > 0 && (
                  <span className="stat-card text-slate-600">
                    <XCircle className="w-4 h-4 text-red-500" />
                    {errorCount} فشل
                  </span>
                )}
                <span className="stat-card text-slate-600">
                  <span className="w-1.5 h-1.5 bg-slate-400 rounded-full" />
                  {products.length} إجمالي
                </span>
              </div>

              <div className="flex items-center gap-2">
                {mode !== "images" && (
                  <button
                    onClick={handleExcelExport}
                    disabled={exportingExcel || doneCount === 0}
                    className="btn-3d flex items-center gap-2 bg-green-600 text-sm py-2 px-4"
                  >
                    {exportingExcel ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <FileSpreadsheet className="w-4 h-4" />
                    )}
                    ملف Excel
                  </button>
                )}
                {mode !== "data" && <button
                  onClick={handleZipExport}
                  disabled={exportingZip || doneCount === 0}
                  className="btn-3d flex items-center gap-2 bg-blue-600 text-sm py-2 px-4"
                >
                  {exportingZip ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <FileArchive className="w-4 h-4" />
                  )}
                  صور عالية الجودة (ZIP)
                </button>}
                <button
                  onClick={handleClear}
                  disabled={processing}
                  className="btn-3d flex items-center gap-2 bg-slate-200 text-slate-700 text-sm py-2 px-3"
                  title="مسح"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="table-3d">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-right text-xs font-semibold text-slate-500 uppercase px-4 py-3 w-12">
                      #
                    </th>
                    <th className="text-right text-xs font-semibold text-slate-500 uppercase px-4 py-3 w-24">
                      SKU
                    </th>
                    {mode !== "data" && (
                      <th className="text-right text-xs font-semibold text-slate-500 uppercase px-4 py-3 w-20">
                        الصورة
                      </th>
                    )}
                    {mode !== "images" && (
                      <>
                        <th className="text-right text-xs font-semibold text-slate-500 uppercase px-4 py-3">
                          اسم المنتج
                        </th>
                        <th className="text-right text-xs font-semibold text-slate-500 uppercase px-4 py-3 w-28">
                          السعر
                        </th>
                        <th className="text-right text-xs font-semibold text-slate-500 uppercase px-4 py-3">
                          الوصف (عربي)
                        </th>
                        <th className="text-right text-xs font-semibold text-slate-500 uppercase px-4 py-3">
                          الوصف (إنجليزي)
                        </th>
                      </>
                    )}
                    <th className="text-right text-xs font-semibold text-slate-500 uppercase px-4 py-3">
                      الرابط
                    </th>
                    <th className="text-right text-xs font-semibold text-slate-500 uppercase px-4 py-3 w-24">
                      الحالة
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product, idx) => (
                    <tr
                      key={idx}
                      className="border-b border-slate-100 hover:bg-slate-50/50 transition-colors"
                    >
                      <td className="px-4 py-3 text-sm text-slate-500">
                        {idx + 1}
                      </td>
                      <td className="px-4 py-3 text-sm font-mono font-semibold text-slate-700" dir="ltr">
                        {product.sku}
                      </td>
                      {mode !== "data" && (
                        <td className="px-4 py-3">
                          {product.status === "done" && (product.image_url_high || product.image_url) ? (
                            <img
                              src={getBestImageForDisplay(product)}
                              alt={product.product_name || "منتج"}
                              className="w-12 h-12 object-cover rounded-lg border border-slate-200"
                              loading={idx < 8 ? "eager" : "lazy"}
                              decoding="async"
                              fetchPriority={idx < 8 ? "high" : "auto"}
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div className="w-12 h-12 bg-slate-100 rounded-lg flex items-center justify-center">
                              <ImageIcon className="w-4 h-4 text-slate-300" />
                            </div>
                          )}
                        </td>
                      )}
                      {mode !== "images" && (
                        <>
                          <td className="px-4 py-3 text-sm text-slate-700">
                            {product.status === "loading" ? (
                              <span className="text-slate-400">جاري الاستخراج...</span>
                            ) : product.status === "error" ? (
                              <span className="text-red-500 text-xs">{product.error}</span>
                            ) : (
                              product.product_name || "—"
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-700" dir="ltr">
                            {product.status === "done" && product.price !== null
                              ? `${product.price}`
                              : "—"}
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-600 max-w-xs">
                            {product.status === "done" && product.description_ar
                              ? product.description_ar
                              : "—"}
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-600 max-w-xs" dir="ltr">
                            {product.status === "done" && product.description_en
                              ? product.description_en
                              : "—"}
                          </td>
                        </>
                      )}
                      <td className="px-4 py-3">
                        <a
                          href={product.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-600 hover:underline break-all inline-flex items-center gap-1"
                          dir="ltr"
                        >
                          <Link2 className="w-3 h-3 flex-shrink-0" />
                          {product.url.replace(/^https?:\/\//, "").slice(0, 40)}...
                        </a>
                      </td>
                      <td className="px-4 py-3">
                        {product.status === "pending" && (
                          <span className="pill-3d text-slate-500 bg-slate-100">
                            <span className="w-1.5 h-1.5 bg-slate-400 rounded-full" />
                            في الانتظار
                          </span>
                        )}
                        {product.status === "loading" && (
                          <span className="pill-3d text-blue-600 bg-blue-50">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            جاري...
                          </span>
                        )}
                        {product.status === "done" && (
                          <span className="pill-3d text-green-600 bg-green-50">
                            <CheckCircle2 className="w-3 h-3" />
                            مكتمل
                          </span>
                        )}
                        {product.status === "error" && (
                          <span className="pill-3d text-red-600 bg-red-50">
                            <XCircle className="w-3 h-3" />
                            فشل
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        </main>
      </div>
    </div>
  );
}

export default App;