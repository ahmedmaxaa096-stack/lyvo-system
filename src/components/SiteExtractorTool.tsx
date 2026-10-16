import { useRef, useState } from "react";
import {
  CheckCircle2,
  CirclePlus,
  Database,
  FileSpreadsheet,
  FolderArchive,
  Globe,
  Images,
  Link2,
  Loader2,
  Trash2,
  Wand2,
  XCircle,
} from "lucide-react";
import {
  extractSiteProducts,
  scrapeProductsBatch,
  type DeepSiteProduct,
  type SiteProduct,
} from "@/lib/siteScraper";
import {
  buildFileNames,
  buildSiteExcel,
  buildSiteImagesZip,
  downloadBlob,
} from "@/lib/siteExporters";
import { generateSku } from "@/lib/imageSku";

interface SiteExtractorToolProps {
  onAddLinks: (products: SiteProduct[], sourceLabel: string) => void;
  startSku: string;
  setStartSku: (value: string) => void;
}

export default function SiteExtractorTool({ onAddLinks, startSku, setStartSku }: SiteExtractorToolProps) {
  const [siteUrl, setSiteUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [progressLabel, setProgressLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<SiteProduct[]>([]);
  const [pagesFetched, setPagesFetched] = useState(0);
  const [stoppedReason, setStoppedReason] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [addedMsg, setAddedMsg] = useState("");
  const [deepProducts, setDeepProducts] = useState<DeepSiteProduct[]>([]);
  const [deepBusy, setDeepBusy] = useState(false);
  const [deepDone, setDeepDone] = useState(false);
  const [deepError, setDeepError] = useState<string | null>(null);
  const [deepProgress, setDeepProgress] = useState({ done: 0, total: 0, label: "" });
  const [zipBusy, setZipBusy] = useState(false);
  const [zipProgress, setZipProgress] = useState({ done: 0, total: 0 });
  const [excelBusy, setExcelBusy] = useState(false);
  const extractInFlightRef = useRef(false);

  const handleExtract = async () => {
    if (extractInFlightRef.current) return;

    let url = siteUrl.trim();
    if (!url) {
      setError("من فضلك الصق رابط الموقع أولاً");
      return;
    }
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

    extractInFlightRef.current = true;
    setError(null);
    setBusy(true);
    setProgressLabel("جارٍ فتح صفحة الموقع واستخراج المنتجات...");
    setProducts([]);
    setAddedMsg("");
    setStoppedReason("");
    setPagesFetched(0);

    try {
      const result = await extractSiteProducts(url, 500, 50000);
      setProducts(result.products || []);
      setPagesFetched(result.pagesFetched || 0);
      setStoppedReason(result.stoppedReason || "");
      if ((result.products || []).length > 0) {
        try {
          setSourceLabel(new URL(url).hostname.replace(/^www\./, ""));
        } catch {
          setSourceLabel(url);
        }
      } else {
        setError(
          result.stoppedReason
            ? `لم نعثر على منتجات. السبب: ${result.stoppedReason}. تأكد من أن الرابط صفحة قسم/بحث أو رابط منتج مباشر صحيح.`
            : "لم نعثر على منتجات في هذه الصفحة. تأكد من صحة الرابط وأن الموقع يسمح بالوصول الآلي."
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      extractInFlightRef.current = false;
      setBusy(false);
      setProgressLabel("");
    }
  };

  const handleAddAll = () => {
    if (products.length === 0) return;
    onAddLinks(products, sourceLabel);
    setAddedMsg(`تمت إضافة ${products.length} منتج إلى قائمة الاستخراج`);
  };

  const handleClear = () => {
    setProducts([]);
    setError(null);
    setAddedMsg("");
    setStoppedReason("");
    setPagesFetched(0);
    setDeepProducts([]);
    setDeepDone(false);
    setDeepError(null);
    setDeepProgress({ done: 0, total: 0, label: "" });
  };

  const handleDeepScrape = async () => {
    if (products.length === 0 || deepBusy) return;
    setDeepError(null);
    setDeepBusy(true);
    setDeepDone(false);
    setDeepProducts([]);
    const total = products.length;
    const merged: DeepSiteProduct[] = [];
    const merge = (result: DeepSiteProduct) => {
      const idx = merged.findIndex((m) => m.url === result.url);
      if (idx >= 0) merged[idx] = result;
      else merged.push(result);
    };
    setDeepProgress({ done: 0, total, label: "جارٍ سحب الأسعار والوصف وكل الصور..." });
    const CHUNK = 12;
    try {
      // منتجات بياناتها كاملة جاهزة (كتالوج Shopify) — تُستخدم مباشرة
      const readyProducts = products.filter(
        (p) => Array.isArray(p.images) && p.images.length > 0
      );
      for (const ready of readyProducts) {
        merge({
          url: ready.url,
          product_name: ready.product_name,
          product_name_ar: ready.product_name_ar || "",
          price: ready.price,
          description: ready.description || "",
          description_ar: ready.description_ar || "",
          description_en: ready.description_en || ready.description || "",
          images: ready.images || [],
          image_url: ready.image_url || ready.image_url_high || "",
          sku: ready.sku || "",
        });
      }
      if (readyProducts.length > 0) {
        setDeepProducts([...merged]);
        setDeepProgress({
          done: readyProducts.length,
          total,
          label: `تم استخدام بيانات ${readyProducts.length} منتج جاهزة، ويدور سحب الباقي...`,
        });
      }
      const remaining = products.filter((p) => !readyProducts.includes(p));
      for (let i = 0; i < remaining.length; i += CHUNK) {
        const chunk = remaining.slice(i, i + CHUNK);
        const results = await scrapeProductsBatch(chunk.map((p) => p.url));
        for (const result of results) merge(result);
        setDeepProducts([...merged]);
        const doneCount = Math.min(readyProducts.length + i + CHUNK, total);
        setDeepProgress({
          done: doneCount,
          total,
          label: `سحب بيانات المنتجات (الأسعار + الوصف + الصور)... (${doneCount}/${total})`,
        });
      }
      const withData = merged.filter((m) => !m.error && (m.product_name || m.images.length > 0)).length;
      setDeepDone(true);
      if (withData === 0) {
        setDeepError("لم يتمكن السحب الكامل من جلب بيانات أي منتج. جرّب مرة أخرى أو تأكد من أن الروابط صفحات منتجات.");
      }
    } catch (err) {
      setDeepError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeepBusy(false);
      setDeepProgress({ done: 0, total: 0, label: "" });
    }
  };

  const handleDownloadExcel = async () => {
    if (deepProducts.length === 0 || excelBusy) return;
    if (!/^[A-Z0-9]{2,}$/i.test(startSku.trim())) {
      setDeepError("أدخل SKU يحتوي على حرفين أو أكثر، مثل ABCD أو ABCD1000");
      return;
    }
    setExcelBusy(true);
    try {
      const productsWithSku = deepProducts.map((product, index) => ({
        ...product,
        sku: startSku.trim() ? generateSku(startSku.trim(), index) : product.sku || "",
      }));
      const blob = await buildSiteExcel(productsWithSku, buildFileNames(productsWithSku));
      downloadBlob(blob, `${sourceLabel || "المنتجات"}-بيانات-المنتجات.xlsx`);
    } catch (err) {
      setDeepError(`فشل إنشاء الشيت: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExcelBusy(false);
    }
  };

  const handleDownloadZip = async () => {
    if (deepProducts.length === 0 || zipBusy) return;
    if (!/^[A-Z0-9]{2,}$/i.test(startSku.trim())) {
      setDeepError("أدخل SKU يحتوي على حرفين أو أكثر، مثل ABCD أو ABCD1000");
      return;
    }
    setZipBusy(true);
    setZipProgress({ done: 0, total: 0 });
    try {
      const productsWithSku = deepProducts.map((product, index) => ({
        ...product,
        sku: startSku.trim() ? generateSku(startSku.trim(), index) : product.sku || "",
      }));
      const blob = await buildSiteImagesZip(productsWithSku, buildFileNames(productsWithSku), (done, total) =>
        setZipProgress({ done, total })
      );
      downloadBlob(blob, `${sourceLabel || "المنتجات"}-صور-المنتجات.zip`);
    } catch (err) {
      setDeepError(`فشل إنشاء ملف الصور: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setZipBusy(false);
      setZipProgress({ done: 0, total: 0 });
    }
  };

  const totalDeepImages = deepProducts.reduce((sum, p) => sum + p.images.length, 0);
  const deepOkCount = deepProducts.filter((p) => !p.error && (p.product_name || p.images.length > 0)).length;

  const thumbSrc = (product: SiteProduct): string => product.image_url || product.image_url_high || "";
  const visibleProducts = products.slice(0, 60);

  return (
    <div className="lg:col-span-3">
      <div className="card-3d p-5">
        <div className="flex items-center justify-between mb-1">
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <Globe className="w-4 h-4 text-sky-600" />
            سحب كل أقسام ومنتجات الموقع
          </label>
          {products.length > 0 && !busy && (
            <span className="pill-3d text-sky-600 bg-sky-50">
              <Images className="w-3 h-3" />
              {products.length} منتج
            </span>
          )}
        </div>

        <div className="flex flex-col sm:flex-row gap-3 mt-2">
          <div className="flex-1 relative">
            <Link2 className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300" />
            <input
              type="text"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleExtract();
                }
              }}
              placeholder="https://www.noon.com/eg-ar/... أو أي متجر"
              className="input-3d !pl-9"
              dir="ltr"
            />
          </div>
          <button
            type="button"
            onClick={() => void handleExtract()}
            disabled={busy}
            className={`btn-3d px-5 py-3 text-sm flex items-center justify-center gap-2 ${
              busy
                ? "bg-slate-400"
                : "bg-gradient-to-r from-sky-600 to-sky-500 shadow-sky-500/30"
            }`}
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                جارٍ السحب...
              </>
            ) : (
              <>
                <Wand2 className="w-4 h-4" />
                سحب كل الأقسام والمنتجات
              </>
            )}
          </button>
          {products.length > 0 && !busy && (
            <button
              type="button"
              onClick={handleClear}
              disabled={busy}
              className="btn-3d p-3 text-slate-500 bg-slate-100 border border-slate-200"
              title="مسح النتائج"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="mt-3 max-w-xs">
          <label className="block text-xs font-semibold text-slate-600 mb-1.5">
            أول SKU للمنتجات المسحوبة
          </label>
          <input
            type="text"
            value={startSku}
            onChange={(e) => setStartSku(e.target.value.toUpperCase())}
            placeholder="ABCD1000"
            className="input-3d w-full"
            dir="ltr"
            maxLength={8}
          />
          <p className="text-xs text-slate-400 mt-1">4 حروف + 4 أرقام، مثل ABCD1000</p>
        </div>

        <p className="text-xs text-slate-400 mt-1.5">
          الصق رابط موقع أو قسم كامل (نون، أمازون، شوبيفاي، EasyOrders...) وسيُستخرج كل منتج باسمه وصورته عالية الجودة،
          ثم أضفهم دفعة واحدة إلى قائمة الاستخراج لتحميلهم بملف Excel أو ZIP.
        </p>

        {busy && (
          <div className="mt-3 flex items-center gap-2 text-sm text-sky-600 rounded-xl bg-sky-50 border border-sky-200 px-3 py-2 animate-pulse-subtle">
            <Loader2 className="w-4 h-4 animate-spin" />
            {progressLabel}
            {pagesFetched > 0 && <span className="text-xs text-slate-400">(صفحات تمت: {pagesFetched})</span>}
          </div>
        )}

        {error && (
          <div className="mt-3 flex items-start gap-2 text-sm text-red-600 rounded-xl bg-red-50 border border-red-200 px-3 py-2">
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
{!busy && products.length > 0 && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/40">
            <div className="flex items-center gap-3 flex-wrap p-3">
              <span className="pill-3d text-sky-600 bg-sky-50">
                <Images className="w-3 h-3" />
                {products.length} منتج
              </span>
              {pagesFetched > 1 && (
                <span className="pill-3d text-slate-500 bg-slate-100">{pagesFetched} صفحات</span>
              )}
              <button
                type="button"
                onClick={handleAddAll}
                disabled={busy}
                className="btn-3d px-4 py-2 text-sm flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-emerald-500 shadow-emerald-500/30"
              >
                <CirclePlus className="w-4 h-4" />
                إضافة الكل إلى الاستخراج ({products.length})
              </button>
            </div>

            {addedMsg && (
              <p className="flex items-center gap-2 text-sm text-emerald-700 px-3 py-2">
                <CheckCircle2 className="w-4 h-4" />
                {addedMsg} — ثم اضغط زر «استخراج البيانات» بالأسفل لتحميلهم بالصور عالية الجودة و SKU.
              </p>
            )}

            <div className="grid gap-2 grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 max-h-64 overflow-y-auto p-3">
              {visibleProducts.map((product) => {
                const src = thumbSrc(product);
                return (
                  <a
                    key={product.url}
                    href={product.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group relative flex flex-col bg-white border border-slate-200 rounded-lg overflow-hidden hover:shadow-md hover:border-sky-300 transition-all"
                    title={product.product_name || product.url}
                  >
                    <div className="w-full aspect-square flex items-center justify-center bg-slate-100">
                      {src ? (
                        <img
                          src={src}
                          alt={product.product_name || "منتج"}
                          loading="lazy"
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                      ) : (
                        <Images className="w-6 h-6 text-slate-300" />
                      )}
                    </div>
                    <div className="px-1.5 py-1 leading-tight">
                      <p className="text-[10px] text-slate-500 line-clamp-2">
                        {product.product_name || "بدون اسم"}
                      </p>
                      {typeof product.price === "number" && (
                        <p className="text-[10px] font-semibold text-emerald-600" dir="ltr">
                          {product.price.toLocaleString("en-US")} EGP
                        </p>
                      )}
                    </div>
                  </a>
                );
              })}
            </div>

            {/* السحب الكامل: الأسعار + الوصف + كل الصور */}
            <div className="mt-3 pt-3 border-t border-slate-200">
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={() => void handleDeepScrape()}
                  disabled={busy || deepBusy || deepDone}
                  className={`btn-3d px-4 py-2 text-sm flex items-center gap-2 ${
                    deepDone
                      ? "bg-slate-300 text-slate-500"
                      : "bg-gradient-to-r from-indigo-600 to-indigo-500 shadow-indigo-500/30"
                  }`}
                >
                  {deepBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Database className="w-4 h-4" />}
                  {deepDone ? "تم السحب الكامل" : "سحب كامل: الأسعار + الوصف + كل صور كل منتج"}
                </button>

                {deepDone && deepOkCount > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => void handleDownloadExcel()}
                      disabled={excelBusy || zipBusy}
                      className="btn-3d px-4 py-2 text-sm flex items-center gap-2 bg-gradient-to-r from-green-600 to-green-500 shadow-green-500/30"
                    >
                      {excelBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}
                      تحميل شيت Excel
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDownloadZip()}
                      disabled={excelBusy || zipBusy}
                      className="btn-3d px-4 py-2 text-sm flex items-center gap-2 bg-gradient-to-r from-orange-600 to-orange-500 shadow-orange-500/30"
                    >
                      {zipBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderArchive className="w-4 h-4" />}
                      تحميل كل الصور (ZIP)
                    </button>
                  </>
                )}
              </div>

              <p className="text-xs text-slate-400 mt-1.5">
                يسحب لكل منتج: السعر، الوصف، وكل صوره بالجودة الكاملة — وتُحمَّل في شيت Excel وملف ZIP
                كل صورة فيه باسم منتجها (نفس الاسم الموجود في الشيت).
              </p>

              {deepBusy && (
                <div className="mt-2">
                  <div className="flex items-center gap-2 text-sm text-indigo-600">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {deepProgress.label}
                  </div>
                  {deepProgress.total > 0 && (
                    <div className="mt-1.5 h-2 rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-indigo-500 to-indigo-400 transition-all"
                        style={{ width: `${Math.round((deepProgress.done / deepProgress.total) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              )}

              {zipBusy && (
                <div className="mt-2 flex items-center gap-2 text-sm text-orange-600">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  جارٍ تحميل الصور بالجودة الكاملة... ({zipProgress.done}/{zipProgress.total})
                </div>
              )}

              {deepDone && deepOkCount > 0 && (
                <p className="flex items-center gap-2 text-sm text-emerald-700 mt-2">
                  <CheckCircle2 className="w-4 h-4" />
                  تم سحب {deepOkCount} منتج و {totalDeepImages} صورة — حمّل الشيت وملف الصور بالأعلى.
                  {deepProducts.length - deepOkCount > 0 && ` (${deepProducts.length - deepOkCount} منتج تعذّر سحبهم)`}
                </p>
              )}

              {deepError && (
                <div className="mt-2 flex items-start gap-2 text-sm text-red-600 rounded-xl bg-red-50 border border-red-200 px-3 py-2">
                  <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{deepError}</span>
                </div>
              )}
            </div>

            {products.length > visibleProducts.length && (
              <p className="text-xs text-slate-400 px-3 pt-2">
                تعرض أول {visibleProducts.length} منتج — كل النتائج ستُضاف عند الضغط على «إضافة الكل».
              </p>
            )}

            {stoppedReason && (
              <p className="text-xs text-slate-400 px-3 pt-1">{stoppedReason}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}