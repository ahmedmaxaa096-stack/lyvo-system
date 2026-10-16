/* ============================================================
 * البحث عن منتج داخل موقع البراند:
 *  1) محرك بحث الموقع (WooCommerce/Magento/Shopify/عام)
 *  2) فهرس sitemap روابط المنتجات
 *  3) Google Programmable Search إذا كان مُجهَّزًا
 * ثم قياس التطابق (الاسم + الحجم + اللون + الموديل + العدد)
 * ============================================================ */

const { fetchHtml, fetchJson, fetchSitemapUrls } = require("./fetch");
const { extractProduct } = require("./extractor");
const { matchName, extractAttributes, normalizeKey } = require("./normalize");
const cheerio = require("cheerio");

/* ---------- استخراج روابط الكروت من صفحة بحث/تصفح ---------- */
function extractCardLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const abs = (u) => { try { return new URL(u, baseUrl).href; } catch { return u; } };
  const cards = [];
  const seen = new Set();

  $("li.product, .product-item, .product, .card, [data-product-id], figure, .item-product, article")
    .each((i, el) => {
      const $el = $(el);
      const a = $el.find("a").first();
      const href = a.attr("href");
      if (!href) return;
      const url = abs(href);
      if (seen.has(url)) return;
      if (/(\/(cart|checkout|login|search|blog|about|contact|wishlist|account)\/)/i.test(url)) return;
      const title = String(a.attr("title") || a.text() || $el.find(".product-title, h2, h3, .name, .title").first().text() || "")
        .replace(/\s+/g, " ").trim();
      const img = ($el.find("img").first().attr("src") || $el.find("img").first().attr("data-src") || "").trim();
      const priceRaw = $el.find(".price, .woocommerce-Price-amount, .product-price, [itemprop='price']").first().text()
        .replace(/\s+/g, " ").trim();
      if (!title) return;
      seen.add(url);
      cards.push({ url, title, image_url: abs(img), price_text: priceRaw });
    });

  if (cards.length === 0) {
    $("a").each((i, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const url = abs(href);
      if (/\.(jpe?g|png|css|js|xml)(\?|$)/i.test(url)) return;
      if (/(\.(cart|checkout|login|blog|about|contact|wishlist)\/|#)/i.test(url)) return;
      if (seen.has(url)) return;
      const title = ($(el).text() || $(el).attr("title") || "").replace(/\s+/g, " ").trim();
      if (!title) return;
      const img = ($(el).find("img").first().attr("src") || "").trim();
      seen.add(url);
      cards.push({ url, title, image_url: abs(img), price_text: "" });
    });
  }
  return cards.slice(0, 60);
}

/* --------------- بناء روابط البحث حسب المنصة ---------------- */
function buildSearchUrls(siteUrl, query) {
  const origin = String(siteUrl).replace(/\/+$/, "");
  const q = encodeURIComponent(query);
  return [
    `${origin}/?s=${q}&post_type=product`,   // WooCommerce
    `${origin}/search?q=${q}&type=product`,  // Shopify
    `${origin}/search/products/?q=${q}`,
    `${origin}/catalogsearch/result/?q=${q}`,// Magento
    `${origin}/search?q=${q}`,
    `${origin}/search/${q}`,
    `${origin}/products/?search=${q}`,
  ];
}

/** فحص صفحة بحث واحدة وجمع الكروت */
async function probeSearch(siteUrl, query) {
  const urls = buildSearchUrls(siteUrl, query);
  for (const u of urls) {
    try {
      const { text, url } = await fetchHtml(u, 25000);
      const cards = extractCardLinks(text, url);
      if (cards.length > 0) return { source: u, cards };
    } catch { /* جرّب التالي */ }
  }
  return null;
}

/** فهرس sitemap يحفظ جلسة واحدة */
let sitemapCache = null;
async function getSiteCatalog(state) {
  if (sitemapCache) return sitemapCache;
  const links = await fetchSitemapUrls(state.siteUrl, 250);
  sitemapCache = links;
  return links;
}

/** Google CSE اختياري */
async function tryGoogleSearch(state, query) {
  const key = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_ID;
  if (!key || !cx) return [];
  let origin;
  try { origin = new URL(state.siteUrl).origin.replace(/^https?:\/\//, ""); } catch { return []; }
  try {
    const { data } = await fetchJson(
      `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent("site:" + origin + " " + query)}&num=10`,
      20000
    );
    return (data.items || []).map((it) => ({
      url: it.link,
      title: it.title,
      image_url: (it.pagemap && it.pagemap.cse_image && it.pagemap.cse_image[0] && it.pagemap.cse_image[0].src) || "",
      price_text: (it.pagemap && it.pagemap.offer && it.pagemap.offer[0] && it.pagemap.offer[0].price) || "",
      source: "google",
    }));
  } catch { return []; }
}

/* --------------- المطابقة واختيار الأفضل ---------------- */
function scoredCandidates(originalName, cards) {
  const attr = extractAttributes(originalName);
  const list = cards.map((c) => {
    const m = matchName(originalName, c.title || "");
    const cAttr = extractAttributes(c.title || "");
    let attrBonus = 0;
    for (const k of ["size", "color", "model", "pack"]) {
      const A = attr[k], B = cAttr[k];
      if (A.length && B.length) {
        for (const a of A) if (B.includes(a)) attrBonus += 0.06;
        for (const a of A) if (!B.includes(a)) attrBonus -= 0.1;
      }
    }
    const score = Math.max(0, Math.min(1, m.score * 0.8 + attrBonus));
    return { ...c, score: Math.round(score * 1000) / 1000, matchDetail: m.detail };
  });
  return list.filter((c) => c.score > 0.15).sort((a, b) => b.score - a.score);
}

/**
 * البحث الشامل: يعيد { candidates, best, status }
 *  status: matched | review | not_found
 */
async function searchProduct(state, productName, opts = {}) {
  const results = [];
  const add = (cards) => {
    for (const c of cards) {
      if (!results.some((r) => r.url === c.url)) results.push(c);
    }
  };

  // 1) بحث موقع البراند
  const probe = await probeSearch(state.siteUrl, productName);
  if (probe) add(probe.cards);

  // 2) روابط sitemap المطابقة (موديل/رقم)
  try {
    const catalog = await getSiteCatalog(state);
    if (catalog.length) {
      const core = normalizeKey(productName).replace(/[^a-z0-9]/g, "");
      const tokens = normalizeKey(productName).split(" ").filter((t) => t.length >= 3);
      const attr = extractAttributes(productName);
      const plausible = catalog.filter((u) => {
        const uk = normalizeKey(decodeURIComponent(u));
        if (core.length > 4 && uk.includes(core)) return true;
        for (const t of tokens) if (uk.includes(t)) return true;
        if (attr.model.length) for (const mo of attr.model) if (uk.includes(mo.replace(/[^a-z0-9]/g, ""))) return true;
        return false;
      });
      for (const u of plausible.slice(0, 10)) {
        const title = decodeURIComponent(u.split("/").filter(Boolean).pop() || u).replace(/[-_]+/g, " ");
        results.push({ url: u, title, image_url: "", price_text: "", source: "sitemap" });
      }
    }
  } catch { /* sitemap غير متاح */ }

  // 3) Google CSE (اختياري)
  try {
    const g = await tryGoogleSearch(state, productName);
    add(g);
  } catch { /* غير مُجهَّض */ }

  const scored = scoredCandidates(productName, results);
  if (scored.length === 0) {
    return { candidates: [], best: null, status: "not_found", note: "لم يُعثر على أي منتج قريب في الموقع" };
  }

  const best = scored[0];
  const second = scored[1];
  const status =
    best.score >= 0.72 && (!second || best.score - second.score >= 0.18)
      ? "matched"
      : best.score >= 0.45
      ? "review"
      : "not_found";

  return {
    candidates: scored.slice(0, 6).map(({ url, title, image_url, price_text, score, matchDetail }) => ({
      url, title, image_url, price_text, score: Math.round(score * 100) / 100, detail: matchDetail,
    })),
    best,
    status,
    note:
      status === "matched" ? `تطابق قوي ${Math.round(best.score * 100)}%`
      : status === "review" ? "أكثر من احتمال — يرجى مراجعة الخيارات"
      : "لا يوجد تطابق كافٍ",
  };
}

/** جلب تفاصيل منتج من صفحة معينة */
async function fetchProductDetails(url) {
  const { text, url: finalUrl } = await fetchHtml(url, 45000);
  return extractProduct(text, finalUrl);
}

module.exports = { searchProduct, fetchProductDetails, extractCardLinks };