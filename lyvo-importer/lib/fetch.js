/* ============================================================
 * الجلب من خدمة الخلفية (وليست من المتصفح):
 * صفحات HTML، ملفات JSON، Sitemap
 * ============================================================ */

const axios = require("axios");

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const cache = new Map();

/** الجلب الأساسي — يعيد { text, url, status, headers } أو يرمي خطأ مفهومًا */
async function fetchHtml(url, timeout = 40000) {
  const cacheKey = url + "#" + timeout;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  try {
    const res = await axios.get(url, {
      timeout,
      maxRedirects: 6,
      responseType: "text",
      headers: {
        "User-Agent": DESKTOP_UA,
        Accept: "text/html,application/xhtml+xml,application/json,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.8,ar;q=0.6",
        "Cache-Control": "no-cache",
      },
    });
    const out = {
      text: typeof res.data === "string" ? res.data : JSON.stringify(res.data),
      url: res.request?.res?.responseUrl || res.config?.url || url,
      status: res.status,
      headers: res.headers,
    };
    cache.set(cacheKey, out);
    return out;
  } catch (e) {
    const status = e.response ? e.response.status : 0;
    const cause =
      status === 403 ? "الموقع رفض الوصول (403) — قد يكون محميًا بمنع الجلب"
      : status === 404 ? "الصفحة غير موجودة (404)"
      : status === 429 ? "الموقع يطلب مهلة (429) — حاول لاحقًا"
      : e.code === "ECONNABORTED" ? "انتهت مهلة الاتصال"
      : e.code === "ENOTFOUND" ? "لم يُعثر على النطاق"
      : e.code === "ECONNREFUSED" ? "تعذر الاتصال بالموقع"
      : (e.message || "فشل الجلب");
    throw new Error(`${url} → ${status ? "HTTP " + status + " · " : ""}${cause}`);
  }
}

/** جلب JSON من Endpoint */
async function fetchJson(url, timeout = 30000) {
  const res = await axios.get(url, {
    timeout,
    maxRedirects: 5,
    headers: { "User-Agent": DESKTOP_UA, Accept: "application/json" },
  });
  return { data: res.data, url: res.request?.res?.responseUrl || url, status: res.status };
}

/** إحضار روابط المنتجات من sitemap.xml / sitemap index */
async function fetchSitemapUrls(baseUrl, limit = 80) {
  const origin = new URL(baseUrl).origin;
  const candidates = [];
  const seen = new Set();

  const fetchSitemap = async (url, depth) => {
    if (depth > 2 || seen.has(url) || candidates.length >= limit) return;
    seen.add(url);
    let text;
    try {
      text = (await fetchHtml(url, 20000)).text;
    } catch { return; }
    const locs = [...text.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim());
    if (!locs.length) return;
    // sitemap index أم قائمة صفرية؟
    if (locs.every((l) => /\.xml(\?|$)/i.test(l))) {
      for (const l of locs.slice(0, 4)) await fetchSitemap(l, depth + 1);
    } else {
      for (const l of locs) {
        if (candidates.length >= limit) break;
        candidates.push(l);
      }
    }
  };

  // robots.txt أولاً
  try {
    const robots = (await fetchHtml(origin + "/robots.txt", 15000)).text;
    const sm = robots.match(/^Sitemap:\s*(\S+)/gim);
    if (sm) {
      for (const line of sm.slice(0, 5)) {
        const m = line.match(/^Sitemap:\s*(\S+)/i);
        if (m) await fetchSitemap(m[1], 1);
      }
    }
  } catch { /* robots قد تكون ممنوعة */ }

  // محاولة sitemap.xml مباشرة إذا لم نجد شيئًا
  if (!candidates.length) {
    await fetchSitemap(origin + "/sitemap.xml", 1);
    await fetchSitemap(origin + "/sitemap_index.xml", 1);
  }

  return candidates.slice(0, limit);
}

module.exports = { DESKTOP_UA, fetchHtml, fetchJson, fetchSitemapUrls };