/* ============================================================
 * استخراج بيانات المنتج من صفحة HTML:
 * الاسم، السعر، العملة، الوصف، الصورة، روابط المنتج
 * ============================================================ */

const cheerio = require("cheerio");

const CURRENCY_SYMBOLS = [
  { code: "EGP", rx: /(EGP|E£|E\.?G\.?P|ج\.م|جنيه|جنيه مصري|جنية|LE\b)/i },
  { code: "USD", rx: /\$(?!E)|USD|دولار/i },
  { code: "SAR", rx: /\bSAR\b|ريال سعودي|ر\.?س/i },
  { code: "AED", rx: /\bAED\b|درهم|د\.?إ/i },
  { code: "EUR", rx: /€|EUR|يورو/i },
  { code: "GBP", rx: /£|GBP|جنيه إسترليني/i },
  { code: "KWD", rx: /KWD|دينار/i },
  { code: "QAR", rx: /\bQAR\b|ريال قطري/i },
  { code: "JOD", rx: /\bJOD\b|دينار أردني/i },
  { code: "MAD", rx: /درهم|MAD/i },
];

function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

/** أفضل جودة ممكنة: حاول إزالة محولات الأبعاد من رابط الصورة */
function highResUrl(url) {
  if (!url) return url;
  return url
    .replace(/\._AC_(?:SY|SX|UY|UX)\d+_/i, "._AC_SL1500_")
    .replace(/\._AC_UL\d+_/i, "._AC_UL1500_")
    .replace(/\._SL\d+_/i, "._SL1500_")
    .replace(/\._SX\d+_?\./gi, (m) => ".")
    .replace(/\?resize=\d+,\d+/i, "")
    .replace(/&\/(?:w|h)=\d+/gi, "")
    .replace(/\bw=\d+/gi, "")
    .replace(/_w\.\d+/i, "_w.2000")
    .replace(/_thegem-blog[\w-]*/i, "");
}

/** إيجاد سعر/عملة من نص */
function parsePrice(raw) {
  if (raw == null) return { price: null, currency: "" };
  const cleaned = cleanText(String(raw));
  if (!cleaned) return { price: null, currency: "" };

  for (const c of CURRENCY_SYMBOLS) {
    if (c.rx.test(cleaned)) {
      const fresh = cleaned.replace(c.rx, "");
      const m = fresh.match(/[\d][\d.,]*/);
      if (m) {
        const num = parseFloat(m[0].replace(/,/g, ""));
        if (Number.isFinite(num)) return { price: num, currency: c.code };
      }
    }
  }
  const m = cleaned.match(/(\d[\d.,]*)/);
  if (m) {
    const num = parseFloat(m[0].replace(/,/g, ""));
    if (Number.isFinite(num)) return { price: num, currency: "" };
  }
  return { price: null, currency: "" };
}

function cleanTabNewlines(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

/** قراءة كود JSON-LD من الصفحة */
function extractJsonLd($) {
  const items = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    const content = $(el).html() || "";
    try {
      const parsed = JSON.parse(content);
      items.push(parsed);
      if (parsed["@graph"] && Array.isArray(parsed["@graph"])) items.push(...parsed["@graph"]);
    } catch {
      const matches = content.match(/\{[\s\S]*?\}/g) || [];
      for (const m of matches.slice(0, 5)) {
        try { items.push(JSON.parse(m)); } catch { /* ignore */ }
      }
    }
  });
  return items;
}

/** جمع صور og:image من منافذ مختلفة */
function collectImages($, baseUrl) {
  const abs = (u) => {
    if (!u) return u;
    try { return new URL(u, baseUrl).href; } catch { return u; }
  };
  const images = [];
  const push = (u) => {
    const a = abs(u);
    if (a && /\.(jpe?g|png|webp|gif|avif|bmp|svg)(\?|$)/i.test(a) && !images.includes(a)) images.push(a);
  };

  $('meta[property="og:image"]').each((i, el) => push($(el).attr("content")));
  $('meta[name="twitter:image"]').each((i, el) => push($(el).attr("content")));
  $('link[rel="image_src"]').each((i, el) => push($(el).attr("href")));
  $('meta[itemprop="image"]').each((i, el) => push($(el).attr("content")));
  $("img").each((i, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-lazy-src") || "";
    if (!src) return;
    const a = abs(src);
    if (/\.(jpe?g|png|webp|gif|avif|bmp|svg)(\?|$)/i.test(a)) {
      const w = parseInt($(el).attr("width") || "", 10);
      const h = parseInt($(el).attr("height") || "", 10);
      if (w >= 300 && h >= 300 && !images.includes(a)) images.push(a);
    }
  });
  return images;
}

