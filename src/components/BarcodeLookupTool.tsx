import { useRef, useState } from "react";
import { AlertCircle, Barcode, CheckCircle2, Download, FileSpreadsheet, Loader2, Search, XCircle } from "lucide-react";
import {
  exportBarcodeResults,
  lookupBarcodes,
  parseBarcodeSheet,
  type BarcodeExportProgress,
  type BarcodeLookupResult,
} from "@/lib/barcodeLookup";

export default function BarcodeLookupTool() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [startSku, setStartSku] = useState("");
  const [results, setResults] = useState<BarcodeLookupResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportProgress, setExportProgress] = useState<BarcodeExportProgress | null>(null);
  const [exportMessage, setExportMessage] = useState("");
  const [exportError, setExportError] = useState("");

  const handleSearch = async () => {
    if (!file) return setError("ارفع شيت المنتجات أولاً");
    setBusy(true);
    setError("");
    setResults([]);
    setProgress(null);
    try {
      const rows = await parseBarcodeSheet(await file.arrayBuffer(), startSku);
      setProgress({ completed: 0, total: rows.length });
      const found = await lookupBarcodes(rows, (completed, total, partialResults) => {
        setProgress({ completed, total });
        setResults(partialResults);
      });
      setResults(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر البحث عن المنتجات");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const handleExport = async () => {
    if (exportBusy) return;
    setExportBusy(true);
    setExportProgress(null);
    setExportMessage("");
    setExportError("");
    try {
      const failedImages = await exportBarcodeResults(results, setExportProgress);
      setExportMessage(
        failedImages > 0
          ? `تم تنزيل الملف، لكن تعذر تنزيل ${failedImages} صورة. بيانات المنتجات موجودة في Excel.`
          : "تم تجهيز الملف وتنزيله بنجاح."
      );
    } catch (err) {
      setExportError(`تعذر تجهيز ملف التحميل: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExportBusy(false);
      setExportProgress(null);
    }
  };

  const exportProgressLabel = exportProgress?.stage === "images"
    ? exportProgress.total > 0
      ? `جارٍ تنزيل الصور ${exportProgress.completed}/${exportProgress.total}`
      : "جارٍ تجهيز ملف Excel..."
    : exportProgress?.stage === "workbook"
      ? "جارٍ إنشاء ملف Excel..."
      : exportProgress?.stage === "zip"
        ? `جارٍ ضغط الملفات ${exportProgress.completed}%`
        : "";

  const found = results.filter((result) => result.status === "found").length;
  const review = results.filter((result) => result.status === "review").length;
  const missing = results.filter((result) => result.status === "not_found").length;

  return (
    <section className="card-3d p-6 mb-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-600 to-blue-700 flex items-center justify-center shadow-md shadow-cyan-700/20">
          <Barcode className="w-5 h-5 text-white" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-slate-900">بحث المنتجات بالباركود</h2>
          <p className="text-sm text-slate-500">ابحث في Amazon.eg وNoon مصر، واستخدم Google للوصول لصفحات المنتج فيهما فقط</p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1fr_220px_auto] lg:items-end">
        <div>
          <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={(event) => {
            setFile(event.target.files?.[0] || null);
            setResults([]);
            setError("");
          }} />
          <button type="button" onClick={() => fileRef.current?.click()} className="upload-zone-3d w-full h-24 flex items-center justify-center gap-3 text-slate-500">
            <FileSpreadsheet className="w-7 h-7" />
            <span className="text-sm font-medium">{file?.name || "ارفع شيت Excel (.xlsx)"}</span>
          </button>
        </div>
        <label className="text-sm font-semibold text-slate-700">
          أول SKU
          <input
            type="text"
            value={startSku}
            onChange={(event) => setStartSku(event.target.value.toUpperCase())}
            placeholder="ABCD0001"
            maxLength={8}
            dir="ltr"
            className="input-3d mt-2"
          />
        </label>
        <button type="button" onClick={handleSearch} disabled={busy || !file} className="btn-3d bg-gradient-to-r from-cyan-700 to-blue-700 px-5 py-3 flex items-center justify-center gap-2">
          {busy ? <><Loader2 className="w-5 h-5 animate-spin" /> جارٍ البحث {progress ? `${progress.completed}/${progress.total}` : "..."}</> : <><Search className="w-5 h-5" /> ابحث بالباركود</>}
        </button>
      </div>

      <p className="mt-2 text-xs text-slate-400">يمكن وضع الباركود في A والسعر في B دون اسم منتج، أو استخدام A للاسم وB للباركود وC للسعر وD للاسم الإنجليزي. يبدأ الترقيم من SKU الذي تدخله.</p>
      {error && <div className="mt-4 flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700"><AlertCircle className="w-5 h-5 shrink-0" />{error}</div>}

      {results.length > 0 && <div className="mt-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2 text-sm">
            <span className="stat-card"><CheckCircle2 className="w-4 h-4 text-emerald-500" />{found} تم العثور عليها</span>
            <span className="stat-card"><AlertCircle className="w-4 h-4 text-amber-500" />{review} مراجعة الباركود</span>
            <span className="stat-card"><XCircle className="w-4 h-4 text-slate-500" />{missing} غير موجودة</span>
          </div>
          <button type="button" onClick={() => void handleExport()} disabled={exportBusy} className="btn-3d bg-slate-800 px-4 py-2 text-sm flex items-center gap-2 disabled:cursor-wait disabled:opacity-60">
            {exportBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {exportBusy ? exportProgressLabel || "جارٍ تجهيز الملفات..." : "تحميل Excel والصور عالية الجودة"}
          </button>
        </div>
        {(exportBusy || exportMessage || exportError) && (
          <div aria-live="polite" className={`mb-3 rounded-lg p-3 text-sm ${
            exportError ? "border border-red-200 bg-red-50 text-red-700"
              : exportMessage ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                : "border border-cyan-200 bg-cyan-50 text-cyan-800"
          }`}>
            {exportError || exportMessage || exportProgressLabel}
          </div>
        )}
        <div className="overflow-x-auto border border-slate-200 rounded-xl">
          <table className="table-3d">
            <thead><tr className="bg-slate-50 border-b border-slate-200">
              <th className="px-3 py-3 text-right text-xs">SKU</th>
              <th className="px-3 py-3 text-right text-xs">المنتج</th>
              <th className="px-3 py-3 text-right text-xs">الباركود</th>
              <th className="px-3 py-3 text-right text-xs">السعر المدخل</th>
              <th className="px-3 py-3 text-right text-xs">أفضل تطابق</th>
              <th className="px-3 py-3 text-right text-xs">الصورة</th>
              <th className="px-3 py-3 text-right text-xs">الوصف</th>
              <th className="px-3 py-3 text-right text-xs">الحالة</th>
            </tr></thead>
            <tbody>{results.map((result) => {
              const topCandidate = result.candidates[0];
              const candidateList = result.candidates.slice(0, 3);
              return (
                <tr key={`${result.index}-${result.barcode}`} className="border-b border-slate-100 align-top">
                  <td className="px-3 py-3 text-xs font-mono" dir="ltr">{result.sku}</td>
                  <td className="px-3 py-3 text-sm min-w-52">
                    <div className="font-medium text-slate-800">{result.productName || result.sourceName || "-"}</div>
                    {topCandidate && (
                      <div className="mt-2 text-[11px] text-slate-500">
                        أفضل مرشح: <span className="font-semibold text-cyan-700">{Math.round(topCandidate.matchScore * 100)}%</span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs font-mono" dir="ltr">{result.barcode}</td>
                  <td className="px-3 py-3 text-sm" dir="ltr">{result.price ?? "-"}</td>
                  <td className="px-3 py-3 min-w-72">
                    <div className="space-y-2">
                      {candidateList.length > 0 ? candidateList.map((candidate) => (
                        <div key={candidate.productUrl} className={`rounded-lg border p-2 ${candidate.barcodeVerified ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50"}`}>
                          <a href={candidate.productUrl} target="_blank" rel="noreferrer" className="font-semibold text-cyan-800 hover:underline text-[11px] leading-snug">
                            {candidate.productName || candidate.source}
                          </a>
                          <div className="mt-1 text-[10px] text-slate-500">
                            {candidate.source} · {Math.round(candidate.matchScore * 100)}% · {candidate.barcodeVerified ? "باركود مؤكد" : "اسم فقط"}
                          </div>
                        </div>
                      )) : <span className="text-slate-400 text-xs">لا توجد مرشحات</span>}
                    </div>
                  </td>
                  <td className="px-3 py-3">{result.imageUrl ? <img src={`/api/image-proxy?url=${encodeURIComponent(result.imageUrl)}`} alt={result.productName} className="w-14 h-14 rounded-lg border object-contain" /> : "-"}</td>
                  <td className="px-3 py-3 text-xs min-w-64">{result.description || "-"}</td>
                  <td className="px-3 py-3 text-xs">
                    {result.status === "found" ? <a href={result.productUrl} target="_blank" rel="noreferrer" className="inline-flex rounded-full bg-emerald-100 px-2 py-1 font-medium text-emerald-700">مطابق للباركود</a>
                      : result.status === "review" ? <a href={result.productUrl} target="_blank" rel="noreferrer" className="inline-flex rounded-full bg-amber-100 px-2 py-1 font-medium text-amber-700">مرشح بالاسم</a>
                        : <span className="inline-flex rounded-full bg-slate-100 px-2 py-1 text-slate-500">غير موجود</span>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </div>}
    </section>
  );
}