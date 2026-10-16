import { useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Download, FileSpreadsheet, Loader2, Search, Upload, XCircle } from "lucide-react";
import {
  exportEgyptResults,
  findEgyptImages,
  parseProductNames,
  type EgyptImageResult,
  type EgyptImageRow,
} from "@/lib/egyptImageFinder";

interface Props {
  openaiApiKey: string;
}

export default function EgyptImageFinderTool({ openaiApiKey }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<EgyptImageRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [results, setResults] = useState<EgyptImageResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const parsed = await parseProductNames(await file.arrayBuffer());
      if (parsed.length === 0) throw new Error("لم يتم العثور على أسماء منتجات. استخدم عمودًا باسم product/name أو اسم المنتج.");
      setRows(parsed);
      setResults([]);
      setFileName(file.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر قراءة الشيت");
    }
  };

  const handleSearch = async () => {
    if (!rows.length) return setError("ارفع شيت المنتجات أولاً");
    setBusy(true);
    setProgress(0);
    setError(null);
    try {
      const found = await findEgyptImages(rows, openaiApiKey, (current, total) => {
        setProgress(Math.round((current / Math.max(total, 1)) * 100));
      });
      setResults(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : "فشل البحث");
    } finally {
      setBusy(false);
    }
  };

  const verified = results.filter((result) => result.status === "verified").length;
  const review = results.filter((result) => result.status === "review").length;
  const missing = results.filter((result) => result.status === "not_found").length;

  return (
    <section className="card-3d p-6 mb-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-md shadow-emerald-500/20">
          <Search className="w-5 h-5 text-white" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-slate-900">صور منتجات من السوق المصري</h2>
          <p className="text-sm text-slate-500">ابحث بالاسم داخل صفحات منتجات مصرية، مع رفض النتائج غير المؤكدة</p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <input ref={inputRef} type="file" accept=".xlsx,.xls" onChange={handleUpload} className="hidden" />
          <button onClick={() => inputRef.current?.click()} className="upload-zone-3d w-full h-28 flex flex-col items-center justify-center gap-2 text-slate-400">
            <FileSpreadsheet className="w-8 h-8" />
            <span className="text-sm font-medium">{fileName || "ارفع شيت أسماء المنتجات (.xlsx)"}</span>
            <span className="text-xs">عمود اسم المنتج مطلوب، وSKU اختياري</span>
          </button>
        </div>
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
            المصادر: Noon Egypt، Amazon.eg، Jumia Egypt ومتاجر مصرية أخرى. OpenAI اختياري للتحقق البصري.
          </div>
          <button onClick={handleSearch} disabled={busy || rows.length === 0} className="btn-3d w-full bg-gradient-to-r from-emerald-600 to-teal-600 py-3 flex items-center justify-center gap-2">
            {busy ? <><Loader2 className="w-5 h-5 animate-spin" /> جارٍ البحث {progress}%</> : <><Upload className="w-5 h-5" /> ابدأ البحث والتحقق</>}
          </button>
        </div>
      </div>
      {error && <div className="mt-4 flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700"><AlertCircle className="w-5 h-5 shrink-0" />{error}</div>}
      {results.length > 0 && (
        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="stat-card"><CheckCircle2 className="w-4 h-4 text-emerald-500" />{verified} مؤكدة</span>
              <span className="stat-card"><AlertCircle className="w-4 h-4 text-amber-500" />{review} مراجعة</span>
              <span className="stat-card"><XCircle className="w-4 h-4 text-red-500" />{missing} بدون نتيجة</span>
            </div>
            <button onClick={() => void exportEgyptResults(results)} className="btn-3d bg-slate-800 px-4 py-2 text-sm flex items-center gap-2"><Download className="w-4 h-4" />تحميل Excel وZIP</button>
          </div>
          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="table-3d">
              <thead><tr className="bg-slate-50 border-b border-slate-200"><th className="px-3 py-3 text-right text-xs">المنتج</th><th className="px-3 py-3 text-right text-xs">الصورة</th><th className="px-3 py-3 text-right text-xs">المصدر</th><th className="px-3 py-3 text-right text-xs">الثقة</th><th className="px-3 py-3 text-right text-xs">الحالة</th></tr></thead>
              <tbody>{results.map((result) => <tr key={result.index} className="border-b border-slate-100">
                <td className="px-3 py-3 text-sm min-w-64"><div className="font-semibold">{result.productName}</div><div className="text-xs text-slate-500">{result.title || result.reason}</div></td>
                <td className="px-3 py-3">{result.imageUrl ? <img src={`/api/image-proxy?url=${encodeURIComponent(result.imageUrl)}`} alt={result.title} className="w-14 h-14 rounded-lg border object-contain" /> : <XCircle className="w-5 h-5 text-slate-300" />}</td>
                <td className="px-3 py-3 text-xs">{result.source || "-"}</td>
                <td className="px-3 py-3 text-sm font-mono" dir="ltr">{Math.round(result.score * 100)}%</td>
                <td className="px-3 py-3 text-xs font-semibold">{result.status === "verified" ? <span className="text-emerald-600">مؤكدة</span> : result.status === "review" ? <span className="text-amber-600">تحتاج مراجعة</span> : <span className="text-red-600">لم توجد</span>}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400 mt-3">النتائج المؤكدة فقط تدخل ملف ZIP. النتائج الأخرى تبقى للمراجعة ولا يتم تقديمها كصور صحيحة.</p>
        </div>
      )}
    </section>
  );
}
