import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  FolderArchive,
  Images,
  Key,
  Loader2,
  Sparkles,
  Upload,
  XCircle,
} from "lucide-react";
import {
  type ProgressFn,
  type SheetProductRow,
  type SheetSkuMatchResult,
  type ZipImageEntry,
  buildExcel,
  buildResults,
  buildZip,
  downloadBlob,
  getUniqueSkuOptions,
  loadZipImages,
  matchRowsToImages,
  parseSheetFile,
} from "@/lib/imageSku";

interface SheetSkuToolProps {
  startSku: string;
  setStartSku: (value: string) => void;
}

type SheetActionMode = "all" | "image" | "price";

interface ProgressState {
  current: number;
  total: number;
  label: string;
}

export default function SheetSkuTool({ startSku, setStartSku }: SheetSkuToolProps) {
  const [sheetRows, setSheetRows] = useState<SheetProductRow[]>([]);
  const [sheetFileName, setSheetFileName] = useState("");
  const [zipImages, setZipImages] = useState<ZipImageEntry[]>([]);
  const [zipFileName, setZipFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SheetSkuMatchResult[] | null>(null);
  const [lastExcel, setLastExcel] = useState<Blob | null>(null);
  const [lastZip, setLastZip] = useState<Blob | null>(null);
  const [thumbUrls, setThumbUrls] = useState<Record<number, string>>({});
  const [useExistingSku, setUseExistingSku] = useState(false);
  const [selectedSkus, setSelectedSkus] = useState<string[]>([]);
  const [sheetMode, setSheetMode] = useState<SheetActionMode>("all");

  const sheetRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);

  const skuOptions = getUniqueSkuOptions(sheetRows);

  const toggleSkuSelection = (sku: string) => {
    setSelectedSkus((prev) => {
      const next = prev.includes(sku) ? prev.filter((item) => item !== sku) : [...prev, sku];
      return next.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    });
  };

  const selectAllSkus = () => {
    setSelectedSkus(skuOptions.map((item) => item.sku));
  };

  const clearSelectedSkus = () => {
    setSelectedSkus([]);
  };

  const setProg: ProgressFn = (current, total, label) =>
    setProgress({ current, total, label });

  const handleSheetUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    console.log("=== Sheet Upload Started ===");
    console.log("File:", file.name, "Size:", file.size, "Type:", file.type);
    
    setError(null);
    setResults(null);
    setLastExcel(null);
    setLastZip(null);
    setBusy(true);
    setProgress({ current: 0, total: 1, label: "جارٍ قراءة ملف الشيت..." });
    
    try {
      const buffer = await file.arrayBuffer();
      console.log("✓ Buffer created, size:", buffer.byteLength);
      
      setProgress({ current: 10, total: 100, label: "جارٍ معالجة الشيت..." });
      const rows = await parseSheetFile(buffer, setProg, useExistingSku);
      console.log("✓ Sheet parsed successfully, rows:", rows.length);
      
      if (rows.length === 0) {
        setError("لم يتم العثور على بيانات صالحة في الملف (اسم/سعر/صورة مدمجة)");
        setBusy(false);
        setProgress(null);
        return;
      }
      
      console.log("✓ Setting sheet rows:", rows.length);
      const uniqueSkuValues = getUniqueSkuOptions(rows).map((item) => item.sku);
      setSheetRows(rows);
      setSelectedSkus(uniqueSkuValues.length > 0 ? uniqueSkuValues : ["__ALL_ROWS__"]);
      setSheetFileName(file.name);
      setError(null);
      setProgress(null);
      console.log("=== Sheet Upload Complete ===");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("❌ Sheet upload error:", err);
      setError(`فشل قراءة الشيت: ${errMsg}`);
      setProgress(null);
    } finally {
      setBusy(false);
    }
  };

  const handleZipUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setResults(null);
    setLastExcel(null);
    setLastZip(null);
    try {
      const buffer = await file.arrayBuffer();
      const images = await loadZipImages(buffer, setProg);
      if (images.length === 0) {
        setError("لم يتم العثور على صور صالحة في ملف ZIP");
        return;
      }
      setZipImages(images);
      setZipFileName(file.name);
      setProgress(null);
    } catch (err) {
      setError(`فشل قراءة ملف ZIP: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRun = async () => {
    if (sheetRows.length === 0) {
      setError("من فضلك ارفع شيت المنتجات أولاً");
      return;
    }

    if (sheetMode !== "price" && zipImages.length === 0) {
      setError("من فضلك ارفع ملف ZIP للصور أولاً");
      return;
    }

    const isValidSkuPattern = (value: string): boolean => /^[A-Za-z]{2,}(\d+)?$/.test(value.trim().toUpperCase());
    if (!isValidSkuPattern(startSku.trim())) {
      setError("من فضلك أدخل SKU صحيح (حرفان أو أكثر مع أرقام اختيارية، مثال: AB001 أو ABCD001)");
      return;
    }

    const filteredRows = useExistingSku
      ? sheetRows
      : sheetRows.map((row) => ({ ...row, sku: "" }));
    if (filteredRows.length === 0) {
      setError("لم يتم العثور على صفوف منتجات في الشيت");
      return;
    }

    setError(null);
    setResults(null);
    setLastExcel(null);
    setLastZip(null);
    setBusy(true);

    try {
      const modeLabel =
        sheetMode === "image"
          ? "جارٍ مطابقة الصور فقط..."
          : sheetMode === "price"
            ? "جارٍ تجهيز البيانات السعرية..."
            : "جارٍ مطابقة الصور...";

      setProgress({ current: 0, total: filteredRows.length, label: modeLabel });

      const matches = sheetMode === "price" ? filteredRows.map(() => ({ zipIndex: null, distance: Infinity })) : matchRowsToImages(filteredRows, zipImages);
      const built = buildResults(filteredRows, matches, zipImages, startSku);

      setProgress({
        current: filteredRows.length,
        total: filteredRows.length,
        label: sheetMode === "price" ? "إنشاء ملف Excel بالسعر فقط..." : "إنشاء ملفات Excel و ZIP...",
      });

      const excelBlob = await buildExcel(built);
      const zipBlob = sheetMode === "price" ? null : await buildZip(built);

      setLastExcel(excelBlob);
      setLastZip(zipBlob);
      setResults(built);

      downloadBlob(excelBlob, `منتجات-بالـ-SKU-${Date.now()}.xlsx`);
      if (zipBlob) {
        downloadBlob(zipBlob, `صور-مسماه-بالـ-SKU-${Date.now()}.zip`);
      }
    } catch (err) {
      setError(`فشل المعالجة: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  useEffect(() => {
    if (!results) {
      setThumbUrls({});
      return;
    }
    const map: Record<number, string> = {};
    for (const r of results) {
      if (r.imageBlob) map[r.index] = URL.createObjectURL(r.imageBlob);
    }
    setThumbUrls(map);
    return () => {
      for (const url of Object.values(map)) URL.revokeObjectURL(url);
    };
  }, [results]);

  const matchedCount = results?.filter((r) => r.source === "zip").length ?? 0;
  const embeddedCount = results?.filter((r) => r.source === "embedded").length ?? 0;
  const noneCount = results?.filter((r) => r.source === "none").length ?? 0;

  return (
    <div className="card-3d p-6 mb-6">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-9 h-9 bg-gradient-to-br from-teal-400 to-cyan-500 rounded-xl flex items-center justify-center shadow-md shadow-cyan-500/30">
          <Images className="w-5 h-5 text-white" />
        </div>
        <h2 className="text-lg font-bold text-slate-900">
          شيت + صور (توليد SKU وإعادة تسمية الصور)
        </h2>
      </div>
      <p className="text-sm text-slate-500 mb-5">
        ارفع شيت فيه اسم المنتج والسعر وصورة GIF مدمجة لكل منتج، وارفع ZIP يحتوي على نفس
        الصور — سيتم مطابقة كل صورة بالصورة المقابلة وإعادة تسمية كل صورة حسب الـ SKU.
        المنتج الذي له أكثر من صورة يأخذ نفس الـ SKU مع لاحقة _1 للصورة الأولى
        و _2 و _3 للصور التالية (وإذا كان في الشيت عمود SKU فسيُستخدم للـ SKU).
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* SKU input + run button */}
        <div className="flex flex-col gap-4">
          <div>
            <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
              <Key className="w-4 h-4 text-amber-600" />
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
              <span className="text-xs font-medium text-slate-600">استخدام SKU الموجود في الشيت</span>
              <button
                type="button"
                onClick={() => setUseExistingSku((prev) => !prev)}
                className={`relative inline-flex h-7 w-12 items-center rounded-full transition ${useExistingSku ? "bg-emerald-500" : "bg-slate-300"}`}
                aria-label="Toggle existing SKU usage"
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${useExistingSku ? "translate-x-6" : "translate-x-1"}`}
                />
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1.5">
              {useExistingSku
                ? "ON: سيُستخدم SKU الموجود في الشيت إذا وُجد، وإذا لم يوجد يتم استخدام أول SKU." 
                : "OFF: سيتم توليد SKU تلقائيًا من أول SKU فقط، دون قراءة SKU من الملف."}
            </p>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
              <Images className="w-4 h-4 text-violet-600" />
              نوع السحب
            </label>
            <div className="grid grid-cols-3 gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-1.5">
              {[
                { value: "all", label: "الكل" },
                { value: "image", label: "صورة فقط" },
                { value: "price", label: "سعر فقط" },
              ].map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  onClick={() => setSheetMode(mode.value as SheetActionMode)}
                  className={`rounded-xl px-2 py-2 text-[11px] font-semibold transition ${
                    sheetMode === mode.value
                      ? "bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-md"
                      : "bg-white text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-400 mt-1.5">
              {sheetMode === "all"
                ? "يُسحب السعر + الصور + SKU معًا"
                : sheetMode === "image"
                  ? "يُسحب الصور فقط — ويُستخدم السعر من الشيت فقط إذا احتاجته لاحقاً"
                  : "يُسحب السعر فقط من الشيت، مع اختيار Sale Price الحقيقي بدل السعر القديم المشطوب"}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <label className="text-sm font-semibold text-slate-700">اختيار الـ SKUs</label>
              <div className="flex items-center gap-2 text-[11px]">
                <button type="button" onClick={selectAllSkus} className="text-blue-600 hover:underline">تحديد الكل</button>
                <button type="button" onClick={clearSelectedSkus} className="text-slate-500 hover:underline">مسح</button>
              </div>
            </div>

            {skuOptions.length === 0 ? (
              <p className="text-xs text-slate-400">لم يتم العثور على SKU في الشيت بعد القراءة.</p>
            ) : (
              <div className="max-h-44 space-y-2 overflow-y-auto pr-1">
                {skuOptions.map(({ sku, count }) => (
                  <label key={sku} className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-700">
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedSkus.includes(sku)}
                        onChange={() => toggleSkuSelection(sku)}
                        className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                      />
                      <span dir="ltr" className="font-mono font-semibold">{sku}</span>
                    </span>
                    <span className="text-[11px] text-slate-500">{count} صف</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={handleRun}
            disabled={busy || sheetRows.length === 0 || (sheetMode !== "price" && zipImages.length === 0)}
            className="btn-3d w-full bg-gradient-to-r from-teal-500 to-cyan-600 py-3 px-4 flex items-center justify-center gap-2"
          >
            {busy ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                جاري المعالجة...
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5" />
                {sheetMode === "price"
                  ? "تجهيز الأسعار فقط"
                  : sheetMode === "image"
                    ? "مطابقة الصور فقط"
                    : "مطابقة الصور وإنشاء SKU والتسمية"}
              </>
            )}
          </button>
        </div>

        {/* Sheet upload */}
        <div className="lg:col-span-2">
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
            <FileSpreadsheet className="w-4 h-4 text-green-600" />
            شيت المنتجات (اسم + سعر + صورة GIF مدمجة)
          </label>
          <input
            ref={sheetRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleSheetUpload}
            className="hidden"
          />
          {!sheetFileName ? (
            <button
              onClick={() => sheetRef.current?.click()}
              className="upload-zone-3d w-full h-28 flex flex-col items-center justify-center gap-2 text-slate-400 cursor-pointer"
            >
              <Upload className="w-8 h-8" />
              <span className="text-sm font-medium">اضغط لرفع شيت المنتجات (.xlsx)</span>
              <span className="text-xs text-slate-400">
                مع الصور المدمجة (GIF) داخل صف كل منتج
              </span>
            </button>
          ) : (
            <div className="upload-zone-3d w-full h-28 border-green-300 bg-green-50 flex flex-col items-center justify-center gap-2">
              <FileSpreadsheet className="w-8 h-8 text-green-600" />
              <span className="text-sm font-semibold text-green-700">{sheetFileName}</span>
              <div className="flex items-center gap-3">
                <span className="pill-3d text-green-600 bg-green-100">
                  {sheetRows.length} منتج
                </span>
                <span className="pill-3d text-cyan-600 bg-cyan-50">
                  {sheetRows.filter((r) => r.image).length} صورة مدمجة
                </span>
                <button
                  onClick={() => sheetRef.current?.click()}
                  className="text-xs text-blue-600 hover:underline"
                >
                  تغيير الملف
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ZIP upload */}
        <div className="lg:col-span-2">
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
            <FolderArchive className="w-4 h-4 text-orange-600" />
            صور المنتجات (ZIP)
          </label>
          <input
            ref={zipRef}
            type="file"
            accept=".zip"
            onChange={handleZipUpload}
            className="hidden"
          />
          {!zipFileName ? (
            <button
              onClick={() => zipRef.current?.click()}
              className="upload-zone-3d w-full h-28 flex flex-col items-center justify-center gap-2 text-slate-400 cursor-pointer"
            >
              <FolderArchive className="w-8 h-8" />
              <span className="text-sm font-medium">اضغط لرفع ملف ZIP يحتوي على الصور</span>
              <span className="text-xs text-slate-400">
                نفس الصور الموجودة في الشيت (GIF/PNG/JPG)
              </span>
            </button>
          ) : (
            <div className="upload-zone-3d w-full h-28 border-orange-300 bg-orange-50 flex flex-col items-center justify-center gap-2">
              <FolderArchive className="w-8 h-8 text-orange-600" />
              <span className="text-sm font-semibold text-orange-700">{zipFileName}</span>
              <div className="flex items-center gap-3">
                <span className="pill-3d text-orange-600 bg-orange-100">
                  {zipImages.length} صورة
                </span>
                <button
                  onClick={() => zipRef.current?.click()}
                  className="text-xs text-blue-600 hover:underline"
                >
                  تغيير الملف
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-4 flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {progress && (
        <div className="mt-4 p-4 bg-teal-50 border border-teal-200 rounded-xl">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-teal-700 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              {progress.label}
            </span>
            <span className="text-xs text-teal-600 font-mono" dir="ltr">
              {Math.round((progress.current / progress.total) * 100)}%
            </span>
          </div>
          <div className="w-full h-2 bg-teal-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-teal-600 rounded-full transition-all duration-300"
              style={{
                width: `${Math.round((progress.current / progress.total) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {results && (
        <div className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2 text-sm">
              <span className="stat-card text-slate-600">
                <CheckCircle2 className="w-4 h-4 text-green-500" />
                {matchedCount} تمت مطابقتها
              </span>
              {embeddedCount > 0 && (
                <span className="stat-card text-slate-600">
                  <Images className="w-4 h-4 text-cyan-500" />
                  {embeddedCount} من الشيت
                </span>
              )}
              {noneCount > 0 && (
                <span className="stat-card text-slate-600">
                  <XCircle className="w-4 h-4 text-red-500" />
                  {noneCount} بدون صورة
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {lastExcel && (
                <button
                  onClick={() => downloadBlob(lastExcel, "منتجات-بالـ-SKU.xlsx")}
                  className="btn-3d flex items-center gap-2 bg-green-600 text-sm py-2 px-4"
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  تحميل ملف Excel
                </button>
              )}
              {lastZip && (
                <button
                  onClick={() => downloadBlob(lastZip, "صور-مسماه-بالـ-SKU.zip")}
                  className="btn-3d flex items-center gap-2 bg-orange-600 text-sm py-2 px-4"
                >
                  <FolderArchive className="w-4 h-4" />
                  تحميل الصور المسماه (ZIP)
                </button>
              )}
            </div>
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="table-3d">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-right text-xs font-semibold text-slate-500 px-4 py-3 w-10">#</th>
                  <th className="text-right text-xs font-semibold text-slate-500 px-4 py-3 w-24">SKU</th>
                  <th className="text-right text-xs font-semibold text-slate-500 px-4 py-3 w-20">الصورة</th>
                  <th className="text-right text-xs font-semibold text-slate-500 px-4 py-3">اسم المنتج</th>
                  <th className="text-right text-xs font-semibold text-slate-500 px-4 py-3 w-24">السعر</th>
                  <th className="text-right text-xs font-semibold text-slate-500 px-4 py-3">الرابط</th>
                  <th className="text-right text-xs font-semibold text-slate-500 px-4 py-3">اسم الصورة قبل</th>
                  <th className="text-right text-xs font-semibold text-slate-500 px-4 py-3">اسم الصورة بعد</th>
                  <th className="text-right text-xs font-semibold text-slate-500 px-4 py-3 w-28">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.index} className="border-b border-slate-100 hover:bg-slate-50/50 transition-colors">
                    <td className="px-4 py-3 text-sm text-slate-500">{r.index}</td>
                    <td className="px-4 py-3 text-sm font-mono font-semibold text-slate-700" dir="ltr">
                      {r.sku}
                    </td>
                    <td className="px-4 py-3">
                      {thumbUrls[r.index] ? (
                        <img
                          src={thumbUrls[r.index]}
                          alt={r.productName || "منتج"}
                          className="w-12 h-12 object-cover rounded-lg border border-slate-200"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-12 h-12 bg-slate-100 rounded-lg flex items-center justify-center">
                          <Images className="w-4 h-4 text-slate-300" />
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-700">{r.productName}</td>
                    <td className="px-4 py-3 text-sm text-slate-700" dir="ltr">{r.price}</td>
                    <td className="px-4 py-3">
                      {r.link ? (
                        <a
                          href={r.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sky-600 hover:text-sky-700 text-sm underline"
                          dir="ltr"
                        >
                          {r.link.length > 40 ? `${r.link.substring(0, 40)}...` : r.link}
                        </a>
                      ) : (
                        <span className="text-xs text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500" dir="ltr">{r.originalName}</td>
                    <td className="px-4 py-3 text-xs font-mono font-semibold text-slate-700" dir="ltr">
                      {r.newName}
                    </td>
                    <td className="px-4 py-3">
                      {r.source === "zip" && (
                        <span className="pill-3d text-green-600 bg-green-50">
                          <CheckCircle2 className="w-3 h-3" />
                          مطابقة
                        </span>
                      )}
                      {r.source === "embedded" && (
                        <span className="pill-3d text-cyan-600 bg-cyan-50">
                          <Images className="w-3 h-3" />
                          من الشيت
                        </span>
                      )}
                      {r.source === "none" && (
                        <span className="pill-3d text-red-600 bg-red-50">
                          <XCircle className="w-3 h-3" />
                          بدون صورة
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-slate-400 mt-3">
            تم تنزيل ملف Excel (بخانة SKU والصورة المدمجة) وملف ZIP (بالصور بعد
            التسمية حسب SKU ورقم الصورة) تلقائياً — ويمكنك إعادة تحميلهما من الأزرار بالأعلى.
          </p>
        </div>
      )}
    </div>
  );
}