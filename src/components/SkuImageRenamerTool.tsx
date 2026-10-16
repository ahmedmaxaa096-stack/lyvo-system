import { useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileArchive,
  FileSpreadsheet,
  Images,
  Loader2,
  RefreshCw,
} from "lucide-react";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { generateBarcodeSku, MAX_BARCODE_PRODUCTS } from "@/lib/barcodeLookup";

interface SheetColumnOption {
  index: number;
  label: string;
}

interface SheetSelection {
  sheetName: string;
  headerRow: number;
  skuColumn: number;
  columns: SheetColumnOption[];
}

interface RenumberedRow {
  oldSku: string;
  newSku: string;
  imageCount: number;
}

interface RunSummary {
  rows: RenumberedRow[];
  missingImages: string[];
  unmatchedImages: string[];
  downloadedName: string;
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"]);
const SKU_HEADER = /\bsku\b|stock\s*keeping|كود\s*(?:المنتج|الصنف|المخزون)?|رمز\s*المنتج/i;

function getSheetSelection(workbook: XLSX.WorkBook, sheetName: string): SheetSelection {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error("تعذر قراءة ورقة العمل المحددة");
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "", range: 0 });
  const headerRow = rows.slice(0, 10).findIndex((row) => row.some((value) => SKU_HEADER.test(String(value ?? "").trim())));
  const headerValues = headerRow >= 0 ? rows[headerRow] : [];
  const ref = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : { s: { c: 0 }, e: { c: 0 } };
  const columnCount = Math.max(ref.e.c + 1, headerValues.length, 1);
  const columns = Array.from({ length: columnCount }, (_, index) => {
    const title = String(headerValues[index] ?? "").trim();
    return { index, label: `${XLSX.utils.encode_col(index)}${title ? ` - ${title}` : ""}` };
  });
  const detectedColumn = headerRow >= 0
    ? headerValues.findIndex((value) => SKU_HEADER.test(String(value ?? "").trim()))
    : -1;
  return {
    sheetName,
    headerRow,
    skuColumn: detectedColumn >= 0 ? detectedColumn : 0,
    columns,
  };
}

function imageBaseName(path: string): { stem: string; extension: string } {
  const fileName = path.split(/[\\/]/).pop() || "";
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return { stem: fileName, extension: "" };
  return { stem: fileName.slice(0, dot), extension: fileName.slice(dot).toLowerCase() };
}