/** استخراج السعر/العملة من JSON-LD أو meta أو نص الصفحة */
function extractPriceInfo($, text) {
  const ld = extractJsonLd($);
  for (const item of ld) {
    const offers = item && item.offers ? item.offers : null;
    if (offers && (offers.price || offers.lowPrice || offers.highPrice)) {
      const pr = offers.price || offers.lowPrice || offers.highPrice;
      const val = typeof pr === "object" ? pr.value : pr;
      return { price: parseFloat(val), currency: offers.priceCurrency || "" };
    }
  }
  const metaPrice = $('meta[itemprop="price"]').attr("content") || $('meta[property="product:price:amount"]').attr("content");
  if (metaPrice) {
    const currency = $('meta[itemprop="priceCurrency"]').attr("content") || $('meta[property="product:price:currency"]').attr("content") || "";
    return { price: parseFloat(metaPrice.replace(/,/g, "")), currency };
  }
  const priceText = text.match(/(?:[^\d]{0,20})(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)\s*(EGP|LE|AED|SAR|USD|EUR|GBP|ج\.م|درهم|ريال|دولار|دينار|TND|MAD|KWD|QAR)?/i);
  return parsePrice(priceText && priceText[0] ? priceText[0] : "");
}

function extractDescription($) {
  let desc = cleanText($('meta[property="og:description"]').attr("content") || "");
  if (desc.length > 15) return desc;
  desc = cleanText($('meta[name="description"]').attr("content") || "");
  if (desc.length > 15) return desc;
  desc = cleanText($('meta[itemprop="description"]').attr("content") || "");
  if (desc.length > 15) return desc;
  desc = cleanText(
    $("#product-description, .product-description, .description, .woocommerce-product-details__short-description, .tab-pane, [itemprop='description']").first().text()
  );
  if (desc.length > 15) return desc;
  return "";
}

/**
 * استخراج كل البيانات من صفحة منتج
 */
function extractProduct(html, productUrl) {
  const $ = cheerio.load(html);

  // الاسم
  let product_name = cleanText($('meta[property="og:title"]').attr("content") || "");
  if (!product_name) product_name = cleanText($("h1").first().text() || "");
  if (!product_name) product_name = cleanText($("title").first().text() || "");
  if (!product_name) product_name = cleanText($('[itemprop="name"]').first().text() || "");
  // إزالة اسم الموقع من العنوان إن وُجد
  if (product_name.includes(" | ")) {
    const parts = product_name.split(" | ").filter(Boolean);
    product_name = parts.length > 1 ? parts.slice(0, parts.length - 1).join(" | ") : product_name;
  } else if (product_name.includes(" - ")) {
    const parts = product_name.split(" - ").filter(Boolean);
    product_name = parts.length > 1 ? parts.slice(0, parts.length - 1).join(" - ") : product_name;
  }

  const plainText = $("body").text().replace(/\s+/g, " ");
  const priceInfo = extractPriceFrom($, plainText);
  const description = extractDescription($);
  const images = collectImages($, productUrl);
  const image = images[0] || "";

  // SKU داخلي إن وُجد
  let internalSku = cleanText($('[itemprop="sku"]').first().attr("content") || $('[itemprop="sku"]').first().text() || "");
  if (!internalSku) {
    const ld = extractJsonLd($);
    for (const item of ld) {
      if (item && item.sku) { internalSku = String(item.sku).trim(); break; }
    }
  }

  return {
    product_name,
    price: priceInfo.price,
    currency: priceInfo.currency,
    description,
    image_url: image,
    image_url_high: highResUrl(image),
    images: images.map(highResUrl),
    product_url: productUrl,
    sku: internalSku || "",
  };
}

module.exports = { extractProduct, parsePrice, highResUrl, cleanText, extractJsonLd, collectImages };