function safeZipPath(path: string): string {
  return path.replace(/\\/g, "/").split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => part.replace(/[^\w.() -]/g, "_"))
    .join("/");
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function SkuImageRenamerTool() {
  const sheetInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const [sheetBuffer, setSheetBuffer] = useState<ArrayBuffer | null>(null);
  const [sheetFileName, setSheetFileName] = useState("");
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [selection, setSelection] = useState<SheetSelection | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [startSku, setStartSku] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<RunSummary | null>(null);

  const handleSheetUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    setSummary(null);
    try {
      const buffer = await file.arrayBuffer();
      const parsed = XLSX.read(buffer, { type: "array", cellStyles: true, cellDates: false });
      if (parsed.SheetNames.length === 0) throw new Error("ملف Excel لا يحتوي على أوراق عمل");
      setSheetBuffer(buffer);
      setWorkbook(parsed);
      setSheetFileName(file.name);
      setSheetNames(parsed.SheetNames);
      setSelection(getSheetSelection(parsed, parsed.SheetNames[0]));
    } catch (err) {
      setSheetBuffer(null);
      setWorkbook(null);
      setSelection(null);
      setError(err instanceof Error ? err.message : "تعذر قراءة ملف Excel");
    }
  };

  const handleSheetChange = (sheetName: string) => {
    if (!workbook) return;
    setSelection(getSheetSelection(workbook, sheetName));
    setSummary(null);
  };

  const handleRun = async () => {
    if (!sheetBuffer || !workbook || !selection || !imageFile) {
      setError("ارفع ملف Excel وملف ZIP الصور أولًا");
      return;
    }
    setBusy(true);
    setError("");
    setSummary(null);
    try {
      generateBarcodeSku(startSku, 0);
      const outputWorkbook = XLSX.read(sheetBuffer, { type: "array", cellStyles: true, cellDates: false });
      const sourceSheet = outputWorkbook.Sheets[selection.sheetName];
      if (!sourceSheet) throw new Error("تعذر العثور على ورقة العمل");
      const values = XLSX.utils.sheet_to_json<unknown[]>(sourceSheet, { header: 1, raw: true, defval: "", range: 0 });
      const firstDataRow = selection.headerRow >= 0 ? selection.headerRow + 1 : 0;
      const dataRows = values
        .map((row, rowIndex) => ({ rowIndex, oldSku: String(row[selection.skuColumn] ?? "").trim() }))
        .filter((row) => row.rowIndex >= firstDataRow && row.oldSku !== "");
      if (dataRows.length === 0) throw new Error("لم أجد قيم SKU في العمود المحدد");
      if (dataRows.length > MAX_BARCODE_PRODUCTS) {
        throw new Error(`الحد الأقصى هو ${MAX_BARCODE_PRODUCTS.toLocaleString("en-US")} منتج`);
      }

      const sourceZip = await JSZip.loadAsync(await imageFile.arrayBuffer());
      const imageEntries = Object.values(sourceZip.files).filter((entry) => {
        if (entry.dir) return false;
        const { extension } = imageBaseName(entry.name);
        return IMAGE_EXTENSIONS.has(extension);
      });
      const imagesBySku = new Map<string, typeof imageEntries>();
      for (const entry of imageEntries) {
        const { stem } = imageBaseName(entry.name);
        const key = stem.trim().toLocaleLowerCase();
        const group = imagesBySku.get(key) || [];
        group.push(entry);
        imagesBySku.set(key, group);
      }

      const outputZip = new JSZip();
      const usedImages = new Set<string>();
      const renumberedRows: RenumberedRow[] = [];
      const missingImages: string[] = [];
      for (const [index, row] of dataRows.entries()) {
        const newSku = generateBarcodeSku(startSku, index);
        const address = XLSX.utils.encode_cell({ r: row.rowIndex, c: selection.skuColumn });
        const oldCell = sourceSheet[address] || { t: "s", v: row.oldSku };
        sourceSheet[address] = { ...oldCell, t: "s", v: newSku, w: newSku };
        const matches = imagesBySku.get(row.oldSku.toLocaleLowerCase()) || [];
        if (matches.length === 0) missingImages.push(row.oldSku);
        for (const [imageIndex, entry] of matches.entries()) {
          const { extension } = imageBaseName(entry.name);
          const safeSku = newSku.replace(/[^A-Za-z0-9_-]/g, "_");
          const suffix = matches.length > 1 ? `_${imageIndex + 1}` : "";
          outputZip.file(`images/${safeSku}${suffix}${extension}`, await entry.async("uint8array"));
          usedImages.add(entry.name);
        }
        renumberedRows.push({ oldSku: row.oldSku, newSku, imageCount: matches.length });
      }

      const unmatchedImages = imageEntries.filter((entry) => !usedImages.has(entry.name));
      for (const [index, entry] of unmatchedImages.entries()) {
        const safePath = safeZipPath(entry.name);
        outputZip.file(`unmatched/${index + 1}_${safePath}`, await entry.async("uint8array"));
      }

      const updatedWorkbook = XLSX.write(outputWorkbook, { bookType: "xlsx", type: "array", cellStyles: true });
      outputZip.file("products-renumbered.xlsx", updatedWorkbook);
      const blob = await outputZip.generateAsync({ type: "blob", compression: "STORE" });
      const downloadedName = "products-renumbered.zip";
      downloadBlob(blob, downloadedName);
      setSummary({ rows: renumberedRows, missingImages, unmatchedImages: unmatchedImages.map((entry) => entry.name), downloadedName });
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر تحديث SKU وإعادة تسمية الصور");
    } finally {
      setBusy(false);
    }
  };

  const matchedProducts = summary?.rows.filter((row) => row.imageCount > 0).length ?? 0;

  return (
    <section className="card-3d p-6 mb-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-md shadow-amber-600/20">
          <RefreshCw className="w-5 h-5 text-white" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-slate-900">تغيير SKU وإعادة تسمية الصور</h2>
          <p className="text-sm text-slate-500">حدّث SKU في الشيت وأعد تسمية الصور المطابقة داخل ZIP</p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <input ref={sheetInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleSheetUpload} />
          <button type="button" onClick={() => sheetInputRef.current?.click()} className="upload-zone-3d w-full h-24 flex items-center justify-center gap-3 text-slate-500">
            <FileSpreadsheet className="w-7 h-7" />
            <span className="text-sm font-medium">{sheetFileName || "ارفع شيت المنتجات (.xlsx / .xls)"}</span>
          </button>
        </div>
        <div>
          <input ref={zipInputRef} type="file" accept=".zip" className="hidden" onChange={(event) => {
            setImageFile(event.target.files?.[0] || null);
            setSummary(null);
            setError("");
          }} />
          <button type="button" onClick={() => zipInputRef.current?.click()} className="upload-zone-3d w-full h-24 flex items-center justify-center gap-3 text-slate-500">
            <FileArchive className="w-7 h-7" />
            <span className="text-sm font-medium">{imageFile?.name || "ارفع ZIP الصور المسماة بالـSKU"}</span>
          </button>
        </div>
      </div>

      {selection && <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {sheetNames.length > 1 && <label className="text-sm font-semibold text-slate-700">
          ورقة العمل
          <select value={selection.sheetName} onChange={(event) => handleSheetChange(event.target.value)} className="input-3d mt-2">
            {sheetNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>}
        <label className="text-sm font-semibold text-slate-700">
          عمود SKU الحالي
          <select value={selection.skuColumn} onChange={(event) => setSelection({ ...selection, skuColumn: Number(event.target.value) })} className="input-3d mt-2">
            {selection.columns.map((column) => <option key={column.index} value={column.index}>{column.label}</option>)}
          </select>
        </label>
        <label className="text-sm font-semibold text-slate-700">
          أول SKU جديد
          <input type="text" value={startSku} onChange={(event) => setStartSku(event.target.value.toUpperCase())} placeholder="ABCD0001" maxLength={8} dir="ltr" className="input-3d mt-2" />
        </label>
      </div>}

      <button type="button" onClick={handleRun} disabled={busy || !sheetBuffer || !imageFile} className="btn-3d mt-4 w-full bg-gradient-to-r from-amber-600 to-orange-600 py-3 flex items-center justify-center gap-2">
        {busy ? <><Loader2 className="w-5 h-5 animate-spin" /> جارٍ تحديث الشيت والصور...</> : <><Images className="w-5 h-5" /> حدّث SKU وحمّل ZIP</>}
      </button>

      {error && <div className="mt-4 flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700"><AlertCircle className="w-5 h-5 shrink-0" />{error}</div>}
      {summary && <div className="mt-4 space-y-3">
        <div className="flex flex-wrap gap-2 text-sm">
          <span className="stat-card"><CheckCircle2 className="w-4 h-4 text-emerald-500" />{summary.rows.length} SKU محدث</span>
          <span className="stat-card"><Images className="w-4 h-4 text-cyan-600" />{matchedProducts} منتج له صور</span>
          <span className="stat-card"><AlertCircle className="w-4 h-4 text-amber-500" />{summary.missingImages.length} صورة مفقودة</span>
          <span className="stat-card"><FileArchive className="w-4 h-4 text-slate-500" />{summary.unmatchedImages.length} صورة غير مرتبطة</span>
        </div>
        {summary.missingImages.length > 0 && <p className="text-xs text-amber-700">SKU بلا صور: {summary.missingImages.slice(0, 10).join(", ")}{summary.missingImages.length > 10 ? "..." : ""}</p>}
        <div className="overflow-x-auto border border-slate-200 rounded-xl">
          <table className="table-3d">
            <thead><tr className="bg-slate-50 border-b border-slate-200">
              <th className="px-3 py-2 text-right text-xs">SKU القديم</th>
              <th className="px-3 py-2 text-right text-xs">SKU الجديد</th>
              <th className="px-3 py-2 text-right text-xs">الصور</th>
            </tr></thead>
            <tbody>{summary.rows.slice(0, 10).map((row) => <tr key={`${row.oldSku}-${row.newSku}`} className="border-b border-slate-100">
              <td className="px-3 py-2 text-xs font-mono" dir="ltr">{row.oldSku}</td>
              <td className="px-3 py-2 text-xs font-mono" dir="ltr">{row.newSku}</td>
              <td className="px-3 py-2 text-xs">{row.imageCount}</td>
            </tr>)}</tbody>
          </table>
          {summary.rows.length > 10 && <p className="p-2 text-xs text-slate-500">عرض أول 10 صفوف من أصل {summary.rows.length}</p>}
        </div>
        <p className="text-xs text-slate-500">تم تنزيل {summary.downloadedName} ويحتوي على الشيت المعدل والصور المعاد تسميتها.</p>
        <button type="button" onClick={handleRun} disabled={busy} className="btn-3d bg-slate-800 px-4 py-2 text-sm flex items-center gap-2"><Download className="w-4 h-4" />تنزيل ZIP مرة أخرى</button>
      </div>}
    </section>
  );
}
