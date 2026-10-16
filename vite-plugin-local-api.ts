import type { Plugin } from "vite";

interface ProductData {
  product_name: string;
  price: number | null;
  image_url: string;
  image_url_high: string;
  description_ar: string;
  description_en: string;
}

function extractMetaContent(html: string, property: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]*property=["']${property}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]*name=["']${property}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*property=["']${property}["']`, "i"),
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${property}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) return repairUtf8Mojibake(match[1].trim());
  }
  return null;
}

function extractDescriptionFromHtml(html: string): string | null {
  const ogDesc = extractMetaContent(html, "og:description");
  if (ogDesc && ogDesc.length > 20) return ogDesc;

  const twitterDesc = extractMetaContent(html, "twitter:description");
  if (twitterDesc && twitterDesc.length > 20) return twitterDesc;

  const metaDesc = extractMetaContent(html, "description");
  if (metaDesc && metaDesc.length > 20) return metaDesc;

  const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch && jsonLdMatch[1]) {
    try {
      const json = JSON.parse(jsonLdMatch[1].trim());
      if (json.description && json.description.length > 20) return json.description;
    } catch {
      // ignore JSON parse errors
    }
  }

  return null;
}

function extractProductOverviewDescription(html: string): string | null {
  const opening = /<div\b(?=[^>]*\bid\s*=\s*["']overview["'])[^>]*>/i.exec(html);
  if (!opening || typeof opening.index !== "number") return null;

  const contentStart = opening.index + opening[0].length;
  const divTags = /<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->|<\/?div\b[^>]*>/gi;
  divTags.lastIndex = contentStart;
  let depth = 1;
  let match: RegExpExecArray | null;

  while ((match = divTags.exec(html)) !== null) {
    if (/^<\/div\b/i.test(match[0])) {
      depth -= 1;
      if (depth === 0) {
        const description = cleanDescription(stripTags(html.slice(contentStart, match.index)));
        return description || null;
      }
    } else if (/^<div\b/i.test(match[0]) && !/\/\s*>$/.test(match[0])) {
      depth += 1;
    }
  }

  return null;
}

function getHighResUrl(url: string): string {
  // Try to upgrade to high-res by replacing size markers in the URL path
  const upgraded = url
    .replace(/\._AC_(?:SY|SX|UY|UX)\d+_/i, "._AC_SL1500_")
    .replace(/\._AC_UL\d+_/i, "._AC_UL1500_")
    .replace(/\._SL\d+_/i, "._SL1500_")
    .replace(/\/\d+x\d+\//, "/1500x1500/")
    .replace(/_w\.\d+/i, "_w.2000")
    .replace(/_\d+w/i, "_2000w")
    .replace(/-ql-\d+/i, "-ql-100")
    .replace(/-width-\d+/i, "-width-2000");

  // If no changes were made, return the original URL
  if (upgraded === url) return url;

  return upgraded;
}

function isDirectImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // روابط مباشرة تنتهي بامتداد صورة
    if (/\.(jpe?g|jfif|png|webp|gif|avif|bmp|svg)$/i.test(parsed.pathname)) return true;
    // Google يقدم الصور المصغرة عبر روابط بلا امتداد في المسار، مثل:
    // https://encrypted-tbn0.gstatic.com/images?q=tbn:...
    // https://lh3.googleusercontent.com/...
    const host = parsed.hostname.toLowerCase();
    if (/(^|\.)gstatic\.com$/i.test(host)) return true;
    if (/(^|\.)googleusercontent\.com$/i.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}
/* آخر نتيجة جلب لصفحة — تُستخدم لشرح سبب الفشل الحقيقي للمستخدم بدل الرسائل العامة */
const lastPageFetch: { status: number; error: string } = { status: 0, error: "" };

export function isAmazonNetworkResetError(url: string, error: unknown): boolean {
  if (!/amazon\./i.test(url)) return false;
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const message = error instanceof Error
    ? `${error.name}: ${error.message}${cause ? ` ${String(cause)}` : ""}`
    : String(error);
  return /(?:ECONRESET|fetch failed|The operation was aborted|AbortError|socket hang up|read ECONRESET)/i.test(message);
}

export function shouldLogFetchError(url: string, error: unknown): boolean {
  return !isAmazonNetworkResetError(url, error);
}

async function fetchProductPage(
  url: string,
  timeout: number = 45000,
  maxAttempts: number = 2
): Promise<string> {
  lastPageFetch.status = 0;
  lastPageFetch.error = "";
  const headerOptions: Record<string, string>[] = [
    {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
    },
    {
      "User-Agent": "Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
    },
  ];

  const isAmazon = /amazon\./i.test(url);
  let fallbackHtml = "";
  
  for (const headers of headerOptions.slice(0, maxAttempts)) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const pageResponse = await fetch(url, { 
        headers, 
        redirect: "follow",
        signal: controller.signal,
      });
      
      if (!pageResponse.ok) {
        lastPageFetch.status = pageResponse.status;
        continue;
      }
      const html = await pageResponse.text();
      
      if (isAmazon) {
        // يجب أن تحتوي صفحة منتج أمازون الحقيقية على أحد هذه العلامات
        if (
          html.includes('id="productTitle"') ||
          html.includes("data-a-dynamic-image") ||
          html.includes("colorImages")
        ) {
          return html;
        }
      } else {
        return html;
      }
      fallbackHtml = html;
    } catch (err) {
      // جرّب خيار الرؤوس التالي. إذا كان المصدر أمازونًا ويقطع الاتصال فجأة، لا نرمي رسائل متكررة
      lastPageFetch.error = err instanceof Error ? err.message : String(err);
      if (shouldLogFetchError(url, err)) {
        console.error(`Failed to fetch ${url}:`, err);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return fallbackHtml;
}

function extractAmazonTitle(html: string): string | null {
  // Try Amazon title span
  const titleMatch = html.match(/<span[^>]*id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i);
  if (titleMatch && titleMatch[1]) {
    return titleMatch[1].replace(/\s+/g, " ").trim();
  }
  // Try h1 with id title
  const h1Match = html.match(/<h1[^>]*id=["']title["'][^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match && h1Match[1]) {
    return h1Match[1].replace(/\s+/g, " ").trim();
  }
  return null;
}

function extractAmazonPrice(html: string): number | null {
  // Try various Amazon price selectors
  const pricePatterns = [
    /<span[^>]*id=["']priceblock_ourprice["'][^>]*>([\s\S]*?)<\/span>/i,
    /<span[^>]*id=["']priceblock_dealprice["'][^>]*>([\s\S]*?)<\/span>/i,
    /<span[^>]*id=["']priceblock_saleprice["'][^>]*>([\s\S]*?)<\/span>/i,
    /<span[^>]*class=["'][^"']*a-price-whole["'][^>]*>([\s\S]*?)<\/span>/i,
  ];
  for (const pattern of pricePatterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      const priceStr = match[1].replace(/[^\d.,]/g, "").replace(/,/g, "");
      const price = parseFloat(priceStr);
      if (!isNaN(price) && price > 0) return price;
    }
  }
  return null;
}

function cleanUpImageUrl(value: string): string {
  return value
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x2F;/g, "/")
    .replace(/\\\//g, "/")
    .trim();
}

function upgradeAmazonImageUrl(url: string): string {
  return url
    .replace(/\._AC_(?:SY|SX|UY|UX)\d+_/i, "._AC_SL1500_")
    .replace(/\._AC_UL\d+_/i, "._AC_UL1500_")
    .replace(/\._SL\d+_/i, "._SL1500_");
}

function extractAmazonImages(html: string): { image_url: string; image_url_high: string } | null {
  const candidates: string[] = [];
  const addCandidate = (value: string | undefined) => {
    if (!value) return;
    let imageUrl = cleanUpImageUrl(value);
    // أحياناً يلتصق بالرابط نص JSON مثل &quot;:[355,303],&quot; بعد امتداد الصورة، اقطعه
    const trimmed = imageUrl.match(/^(https?:\/\/[^\s"'<>]+?\.(?:jpe?g|png|webp|gif|avif))/i);
    if (trimmed) imageUrl = trimmed[1];
    if (/^https?:\/\//i.test(imageUrl) && !candidates.includes(imageUrl)) {
      candidates.push(imageUrl);
    }
  };

  const oldHiResMatch = html.match(/id=["']landingImage["'][^>]*data-old-hires=["']([^"']+)["']/i);
  addCandidate(oldHiResMatch?.[1]);

  const landingImageMatch = html.match(/id=["']landingImage["'][^>]*src=["']([^"']+)["']/i);
  addCandidate(landingImageMatch?.[1]);

  const colorImagesMatch = html.match(/(?:colorImages|imageGalleryData)[\s\S]{0,2000}?https?:[\\/]{2}[^"'\s]+/i);
  if (colorImagesMatch && colorImagesMatch[0]) {
    const urlMatch = cleanUpImageUrl(colorImagesMatch[0]).match(/https?:[\\/]{2}[^"'\s]+/i);
    addCandidate(urlMatch?.[0]);
  }

  // Try JSON-LD
  const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch && jsonLdMatch[1]) {
    try {
      const json = JSON.parse(jsonLdMatch[1].trim());
      if (json.image) {
        const img = Array.isArray(json.image) ? json.image[0] : json.image;
        if (typeof img === "string") {
          addCandidate(img);
        }
      }
    } catch {
      // ignore JSON parse errors
    }
  }

  // data-a-dynamic-image: كائن JSON يربط روابط الصور بأبعاد العرض.
  // القيم تكون مفردة '...' أو مزدوجة "..." مع ترميز HTML للأقواس الداخلية (&quot;).
  const dynamicImages = html.matchAll(/\bdata-a-dynamic-image\s*=\s*(["'])([\s\S]*?)\1/gi);
  for (const match of dynamicImages) {
    const jsonText = match[2]
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&apos;/g, "'");
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed && typeof parsed === "object") {
        for (const key of Object.keys(parsed)) addCandidate(key);
      }
    } catch {
      const urls = jsonText.match(/https?:[\\/]{2}[^\s"'<>,]+?\.(?:jpe?g|png|webp|gif|avif)/gi) || [];
      urls.forEach(addCandidate);
    }
  }

  const productImages = html.matchAll(/(?:src|data-a-hires)=["'](https?:\/\/[^"']*amazon[^"']*\/images\/I\/[^"']+)["']/gi);
  for (const match of productImages) addCandidate(match[1]);

  const ogImage = extractMetaContent(html, "og:image");
  addCandidate(ogImage || undefined);

  const image = candidates[0];
  return image
    ? { image_url: image, image_url_high: upgradeAmazonImageUrl(image) }
    : null;
}

function extractAmazonFallback(url: string): { product_name?: string; image_url: string } | null {
  let normalizedUrl = url;
  try {
    normalizedUrl = decodeURIComponent(url);
  } catch {
    // Use the original URL when it contains malformed encoding.
  }
  const asinMatch = normalizedUrl.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|[?&]asin=)([A-Z0-9]{10})(?:[/?&#]|$)/i)
    || normalizedUrl.match(/amazon\.[^/]+\/(?:[^/?]+\/)?([A-Z0-9]{10})(?:[/?&#]|$)/i)
    || normalizedUrl.match(/(?:^|[/?=&])([A-Z0-9]{10})(?:[/?&#]|$)/i);
  if (!asinMatch) return null;

  let productName: string | undefined;
  try {
    const path = decodeURIComponent(new URL(normalizedUrl).pathname);
    const slug = path.split("/dp/")[0].split("/gp/")[0].split("/product/")[0].replace(/^\//, "");
    if (slug && !/^(?:dp|gp|aw|d)$/i.test(slug)) {
      productName = slug.split("/").pop()?.replace(/[-_]+/g, " ").trim();
    }
  } catch {
    // Keep the ASIN image fallback when the URL cannot be parsed.
  }

  return {
    product_name: productName,
    image_url: `https://images-na.ssl-images-amazon.com/images/P/${asinMatch[1].toUpperCase()}.01.LZZZZZZZ.jpg`,
  };
}

function extractAmazonDescription(html: string): string | null {
  // Try productDescription div
  const descMatch = html.match(/<div[^>]*id=["']productDescription["'][^>]*>([\s\S]*?)<\/div>/i);
  if (descMatch && descMatch[1]) {
    const text = descMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length > 20) return text;
  }

  // Try feature-bullets
  const bulletsMatch = html.match(/<div[^>]*id=["']feature-bullets["'][^>]*>([\s\S]*?)<\/div>/i);
  if (bulletsMatch && bulletsMatch[1]) {
    const text = bulletsMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length > 20) return text;
  }

  // Try JSON-LD description
  const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch && jsonLdMatch[1]) {
    try {
      const json = JSON.parse(jsonLdMatch[1].trim());
      if (json.description && json.description.length > 20) return json.description;
    } catch {
      // ignore JSON parse errors
    }
  }

  return null;
}

function extractProductOverview(html: string): string | null {
  const source = String(html || "");
  const headingPattern = /<h[1-6][^>]*>[\s\S]{0,300}?Product\s+Overview[\s\S]{0,300}?<\/h[1-6]>/i;
  const heading = headingPattern.exec(source);
  if (heading) {
    const afterHeading = source.slice(heading.index + heading[0].length);
    const nextHeading = /<h[1-6][^>]*>/i.exec(afterHeading);
    const section = nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading.slice(0, 12000);
    const text = stripTags(section).replace(/\s+/g, " ").trim();
    if (text.length > 20) return text;
  }

  const labelledText = source.match(/(?:Product\s+Overview|productOverview)\s*[:=]\s*["']([^"']{20,})["']/i);
  if (labelledText?.[1]) return htmlDecodeUntrusted(labelledText[1]).trim();

  const plainText = stripTags(source).replace(/\s+/g, " ").trim();
  const overviewIndex = plainText.search(/Product\s+Overview/i);
  if (overviewIndex >= 0) {
    const afterOverview = plainText
      .slice(overviewIndex + plainText.match(/Product\s+Overview/i)![0].length)
      .trim();
    const nextSection = afterOverview.search(
      /\b(?:Specifications|Specification|Product\s+Details|Details|Highlights|What's\s+in\s+the\s+box|Reviews|Customer\s+Reviews|Description)\b/i
    );
    const text = (nextSection >= 0 ? afterOverview.slice(0, nextSection) : afterOverview.slice(0, 12000)).trim();
    if (text.length > 20) return text;
  }

  return null;
}

function extractFromHtml(html: string): Partial<ProductData> {
  const result: Partial<ProductData> = {};
  const saveOriginalDescription = (description: string) => {
    if (!description) return;
    if (/[\u0600-\u06FF]/.test(description)) result.description_ar = description;
    else result.description_en = description;
  };

  // Detect if this is an Amazon page
  const isAmazon = /amazon\./i.test(html) || /amazon\./i.test(html.substring(0, 5000));

  if (isAmazon) {
    // Amazon-specific extraction
    const amazonTitle = extractAmazonTitle(html);
    if (amazonTitle) result.product_name = amazonTitle;

    const amazonPrice = extractAmazonPrice(html);
    if (amazonPrice) result.price = amazonPrice;

    const amazonImages = extractAmazonImages(html);
    if (amazonImages) {
      result.image_url = amazonImages.image_url;
      result.image_url_high = amazonImages.image_url_high;
    }

    const amazonDesc = extractAmazonDescription(html);
    if (amazonDesc) saveOriginalDescription(amazonDesc);
  }

  const discountedPriceMatch = html.match(
    /(?:sale_price|salePrice|discounted_price|discountedPrice|final_price|finalPrice|current_price|currentPrice|offer_price|offerPrice)\s*[:=]\s*["']?([\d,]+(?:\.\d+)?)/i
  );
  if (discountedPriceMatch) {
    const discountedPrice = Number.parseFloat(discountedPriceMatch[1].replace(/,/g, ""));
    if (Number.isFinite(discountedPrice) && discountedPrice > 0) result.price = discountedPrice;
  }

  const productOverview = extractProductOverview(html);
  if (productOverview) saveOriginalDescription(productOverview);

  // Noon-specific extraction (also works as fallback for Amazon)
  const ogTitle = extractMetaContent(html, "og:title");
  const twitterTitle = extractMetaContent(html, "twitter:title");
  if (!result.product_name) {
    if (ogTitle) result.product_name = ogTitle.replace(/\s*[-|]\s*noon.*/i, "").trim();
    else if (twitterTitle) result.product_name = twitterTitle.replace(/\s*[-|]\s*noon.*/i, "").trim();
  }

  const ogImage = extractMetaContent(html, "og:image");
  const twitterImage = extractMetaContent(html, "twitter:image");
  if (!result.image_url) {
    if (ogImage) {
      result.image_url = ogImage;
      result.image_url_high = ogImage;
    } else if (twitterImage) {
      result.image_url = twitterImage;
      result.image_url_high = twitterImage;
    }
  }

  // Extract price from catalog data (variants -> offers -> price)
  if (!result.price) {
    const priceMatch = html.match(/price:(\d+)/);
    if (priceMatch && priceMatch[1]) {
      const price = parseInt(priceMatch[1]);
      if (price > 0) result.price = price;
    }
  }

  // Extract the main product image from image_urls (first one is the main image)
  if (!result.image_url) {
    const imageUrlsMatch = html.match(/image_urls:\$R\[\d+\]=\[([^\]]+)\]/);
    if (imageUrlsMatch && imageUrlsMatch[1]) {
      const urls = imageUrlsMatch[1]
        .match(/https:\/\/f\.nooncdn\.com\/p\/pzsku\/[^"']+/g)
        ?.map((u) => u.replace(/"/g, "").trim())
        .filter((u) => u.length > 0);

      if (urls && urls.length > 0) {
        // Take only the first (main) image
        result.image_url = urls[0];
        result.image_url_high = urls[0];
      }
    }
  }

  // If no image_urls found, try media_gallery items
  if (!result.image_url) {
    const mediaGalleryMatch = html.match(/media_gallery:\$R\[\d+\]=\{([^}]{0,10000})\}/);
    if (mediaGalleryMatch && mediaGalleryMatch[1]) {
      const urls = mediaGalleryMatch[1]
        .match(/https:\/\/f\.nooncdn\.com\/p\/pzsku\/[^"']+/g)
        ?.map((u) => u.replace(/"/g, "").trim())
        .filter((u) => u.length > 0);

      if (urls && urls.length > 0) {
        result.image_url = urls[0];
        result.image_url_high = urls[0];
      }
    }
  }

  // Fallback to JSON-LD
  if (!result.image_url) {
    const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch && jsonLdMatch[1]) {
      try {
        const json = JSON.parse(jsonLdMatch[1].trim());
        if (json.name && !result.product_name) result.product_name = json.name;
        if (json.image) {
          const img = Array.isArray(json.image) ? json.image[0] : json.image;
          if (typeof img === "string") {
            result.image_url = img;
            result.image_url_high = img;
          }
        }
        if (json.offers?.price && !result.price) {
          result.price = json.offers.price;
        }
      } catch {
        // ignore JSON parse errors
      }
    }
  }

  // Try to find product image in the page (common Noon patterns)
  if (!result.image_url) {
    const imgMatch = html.match(/<img[^>]*src=["'](https:\/\/[^"']*noon[^"']*\.(?:jpg|jpeg|png|webp))[^"']*["']/i);
    if (imgMatch && imgMatch[1]) {
      result.image_url = imgMatch[1];
      result.image_url_high = imgMatch[1];
    }
  }

  // Try data-src attribute
  if (!result.image_url) {
    const dataSrcMatch = html.match(/data-src=["'](https:\/\/[^"']*noon[^"']*\.(?:jpg|jpeg|png|webp))[^"']*["']/i);
    if (dataSrcMatch && dataSrcMatch[1]) {
      result.image_url = dataSrcMatch[1];
      result.image_url_high = dataSrcMatch[1];
    }
  }

  // Try srcset attribute
  if (!result.image_url) {
    const srcsetMatch = html.match(/srcset=["'][^"']*(https:\/\/[^"']*noon[^"']*\.(?:jpg|jpeg|png|webp))[^"']*["']/i);
    if (srcsetMatch && srcsetMatch[1]) {
      result.image_url = srcsetMatch[1];
      result.image_url_high = srcsetMatch[1];
    }
  }

  // Try to find any nooncdn image URL in the HTML
  if (!result.image_url) {
    const noonImgMatch = html.match(/(https:\/\/f\.nooncdn\.com\/p\/pzsku\/[^"'\s,]+)/i);
    if (noonImgMatch && noonImgMatch[1]) {
      result.image_url = noonImgMatch[1];
      result.image_url_high = noonImgMatch[1];
    }
  }

  // Try to find any image URL in JSON data within script tags
  if (!result.image_url) {
    const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/g);
    if (scriptMatches) {
      for (const script of scriptMatches) {
        const imgInScript = script.match(/(https:\/\/f\.nooncdn\.com\/p\/pzsku\/[^"'\s,}]+)/i);
        if (imgInScript && imgInScript[1]) {
          result.image_url = imgInScript[1];
          result.image_url_high = imgInScript[1];
          break;
        }
      }
    }
  }

  // Upgrade to high-res: request the highest quality version
  if (result.image_url_high) {
    result.image_url_high = getHighResUrl(result.image_url_high);
  }
  if (result.image_url) {
    result.image_url = getHighResUrl(result.image_url);
  }

  // Extract description from HTML (if not already extracted from Amazon)
  if (!result.description_ar && !result.description_en) {
    const description = extractDescriptionFromHtml(html);
    if (description) saveOriginalDescription(description);
  }

  return result;
}

const OPENAI_TIMEOUT_MS = 20000;

const EGYPT_MARKET_HOSTS = [
  /(^|\.)noon\.com$/i,
  /(^|\.)amazon\.eg$/i,
  /(^|\.)jumia\.com\.eg$/i,
  /(^|\.)carrefouregypt\.com$/i,
  /(^|\.)btech\.com$/i,
  /(^|\.)2b\.com\.eg$/i,
  /(^|\.)dream2000\.com$/i,
  /(^|\.)chefaa\.com$/i,
  /(^|\.)eldoctorz\.com$/i,
  /(^|\.)seif-online\.com$/i,
  /(^|\.)elezabypharmacy\.com$/i,
  /(^|\.)19011\.com$/i,
];
const MAX_BARCODE_LOOKUP_ROWS = 20_000;

function isEgyptMarketUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (!EGYPT_MARKET_HOSTS.some((pattern) => pattern.test(parsed.hostname))) return false;
    if (/(^|\.)noon\.com$/i.test(parsed.hostname)) {
      return /^\/(?:egypt-(?:en|ar)|eg)(?:\/|$)/i.test(parsed.pathname);
    }
    return true;
  } catch {
    return false;
  }
}

export function isBarcodeRetailerUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (/(^|\.)amazon\.eg$/i.test(parsed.hostname)) return true;
    return /(^|\.)noon\.com$/i.test(parsed.hostname) &&
      /^\/(?:egypt-(?:en|ar)|eg)(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function normalizeSearchText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 1632))
    .replace(/[^a-z0-9\s\u0600-\u06ff]+/gi, " ")
    .replace(/(\d)\s+(ml|mg|mcg|kg|g|l|oz|pcs|pieces|tablets?|capsules?|gb|tb|mb|mah|w|v|hz|inches?|cm|mm)\b/gi, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

export function scoreEgyptProductName(requested: string, found: string): number {
  const requestedText = normalizeSearchText(requested);
  const foundText = normalizeSearchText(found);
  if (!requestedText || !foundText) return 0;

  const requestedTokens = requestedText.split(" ").filter((token) => token.length > 1);
  const foundTokens = new Set(foundText.split(" ").filter((token) => token.length > 1));
  if (requestedTokens.length === 0 || foundTokens.size === 0) return 0;

  const weight = (token: string) => /\d/.test(token) ? 3 : token.length >= 7 ? 1.5 : 1;
  const totalWeight = requestedTokens.reduce((total, token) => total + weight(token), 0);
  const matchedWeight = requestedTokens.reduce(
    (total, token) => total + (foundTokens.has(token) ? weight(token) : 0),
    0
  );

  let score = totalWeight > 0 ? matchedWeight / totalWeight : 0;

  if (requestedText === foundText) score = Math.max(score, 1);
  else if (requestedText.includes(foundText) || foundText.includes(requestedText)) score = Math.max(score, 0.9);

  const requestedCore = requestedTokens.filter((token) => token.length >= 3 || /\d/.test(token));
  const foundCore = requestedCore.filter((token) => foundTokens.has(token));
  if (requestedCore.length > 0) {
    score = Math.max(score, foundCore.length / requestedCore.length);
  }

  const requestedSpecs = requested.match(/\d+(?:[.,]\d+)?\s*(?:ml|mg|mcg|kg|g|l|oz|pcs|pieces|tablets?|capsules?|gb|tb|mb|mah|w|v|hz|inches?|cm|mm)\b/gi) || [];
  const foundCompact = foundText.replace(/\s+/g, "");
  if (requestedSpecs.length > 0 && requestedSpecs.some((spec) => !foundCompact.includes(normalizeSearchText(spec).replace(/\s+/g, "")))) {
    score = Math.min(score, 0.59);
  }

  const requestedLead = requestedTokens[0] || "";
  const foundLead = foundTokens.has(requestedLead);
  if (requestedLead && !foundLead) {
    score = Math.min(score, 0.74);
  }

  return Math.min(1, Math.max(0, score));
}

export function scoreBarcodeCandidate(requestedNames: string[], primaryName: string, candidateName: string): number {
  const scores = requestedNames.map((name) => scoreEgyptProductName(name, candidateName));
  let score = scores.length ? Math.max(...scores) : 0;

  const normalizedCandidate = normalizeSearchText(candidateName);
  const candidateTokens = new Set(normalizedCandidate.split(" ").filter(Boolean));
  const primaryTokens = normalizeSearchText(primaryName).split(" ").filter(Boolean);
  const primaryLead = primaryTokens[0] || "";
  if (primaryLead && !candidateTokens.has(primaryLead)) score = Math.min(score, 0.72);

  const requiredSpecs = requestedNames.flatMap((name) =>
    name.match(/\d+(?:[.,]\d+)?\s*(?:ml|mg|mcg|kg|g|l|oz|pcs|pieces|tablets?|capsules?|gb|tb|mb|mah|w|v|hz|inches?|cm|mm)\b/gi) || []
  );
  const candidateCompact = normalizedCandidate.replace(/\s+/g, "");
  const hasMissingRequiredSpec = requiredSpecs.length > 0 && requiredSpecs.some((spec) =>
    !candidateCompact.includes(normalizeSearchText(spec).replace(/\s+/g, ""))
  );

  const exactKeywordCoverage = Math.max(0, ...requestedNames.map((name => {
    const tokens = new Set(normalizeSearchText(name).split(" ").filter((token) => token.length > 2));
    const matches = [...tokens].filter((token) => candidateTokens.has(token));
    return matches.length / Math.max(1, tokens.size);
  })));
  score = Math.max(score, exactKeywordCoverage * 0.85);

  if (primaryLead && !candidateTokens.has(primaryLead)) score = Math.min(score, 0.49);
  if (hasMissingRequiredSpec) score = Math.min(score, 0.49);

  return Math.min(1, Math.max(0, score));
}

export function shouldIncludeBarcodeCandidate(nameScore: number, barcodeVerified: boolean, searchedByBarcode: boolean): boolean {
  return barcodeVerified || nameScore >= 0.6 || searchedByBarcode;
}

type EgyptNameCandidate = { url: string; title: string; imageUrl?: string; description?: string };
type BarcodeSearchCandidate = { url: string; title: string; imageUrl?: string; description?: string; searchedByBarcode?: boolean };

export function rankBarcodeCandidates(
  candidates: BarcodeSearchCandidate[],
  requestedNames: string[],
  limit = 40
): BarcodeSearchCandidate[] {
  const uniqueCandidates = new Map<string, BarcodeSearchCandidate>();
  for (const candidate of candidates) {
    const existing = uniqueCandidates.get(candidate.url);
    uniqueCandidates.set(candidate.url, existing
      ? {
          ...existing,
          ...candidate,
          imageUrl: candidate.imageUrl || existing.imageUrl,
          description: candidate.description || existing.description,
          searchedByBarcode: Boolean(existing.searchedByBarcode || candidate.searchedByBarcode),
        }
      : candidate);
  }
  return [...uniqueCandidates.values()]
    .sort((first, second) => {
      const barcodePriority = Number(Boolean(second.searchedByBarcode)) - Number(Boolean(first.searchedByBarcode));
      if (barcodePriority) return barcodePriority;
      const firstScore = Math.max(...requestedNames.map((name) => scoreEgyptProductName(name, first.title)), 0);
      const secondScore = Math.max(...requestedNames.map((name) => scoreEgyptProductName(name, second.title)), 0);
      return secondScore - firstScore;
    })
    .slice(0, limit);
}

function extractAmazonSearchProducts(html: string): SiteProduct[] {
  const products: SiteProduct[] = [];
  const blocks = html.split(/<div(?=[^>]*data-component-type=["']s-search-result["'])/i).slice(1);
  for (const block of blocks) {
    const asin = block.match(/\bdata-asin=["']([A-Z0-9]{10})["']/i)?.[1];
    if (!asin) continue;
    const titleHtml =
      block.match(/<h2\b[^>]*>[\s\S]*?<span\b[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/h2>/i)?.[1] ||
      block.match(/<span\b[^>]*class=["'][^"']*a-text-normal[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || "";
    const productName = cleanProductName(stripTags(titleHtml));
    if (!productName) continue;
    const imageTag = block.match(/<img\b[^>]*>/i)?.[0] || "";
    const imageUrl = imageTag ? resolveAndNormalizeImage(extractImgSrc(imageTag), "https://www.amazon.eg") : "";
    products.push({
      url: `https://www.amazon.eg/dp/${asin}`,
      product_name: productName,
      price: extractPriceFromInner(block),
      image_url: imageUrl,
      image_url_high: imageUrl ? upgradeImageQuality(imageUrl) : "",
      images: imageUrl ? [imageUrl] : [],
    });
  }
  return dedupeSiteProducts(products);
}

async function searchEgyptNameCandidates(productName: string): Promise<EgyptNameCandidate[]> {
  const encodedName = encodeURIComponent(productName);
  const searchPages = [
    `https://www.noon.com/egypt-en/search?q=${encodedName}`,
    `https://www.amazon.eg/s?k=${encodedName}`,
    `https://www.jumia.com.eg/catalog/?q=${encodedName}`,
    `https://eldoctorz.com/shop/?q=${encodedName}`,
  ];
  const directResults = await mapWithConcurrency(searchPages, 3, async (searchPage) => {
    try {
      const html = await fetchProductPage(searchPage, 15000, 1);
      const extracted = /amazon\.eg/i.test(searchPage)
        ? [...extractAmazonSearchProducts(html), ...extractSiteProductsFromHtml(html, searchPage)]
        : extractSiteProductsFromHtml(html, searchPage);
      return extracted
        .filter((product) => product.url && product.product_name && isEgyptMarketUrl(product.url))
        .map((product) => ({
          url: product.url,
          title: product.product_name,
          imageUrl: product.image_url_high || product.image_url || "",
          description: product.description || "",
        }));
    } catch {
      return [];
    }
  });
  const candidates: EgyptNameCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of directResults.flat()) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    candidates.push(candidate);
  }
  return candidates;
}

export function extractGoogleBarcodeCandidates(html: string, baseUrl: string): BarcodeSearchCandidate[] {
  const candidates: BarcodeSearchCandidate[] = [];
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']+?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    let url = safeResolve(match[1], baseUrl);
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (/(^|\.)google\.com$/i.test(parsed.hostname) && parsed.pathname === "/url") {
        const target = parsed.searchParams.get("q") || parsed.searchParams.get("url");
        url = target ? safeResolve(target, baseUrl) : null;
      }
    } catch {
      url = null;
    }
    if (!url || !isBarcodeRetailerUrl(url)) continue;
    const heading = match[2].match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1];
    const title = cleanProductName(stripTags(heading || match[2]));
    if (!title || !isProductHref(url)) continue;
    candidates.push({ url, title });
  }
  return candidates;
}

async function searchBarcodeCandidates(query: string): Promise<BarcodeSearchCandidate[]> {
  const encodedQuery = encodeURIComponent(query);
  const googleQuery = encodeURIComponent(`${query} (site:amazon.eg OR site:noon.com)`);
  const searchPages = [
    `https://www.noon.com/egypt-en/search?q=${encodedQuery}`,
    `https://www.noon.com/egypt-ar/search?q=${encodedQuery}`,
    `https://www.amazon.eg/s?k=${encodedQuery}`,
    `https://www.google.com/search?q=${encodedQuery}&num=50&hl=en&gl=eg&filter=0`,
    `https://www.google.com/search?q=${googleQuery}&num=50&hl=en&gl=eg&filter=0`,
  ];
  const directResults = await mapWithConcurrency(searchPages, 3, async (searchPage) => {
    try {
      const html = await fetchProductPage(searchPage, 15000, 1);
      if (/google\.com\/search/i.test(searchPage)) {
        return extractGoogleBarcodeCandidates(html, searchPage);
      }
      const products = /amazon\.eg/i.test(searchPage)
        ? [...extractAmazonSearchProducts(html), ...extractSiteProductsFromHtml(html, searchPage)]
        : extractSiteProductsFromHtml(html, searchPage);
      return products
        .filter((product) => product.url && product.product_name && isBarcodeRetailerUrl(product.url))
        .map((product) => ({
          url: product.url,
          title: product.product_name,
          imageUrl: product.image_url_high || product.image_url || "",
          description: product.description || "",
        }));
    } catch {
      return [];
    }
  });
  const seen = new Set<string>();
  return directResults.flat().filter((candidate) => {
    if (seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    return true;
  }).map((candidate) => ({ ...candidate, searchedByBarcode: /^\d{8,14}$/.test(query) }));
}

async function verifyEgyptImageWithOpenAI(productName: string, title: string, imageUrl: string, apiKey: string): Promise<boolean> {
  if (!apiKey || !imageUrl) return false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        max_tokens: 80,
        messages: [{ role: "user", content: [
          { type: "text", text: `هل الصورة تعرض نفس المنتج المطلوب؟ المطلوب: ${productName}\nعنوان الصفحة: ${title}\nأجب JSON فقط: {"match":true أو false}` },
          { type: "image_url", image_url: { url: imageUrl } },
        ] }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return /["']match["']\s*:\s*true/i.test(data.choices?.[0]?.message?.content || "");
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function searchEgyptProduct(row: { index: number; productName: string; sku?: string }, openaiApiKey: string) {
  const directSearchUrls = [
    `https://www.noon.com/egypt-en/search?q=${encodeURIComponent(row.productName)}`,
    `https://www.amazon.eg/s?k=${encodeURIComponent(row.productName)}`,
    `https://www.jumia.com.eg/catalog/?q=${encodeURIComponent(row.productName)}`,
  ];
  const candidates: Array<{ url: string; title: string }> = [];
  for (const searchUrl of directSearchUrls) {
    try {
      const html = await fetchProductPage(searchUrl, 18000);
      for (const product of extractSiteProductsFromHtml(html, searchUrl).slice(0, 8)) {
        if (product.url && product.product_name) candidates.push({ url: product.url, title: product.product_name });
      }
      if (candidates.length >= 5) break;
    } catch {
      // Fall back to the search providers when a marketplace search page is blocked.
    }
  }
  if (candidates.length === 0) {
    candidates.push(...(await searchEgyptNameCandidates(row.productName)).map(({ url, title }) => ({ url, title })));
  }
  let best: { title: string; url: string; image: string; score: number; source: string } | null = null;
  for (const candidate of candidates.slice(0, 5)) {
    try {
      const extracted = extractFromHtml(await fetchProductPage(candidate.url, 12000));
      const title = extracted.product_name || candidate.title;
      const image = extracted.image_url_high || extracted.image_url || "";
      const score = scoreEgyptProductName(row.productName, title);
      if (image && (!best || score > best.score)) best = { title, url: candidate.url, image, score, source: new URL(candidate.url).hostname };
    } catch {
      // Continue with the next Egyptian product page.
    }
  }
  if (!best) return { index: row.index, productName: row.productName, sku: row.sku || "", title: "", productUrl: "", imageUrl: "", source: "", score: 0, status: "not_found", reason: "لم يتم العثور على صفحة منتج مصرية بصور قابلة للتحقق" };
  const visualMatch = best.score >= 0.72 && await verifyEgyptImageWithOpenAI(row.productName, best.title, best.image, openaiApiKey);
  const verified = best.score >= 0.82 && (!openaiApiKey || visualMatch);
  return { index: row.index, productName: row.productName, sku: row.sku || "", title: best.title, productUrl: best.url, imageUrl: best.image, source: best.source, score: best.score, status: verified ? "verified" : "review", reason: verified ? "تطابق اسم المنتج والصورة مع صفحة مصرية" : "النتيجة مرشحة لكنها تحتاج مراجعة بشرية" };
}

function pageContainsBarcode(html: string, barcode: string): boolean {
  const escaped = barcode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\D)${escaped}(?:\\D|$)`).test(html);
}

async function searchBarcodeProduct(row: { index: number; sourceName: string; englishName: string; barcode: string; price: number | null; sku: string }) {
  const barcode = String(row.barcode || "").replace(/\D/g, "");
  const emptyResult = {
    ...row,
    productName: "",
    description: "",
    imageUrl: "",
    productUrl: "",
    source: "",
    matchScore: 0,
    barcodeVerified: false,
    candidates: [],
    status: "not_found" as const,
  };
  if (!barcode) return emptyResult;

  const searchNames = [...new Set([row.englishName.trim(), row.sourceName.trim()].filter(Boolean))];
  const candidateLists = await Promise.all([
    searchBarcodeCandidates(barcode),
    ...searchNames.map((name) => searchBarcodeCandidates(name)),
  ]);
  const retailerCandidates = candidateLists.flat();
  const requestedNames = searchNames;
  const uniqueCandidates = rankBarcodeCandidates(retailerCandidates
    .filter((candidate) => isBarcodeRetailerUrl(candidate.url)), requestedNames);
  const candidates = await mapWithConcurrency(uniqueCandidates, 6, async (candidate) => {
    try {
      const html = await fetchProductPage(candidate.url, 12000, 1);
      const extracted = html ? extractFromHtml(html) : {};
      const productName = extracted.product_name || candidate.title;
      const nameScore = scoreBarcodeCandidate(requestedNames, row.englishName, productName);
      const barcodeVerified = Boolean(html && pageContainsBarcode(html, barcode));
      if (!shouldIncludeBarcodeCandidate(nameScore, barcodeVerified, Boolean(candidate.searchedByBarcode))) return null;
      return {
        productName,
        description: extracted.description_ar || extracted.description_en || candidate.description || "",
        imageUrl: extracted.image_url_high || extracted.image_url || candidate.imageUrl || "",
        productUrl: candidate.url,
        source: new URL(candidate.url).hostname,
        matchScore: Math.max(nameScore, barcodeVerified ? 1 : 0),
        barcodeVerified,
      };
    } catch {
      const nameScore = scoreBarcodeCandidate(requestedNames, row.englishName, candidate.title);
      if (!shouldIncludeBarcodeCandidate(nameScore, false, Boolean(candidate.searchedByBarcode))) return null;
      return {
        productName: candidate.title,
        description: candidate.description || "",
        imageUrl: candidate.imageUrl || "",
        productUrl: candidate.url,
        source: new URL(candidate.url).hostname,
        matchScore: nameScore,
        barcodeVerified: false,
      };
    }
  });

  const rankedCandidates = candidates
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((first, second) => Number(second.barcodeVerified) - Number(first.barcodeVerified) || second.matchScore - first.matchScore)
    .slice(0, 5);
  const best = rankedCandidates[0];
  if (!best) return emptyResult;
  return {
    ...row,
    ...best,
    candidates: rankedCandidates,
    status: best.barcodeVerified ? "found" as const : "review" as const,
  };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

function buildFallbackDescriptions(productName: string): { description_ar: string; description_en: string } {
  const name = productName?.trim() || "منتج";
  const source = name.toLowerCase().replace(/[^a-z\u0600-\u06FF\s]/g, " ");
  const tokens = source.split(/\s+/).filter(Boolean);

  const productNameTerms = tokens.slice(0, 12);
  const productType = productNameTerms.includes("water") && (productNameTerms.includes("heater") || productNameTerms.includes("geyser") || productNameTerms.includes("boiler")) ? "water_heater"
    : productNameTerms.includes("fan") || productNameTerms.includes("blower") ? "fan"
    : productNameTerms.includes("blender") || productNameTerms.includes("mixer") || productNameTerms.includes("juicer") ? "blender"
    : productNameTerms.includes("bottle") || productNameTerms.includes("water") || productNameTerms.includes("flask") ? "bottle"
    : productNameTerms.includes("dryer") || productNameTerms.includes("hair") ? "dryer"
    : productNameTerms.includes("fryer") || productNameTerms.includes("oven") ? "fryer"
    : productNameTerms.includes("vacuum") || productNameTerms.includes("cleaner") ? "vacuum"
    : productNameTerms.includes("lamp") || productNameTerms.includes("light") ? "lamp"
    : productNameTerms.includes("kettle") || productNameTerms.includes("heater") ? "kettle"
    : "general";

  const descriptionsByType: Record<string, { ar: string; en: string }> = {
    water_heater: {
      ar: `منتج ${name} مصمم لتسخين الماء بسرعة وفعالية، مع أداء موثوق وتصميم مناسب للتركيب في الحمام أو المطبخ.`,
      en: `${name} is designed for fast and efficient water heating, with reliable performance and a suitable build for bathroom or kitchen installation.`,
    },
    blender: {
      ar: `منتج ${name} مصمم لخلط المكونات بسرعة وسهولة، مع أداء قوي يناسب الاستخدام اليومي.`,
      en: `${name} is built for fast and easy blending, with strong performance suited to daily use.`,
    },
    fan: {
      ar: `منتج ${name} يوفر تدفق هواء مريح وفعال، مع أداء موثوق يساعد على تحسين الراحة في المنزل أو المكتب.`,
      en: `${name} delivers smooth, reliable airflow with dependable performance for home or office comfort.`,
    },
    bottle: {
      ar: `منتج ${name} مناسب لحمل السوائل بسهولة، مع تصميم عملي ومريح للاستخدام اليومي.`,
      en: `${name} is made for easy liquid carrying, with a practical and convenient design for daily use.`,
    },
    dryer: {
      ar: `منتج ${name} يساعد على التجفيف بسرعة مع تدفق هواء فعال وسهولة في الاستخدام.`,
      en: `${name} is designed for fast drying with efficient airflow and straightforward everyday use.`,
    },
    fryer: {
      ar: `منتج ${name} مناسب لطهي أسرع مع أداء موثوق وسهولة في الاستخدام اليومي.`,
      en: `${name} is ideal for quicker cooking with dependable performance and easy everyday use.`,
    },
    vacuum: {
      ar: `منتج ${name} يساعد على التنظيف بسهولة بقدرة فعالة ومواصفات عملية.`,
      en: `${name} makes cleaning easier with efficient power and practical performance.`,
    },
    lamp: {
      ar: `منتج ${name} يوفر إضاءة واضحة وموثوقة مع تصميم مناسب للمنزل أو المكتب.`,
      en: `${name} provides clear, dependable lighting with a practical design for home or office use.`,
    },
    kettle: {
      ar: `منتج ${name} مناسب للتسخين السريع مع أداء موثوق وسهولة في الاستخدام.`,
      en: `${name} is suited for quick heating with reliable performance and straightforward everyday use.`,
    },
    general: {
      ar: `منتج ${name} مصمم لتلبية احتياجات الاستخدام اليومي بشكل عملي وموثوق.`,
      en: `${name} is designed to meet daily needs with practical and reliable performance.`,
    },
  };

  const selected = descriptionsByType[productType] || descriptionsByType.general;

  return {
    description_ar: selected.ar.replace(/\.\s*$/, "."),
    description_en: selected.en.replace(/\.\s*$/, "."),
  };
}

async function generateDescriptions(
  productName: string,
  existingDescription: string | null,
  apiKey: string
): Promise<{ description_ar: string; description_en: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a premium e-commerce copywriter for Noon and Amazon. Write a short, precise, and natural product description based only on the product name, keywords, and product type. Do not use a generic template. Do not mention portability, carrying, or daily-use claims unless the name clearly indicates a portable product. For water heaters, boilers, geysers, or shower heaters, describe heating capacity, reliability, safety, and installation suitability, not portability. Output only valid JSON with exactly these keys: description_ar, description_en. Each description should be 1-2 short sentences, marketplace-ready, and specific to the actual product.",
          },
          {
            role: "user",
            content: `Product name: ${productName}\nKeywords: ${productName.split(/\s+/).slice(0, 8).join(", ") || "general product"}\nProduct type: ${productName.toLowerCase().includes("water") && (productName.toLowerCase().includes("heater") || productName.toLowerCase().includes("geyser") || productName.toLowerCase().includes("boiler")) ? "water_heater" : productName.toLowerCase().includes("fan") || productName.toLowerCase().includes("blower") ? "fan" : productName.toLowerCase().includes("blender") || productName.toLowerCase().includes("mixer") || productName.toLowerCase().includes("juicer") ? "blender" : productName.toLowerCase().includes("bottle") || productName.toLowerCase().includes("water") || productName.toLowerCase().includes("flask") ? "bottle" : productName.toLowerCase().includes("dryer") || productName.toLowerCase().includes("hair") ? "dryer" : productName.toLowerCase().includes("fryer") || productName.toLowerCase().includes("oven") ? "fryer" : productName.toLowerCase().includes("vacuum") || productName.toLowerCase().includes("cleaner") ? "vacuum" : productName.toLowerCase().includes("lamp") || productName.toLowerCase().includes("light") ? "lamp" : productName.toLowerCase().includes("kettle") || productName.toLowerCase().includes("heater") ? "kettle" : "general"}\n\nCreate a short and accurate product description in Arabic and English based only on these inputs.`,
          },
        ],
        temperature: 0.7,
        max_tokens: 800,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned no content");

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("OpenAI response did not contain JSON");

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      description_ar: parsed.description_ar || buildFallbackDescriptions(productName).description_ar,
      description_en: parsed.description_en || buildFallbackDescriptions(productName).description_en,
    };
  } catch (err) {
    const fallback = buildFallbackDescriptions(productName);
    const errText = err instanceof Error ? err.message : String(err);
    if (errText.includes("429") || errText.includes("spend_limit") || errText.includes("insufficient_quota")) {
      return fallback;
    }
    return fallback;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Description generation is intentionally disabled: exports must preserve the source text.
void generateDescriptions;

async function extractWithOpenAI(html: string, apiKey: string): Promise<Partial<ProductData>> {
  const ogTitle = extractMetaContent(html, "og:title");
  const ogImage = extractMetaContent(html, "og:image");
  const truncatedHtml = html.substring(0, 8000);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a product data extractor. Given HTML from an e-commerce product page (Noon.com or Amazon.com), extract the product name, price, first product image URL, and product description. Respond ONLY with JSON in this exact format: {\"product_name\": \"...\", \"price\": 0, \"image_url\": \"...\", \"description\": \"...\"}. Price must be a number or null. The image_url must be a full https URL. If a field cannot be found, return null for that field.",
          },
          {
            role: "user",
            content: `Extract product name and first image URL from this HTML.\n\nKnown og:title: ${ogTitle || "none"}\nKnown og:image: ${ogImage || "none"}\n\nHTML:\n${truncatedHtml}`,
          },
        ],
        temperature: 0,
        max_tokens: 300,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned no content");

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("OpenAI response did not contain JSON");

    const parsed = JSON.parse(jsonMatch[0]);
    const result: Partial<ProductData> = {};
    const parsedPrice =
      typeof parsed.price === "number"
        ? parsed.price
        : Number.parseFloat(String(parsed.price || "").replace(/[^\d.]/g, ""));
    if (Number.isFinite(parsedPrice) && parsedPrice > 0) result.price = parsedPrice;
    if (parsed.image_url) {
      result.image_url = getHighResUrl(parsed.image_url);
      result.image_url_high = result.image_url;
    }
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}


// يُعيد الرؤوس المناسبة لجلب الصور؛ أدوات Google (gstatic / googleusercontent) تحسّن فرصة
// الاستجابة عند إرسال Referer من Google مما يمنع رفض الجلب (403).
function getImageFetchHeaders(imageUrl: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "image/avif,image/webp,image/apng,image/*",
  };
  try {
    const host = new URL(imageUrl).hostname.toLowerCase();
    if (/(^|\.)gstatic\.com$/i.test(host) || /(^|\.)googleusercontent\.com$/i.test(host)) {
      headers["Referer"] = "https://www.google.com/";
    }
  } catch {
    // استخدم الرؤوس الافتراضية إن لم يمكن تحليل الرابط
  }
  return headers;
}
/* ==========================================================
   سحب كل منتجات موقع/قسم كامل (نون، أمازون، شوبيفاي...)
   ========================================================== */

interface SiteProduct {
  url: string;
  product_name: string;
  price: number | null;
  image_url: string;
  image_url_high: string;
  description?: string;
  images?: string[];
}

const SITE_PRODUCT_HREF_PATTERNS: RegExp[] = [
  // أمازون
  /(?:^|[/?=&])dp\/([A-Z0-9]{8,12})(?:[/?&#]|$)/i,
  /(?:^|[/?=&])gp\/product\/([A-Z0-9]{8,12})(?:[/?&#]|$)/i,
  /(?:^|[/?=&])gp\/aw\/d\/([A-Z0-9]{8,12})(?:[/?&#]|$)/i,
  // نون: /en-eg/p/slug/N1234.../
  /\/(?:[a-z]{2}(?:-[a-z]{2,3})?\/)?p\/[^/]+\/[A-Za-z0-9_-]{6,}\/?(\?|$)/i,
  // نون (بدون SKU)
  /\/(?:[a-z]{2}(?:-[a-z]{2,3})?\/)?p\/[A-Za-z][A-Za-z0-9%._-]{2,}\/?(\?|$)/i,
  // نون الحالية: /{locale}/{slug}/{SKU}/p/
  /\/(?:[a-z]{2,7}(?:-[a-z]{2,3})?)\/[A-Za-z0-9%._-]+\/[A-Za-z0-9_-]{6,}\/p\/?(\?|$)/i,
  // شوبيفاي / ووكومرس / ماجنتو
  /\/(?:products|product|item|items|itm|pd)\/[A-Za-z0-9%._-]+/i,
  // متاجر بعناوين رقمية
  /\/(?:product|item|listing|auction|ad-id)\/\d+\/?(\?|$)/i,
  // مواقع بأرشيف catalogue/{slug}_{id}/index.html
  /\/(?:catalogue|catalog)\/[A-Za-z0-9%._-]+_\d+\/(?:index\.html?)?/i,
  // علي إكسبريس
  /\/-\d+-p-\d+(?:\.html?)?/i,
  // نمط عام /p/slug (بشرط أن يبدأ بحرف)
  /\/(?:p|pd|sku)\/[A-Za-z][A-Za-z0-9%._-]{2,}\/?(\?|$)/i,
  // ماجنتو وأنظمة مشابهة: /{locale}/{product-slug}.html — الـ slug طويل ومتعدد الكلمات (صفحات الأقسام أقصر)
  /\/(?:[a-z]{2,3}(?:-[a-z]{2,3})?\/)[a-z0-9]+(?:-[a-z0-9]+){2,}\.html?(?:\?|#|$)/i,
  // ماجنتو: /catalog/product/view/id/{id}
  /\/catalog\/product\/view\/id\/\d+/i,
];

const NON_PRODUCT_URL_PATTERNS: RegExp[] = [
  /\.(?:css|js|json|xml|rss|atom|png|jpe?g|webp|gif|svg|ico|avif|pdf|zip|mp4|webm|eot|woff2?|ttf|map)(?:$|[?#])/i,
  /\/(?:cart|checkout|login|signin|logout|signup|register|account|accounts|wishlist|order|orders|search|blog|news|tags?|sitemap|about|contact|faq|help|support|terms|privacy|policy|policies|shipping|returns|api|graphql|ajax|compare|stores?|feed|feeds|admin|dashboard|auth|session|category|categories)\b/i,
];

const NON_PRODUCT_LAST_SEGMENT: RegExp =
  /^(?:about|contact|faq|help|info|terms|privacy|login|register|cart|home|main|deals|offers|new|view-all|all|shop|store|stores|brands?|categories|collections|more|tours|recipes|lookbook)$/i;

function htmlDecodeUntrusted(input: string): string {
  if (!input) return "";
  let out = repairUtf8Mojibake(input)
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&hellip;/gi, "…")
    .replace(/&minus;/gi, "-");
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => {
    try {
      return String.fromCodePoint(parseInt(hex, 16));
    } catch {
      return "";
    }
  });
  out = out.replace(/&#(\d{1,7});/g, (_m, dec: string) => {
    try {
      return String.fromCodePoint(parseInt(dec, 10));
    } catch {
      return "";
    }
  });
  return out;
}

function stripTags(html: string): string {
  let text = String(html || "");
  text = text.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<[^>]+>/g, " ");
  return htmlDecodeUntrusted(text);
}

function safeResolve(href: string, baseUrl: string): string | null {
  if (!href) return null;
  const trimmed = htmlDecodeUntrusted(href.trim());
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^(?:javascript|mailto|tel|data|blob|about|vbscript|file):/i.test(trimmed)) return null;
  try {
    const resolved = new URL(trimmed, baseUrl);
    const proto = typeof resolved.protocol === "string" ? resolved.protocol : "";
    if (!/^https?:$/i.test(proto)) return null;
    resolved.hash = "";
    return resolved.href;
  } catch {
    return null;
  }
}

function isProductHref(rawUrl: string): boolean {
  const href = rawUrl.toLowerCase();
  if (NON_PRODUCT_URL_PATTERNS.some((p) => p.test(href))) return false;

  let matched = false;
  for (const pattern of SITE_PRODUCT_HREF_PATTERNS) {
    if (pattern.test(href)) {
      matched = true;
      break;
    }
  }
  if (!matched) {
    try {
      const parsed = new URL(rawUrl);
      const lastSegment = parsed.pathname.split("/").filter(Boolean).pop() || "";
      if (
        /(?:^|\.)zanussi\.com\.eg$/i.test(parsed.hostname) &&
        /^zanussi-[a-z0-9-]+\.html?$/i.test(lastSegment)
      ) {
        matched = true;
      }
    } catch {
      // Continue rejecting unknown URL shapes.
    }
  }
  if (!matched) return false;

  // رفض روابط الترقيم: آخر مقطع من المسار رقمي فقط (مثل /p/2 أو /products/page/2)
  try {
    const parsed = new URL(rawUrl);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop() || "";
    const noExt = lastSegment.replace(/\.html?$/i, "");
    if (/^\d+$/.test(noExt)) return false;
    if (NON_PRODUCT_LAST_SEGMENT.test(noExt.replace(/[-_]+/g, "-").toLowerCase())) return false;
  } catch {
    // نتجاهل أخطاء التحليل
  }

  return true;
}

function repairUtf8Mojibake(value: string): string {
  if (!/(?:Ã|Â|Ø|Ù)[\u0080-\u00bf]/.test(value)) return value;

  const bytes = new Uint8Array(value.length * 4);
  let byteLength = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) || 0;
    if (codePoint <= 0xff) {
      bytes[byteLength++] = codePoint;
    } else {
      const encoded = Buffer.from(character, "utf8");
      bytes.set(encoded, byteLength);
      byteLength += encoded.length;
    }
  }

  const repaired = Buffer.from(bytes.subarray(0, byteLength)).toString("utf8");
  return /[\u0600-\u06ff]/.test(repaired) ? repaired : value;
}

function isDirectProductTarget(rawUrl: string): boolean {
  if (isProductHref(rawUrl)) return true;
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname;
    if (/(^|\.)noon\.com$/i.test(parsed.hostname) && /\/[^/]+\/[^/]+\/p\/?$/i.test(path)) {
      return true;
    }
    return /\/(?:p|pd|sku|product|products|item|items|listing|auction)\/(?:[^/]+\/){0,2}[^/]+\/?$/i.test(path);
  } catch {
    return false;
  }
}

const JUNK_NAMES: RegExp =
  /^(?:\s*(?:add to (?:cart|bag|basket)|buy now|shop now|عرض الآن|أضف[^ ]*|اضافة[^ ]*|اشتري|تسوق[^ ]*|السعر|price|sale|خصم|جديد|new|عرض|الكل|جميع|more|المزيد|تفاصيل|details|view|عرض المنتج|المنتج|product|skip|تخطي|التالي|next|السابق|prev|شاهد|watch|learn more|تعرف[^ ]*)\s*)+$/i;

function cleanProductName(raw: string): string {
  let name = htmlDecodeUntrusted(String(raw || ""));
  name = Array.from(name)
    .map((char) => {
      const code = char.charCodeAt(0);
      return code === 0x7f || (code >= 0x00 && code <= 0x1f) ? " " : char;
    })
    .join("");
  name = name.replace(/\s+/g, " ").trim();
  name = name.replace(/^[\s\-–—|•·>»:,_]+/, "").replace(/[\s\-–—|•·>»:,_]+$/, "");
  name = name.replace(/\s*[-–—(]\s*(?:image|picture|photo|صورة)\s*\d+\s*\)?\s*$/i, "");
  if (name.length > 220) {
    const cut = name.slice(0, 220);
    const lastSpace = cut.lastIndexOf(" ");
    name = (lastSpace > 120 ? cut.slice(0, lastSpace) : cut).trim();
  }
  name = name.replace(/\b(?:EGP|AED|SAR|QAR|KWD|OMR|BHD|JOD|USD|EUR|GBP)\b[\d,.\s]*/gi, "").trim();
  if (name.length < 3) return "";
  if (/^[\d,.\s]+$/.test(name)) return "";
  if (/^(?:no image|no photo|image|picture|صورة|بدون صورة|product image|placeholder)$/i.test(name)) return "";
  if (JUNK_NAMES.test(name)) return "";
  return name;
}

function upgradeImageQuality(url: string): string {
  const upgraded = getHighResUrl(url)
    .replace(/image_\d+x\d+_/i, "image_1200x1200_")
    .replace(/-(?:\d{2,4})x(?:\d{2,4})-converted/gi, "-1200x1200-converted")
    .replace(/_thumbs?\b/gi, "")
    .replace(/([?&])width=\d+/gi, "$1width=2000");
  return upgraded === url ? url : upgraded;
}

function resolveAndNormalizeImage(rawSrc: string, baseUrl: string): string {
  if (!rawSrc) return "";
  let src = htmlDecodeUntrusted(rawSrc.trim());
  if (!src || !/\.(?:jpe?g|webp|png|avif|gif|bmp)(?:$|[?#])/i.test(src)) return "";
  if (src.startsWith("//")) src = `https:${src}`;
  const resolved = safeResolve(src, baseUrl);
  return resolved || "";
}

function extractImgSrc(imgTag: string): string {
  if (!imgTag) return "";
  const priority: Array<[string, RegExp]> = [
    ["data-src", /\bdata-src\s*=\s*["']([^"']+)["']/i],
    ["data-lazy-src", /\bdata-lazy-src\s*=\s*["']([^"']+)["']/i],
    ["data-lazysrc", /\bdata-lazysrc\s*=\s*["']([^"']+)["']/i],
    ["data-original", /\bdata-original\s*=\s*["']([^"']+)["']/i],
    ["data-image", /\bdata-image\s*=\s*["']([^"']+)["']/i],
    ["data-srcset", /\bdata-srcset\s*=\s*["']([^"']+)["']/i],
    ["src", /\bsrc\s*=\s*["']([^"']+)["']/i],
    ["srcset", /\bsrcset\s*=\s*["']([^"']+)["']/i],
  ];
  for (const [, pattern] of priority) {
    const match = imgTag.match(pattern);
    if (match && match[1]) {
      const value = match[1].trim();
      if (pattern.source.startsWith("srcset")) return value.split(",")[0].trim().split(/\s+/)[0];
      return value;
    }
  }
  return "";
}

function extractImgAlt(imgTag: string): string {
  if (!imgTag) return "";
  const match = imgTag.match(/\balt\s*=\s*["']([^"']*)["']/i);
  return match ? match[1] : "";
}

function extractPriceFromInner(inner: string): number | null {
  const text = stripTags(inner);
  const currencyMatch =
    text.match(/(?:EGP|AED|SAR|QAR|KWD|OMR|BHD|JOD|LBP|USD|EUR|GBP|ج\.م|ر\.س|درهم)\s*([\d,]+(?:\.\d{1,2})?)/i) ||
    text.match(/([\d,]+(?:\.\d{1,2})?)\s*(?:EGP|AED|SAR|QAR|KWD|OMR|BHD|JOD|LBP|USD|EUR|GBP|ج\.م|ر\.س|درهم)/i);
  if (currencyMatch) return parseFloat(currencyMatch[1].replace(",", ""));
  const priceLabel = text.match(/(?:price|now|sale(?:\s*price)?)\s*[:=]?\s*\$?([\d,]+(?:\.\d{1,2})?)/i);
  if (priceLabel) return parseFloat(priceLabel[1].replace(",", ""));
  return null;
}

function isOutOfStockText(value: string): boolean {
  return /(?:out[\s_-]*of[\s_-]*stock|outofstock|sold[\s_-]*out|soldout|unavailable|not[\s_-]*available|غير\s*متوفر|غير\s*متاح|نفد\s*المخزون|غير\s*متوفره|غير\s*متوفرة)/i.test(
    stripTags(value)
  );
}

function isOutOfStockRecord(item: Record<string, unknown>): boolean {
  for (const key of ["in_stock", "inStock", "is_in_stock", "isInStock", "available", "is_available", "isAvailable"]) {
    if (item[key] === false) return true;
  }

  for (const key of ["stock_status", "stockStatus", "availability"]) {
    const value = item[key];
    if (typeof value === "string" && isOutOfStockText(value)) return true;
  }

  for (const key of ["stock_quantity", "stockQuantity", "inventory_quantity", "inventoryQuantity", "quantity"]) {
    const value = item[key];
    const quantity = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(quantity) && quantity <= 0) return true;
  }

  return false;
}

function isInStockRecord(item: Record<string, unknown>): boolean {
  if (isOutOfStockRecord(item)) return false;

  for (const key of ["in_stock", "inStock", "is_in_stock", "isInStock", "available", "is_available", "isAvailable"]) {
    if (item[key] === true) return true;
  }

  for (const key of ["stock_status", "stockStatus", "availability"]) {
    const value = item[key];
    if (typeof value === "string" && /(?:in[\s_-]*stock|instock|available)/i.test(value)) return true;
  }

  for (const key of ["stock_quantity", "stockQuantity", "inventory_quantity", "inventoryQuantity", "quantity"]) {
    const value = item[key];
    const quantity = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(quantity) && quantity > 0) return true;
  }

  return false;
}

function isJsonProductOutOfStock(item: Record<string, unknown>): boolean {
  if (isOutOfStockRecord(item)) return true;
  const offers = item.offers;
  const values: string[] = [];
  const collect = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of ["availability", "itemCondition"]) {
        if (typeof record[key] === "string") values.push(record[key]);
      }
      return;
    }
    if (typeof value === "string") values.push(value);
  };
  collect(offers);
  return values.some((value) => /OutOfStock|SoldOut|Discontinued|unavailable/i.test(value));
}

function finalizeSiteProduct(product: SiteProduct): SiteProduct {
  const derivedName = cleanProductName(product.product_name || productNameFromUrl(product.url));
  const derivedImage = product.image_url || product.image_url_high || "";
  return {
    ...product,
    product_name: derivedName,
    image_url: derivedImage,
    image_url_high: product.image_url_high || derivedImage,
    description: product.description ? cleanDescription(product.description) : "",
  };
}

function dedupeSiteProducts(products: SiteProduct[]): SiteProduct[] {
  const byUrl = new Map<string, SiteProduct>();
  for (const product of products) {
    if (!product || !product.url) continue;
    const key = product.url.split("#")[0].toLowerCase();
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, {
        ...product,
        url: product.url.split("#")[0],
        image_url: product.image_url || "",
        image_url_high: product.image_url_high || product.image_url || "",
      });
      continue;
    }
    // نفس المنتج يظهر أكثر من مرة (كارت بالصورة وآخر بالعنوان) — ندمج البيانات الناقصة بدل إسقاطها
    if (!existing.product_name && product.product_name) existing.product_name = product.product_name;
    if ((existing.price === null || existing.price === undefined) && product.price) existing.price = product.price;
    if (!existing.image_url && product.image_url) existing.image_url = product.image_url;
    if (!existing.image_url_high && (product.image_url_high || product.image_url)) {
      existing.image_url_high = product.image_url_high || product.image_url;
    }
    if (!existing.description && product.description) existing.description = product.description;
    if ((!existing.images || existing.images.length === 0) && product.images && product.images.length > 0) {
      existing.images = product.images;
    }
  }
  return [...byUrl.values()].map(finalizeSiteProduct);
}

function extractJsonLdProducts(html: string, baseUrl: string): SiteProduct[] {
  const out: SiteProduct[] = [];
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    if (!block[1]) continue;
    let data: unknown;
    try {
      data = JSON.parse(block[1].trim());
    } catch {
      continue;
    }
    const items: Array<Record<string, unknown>> = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      const t = record["@type"];
      const types = Array.isArray(t) ? t.map(String).join(" ") : String(t || "");
      const hasProductInfo =
        typeof record.name === "string" ||
        typeof record.url === "string" ||
        typeof record["@id"] === "string";
      if (/Product|Offer(?:Item)?|ListItem|ItemList/i.test(types) && hasProductInfo) {
        items.push(record);
      }
      for (const key of Object.keys(record)) {
        const value = record[key];
        if (Array.isArray(value) || (value && typeof value === "object")) walk(value);
      }
    };
    walk(data);

    for (const item of items) {
      const name = typeof item.name === "string" ? cleanProductName(item.name) : "";
      if (!name) continue;
      if (isJsonProductOutOfStock(item)) continue;
      const rawUrl = typeof item.url === "string" ? item.url : typeof item["@id"] === "string" ? String(item["@id"]) : "";
      const abs = safeResolve(rawUrl, baseUrl);
      if (!abs || !isProductHref(abs)) continue;
      const image = extractJsonImage(item.image, baseUrl);
      const price = extractJsonOfferPrice(item.offers);
      out.push({
        url: abs,
        product_name: name,
        price,
        image_url: image,
        image_url_high: upgradeImageQuality(image),
      });
    }
  }
  return out;
}

function extractSingleProductPage(html: string, baseUrl: string): SiteProduct[] {
  const jsonProducts = extractJsonLdProducts(html, baseUrl);
  const records = collectJsonLdProductRecords(html, baseUrl);
  const canonicalMatch =
    html.match(/<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']canonical["'][^>]*>/i);
  const pageUrls = new Set(
    [baseUrl, canonicalMatch?.[1] || ""]
      .map((url) => normalizeProductPageUrl(url, baseUrl))
      .filter(Boolean)
  );
  const primaryJsonProduct = jsonProducts.find((product) =>
    pageUrls.has(normalizeProductPageUrl(product.url, baseUrl))
  );
  const title = cleanProductName(
    primaryJsonProduct?.product_name ||
      extractMetaContent(html, "og:title") ||
      extractMetaContent(html, "twitter:title") ||
      html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
      ""
  );
  const galleryImage = extractGalleryImages(html, baseUrl).find((candidate) => !NOISE_IMAGE_URL.test(candidate));
  const socialImage = extractMetaContent(html, "og:image") || extractMetaContent(html, "twitter:image") || "";
  const image = primaryJsonProduct?.image_url || galleryImage || socialImage;
  const jsonPrice = primaryJsonProduct?.price;
  const price = typeof jsonPrice === "number" && jsonPrice > 0
    ? jsonPrice
    : extractProductPagePrice(html, records, true);
  const description =
    primaryJsonProduct?.description ||
    extractProductOverviewDescription(html) ||
    extractDescriptionFromHtml(html) ||
    "";

  if (!title && !image && price === null && !description) {
    const fallbackName = productNameFromUrl(baseUrl);
    if (!fallbackName) return [];
    return [{
      url: baseUrl,
      product_name: fallbackName,
      price: null,
      image_url: "",
      image_url_high: "",
    }];
  }
  return [{
    url: baseUrl,
    product_name: title,
    price,
    image_url: image,
    image_url_high: upgradeImageQuality(image),
    description,
  }];
}

function extractJsonImage(image: unknown, baseUrl: string): string {
  const candidates: string[] = [];
  const collect = (node: unknown) => {
    if (!node) return;
    if (typeof node === "string") {
      candidates.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    if (typeof node === "object") {
      const record = node as Record<string, unknown>;
      for (const key of ["url", "contentUrl", "@id"]) {
        if (typeof record[key] === "string") candidates.push(record[key] as string);
      }
      for (const key of Object.keys(record)) {
        const value = record[key];
        if (Array.isArray(value) || (value && typeof value === "object")) collect(value);
      }
    }
  };
  collect(image);
  for (const candidate of candidates) {
    const resolved = resolveAndNormalizeImage(candidate, baseUrl);
    if (resolved) return resolved;
  }
  return "";
}

function extractJsonOfferPrice(offers: unknown): number | null {
  if (!offers) return null;
  const values: number[] = [];
  const collect = (node: unknown) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    if (typeof node === "object") {
      const record = node as Record<string, unknown>;
      for (const key of ["price", "lowPrice", "highPrice", "value"]) {
        const v = record[key];
        if (typeof v === "number") values.push(v);
        else if (typeof v === "string") {
          const parsed = parseFloat(v.replace(/,/g, "").replace(/[^\d.]/g, ""));
          if (!Number.isNaN(parsed)) values.push(parsed);
        }
      }
      for (const key of Object.keys(record)) {
        const value = record[key];
        if (Array.isArray(value) || (value && typeof value === "object")) collect(value);
      }
    }
  };
  collect(offers);
  const valid = values.filter((v) => v > 0);
  return valid.length > 0 ? Math.min(...valid) : null;
}

function extractProductCardMarkup(html: string, anchorStart: number): string {
  const markerIndex = html.lastIndexOf("product-single-hover", anchorStart);
  if (markerIndex < 0) return "";

  const openingStart = html.lastIndexOf("<div", markerIndex);
  const openingEnd = html.indexOf(">", markerIndex);
  if (openingStart < 0 || openingEnd < 0 || openingEnd >= anchorStart) return "";
  if (!/\bclass\s*=\s*["'][^"']*\bproduct-single-hover\b/i.test(html.slice(openingStart, openingEnd + 1))) return "";

  const tags = /<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->|<\/?div\b[^>]*>/gi;
  tags.lastIndex = openingEnd + 1;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html)) !== null) {
    if (/^<\/div\b/i.test(match[0])) {
      depth -= 1;
      if (depth === 0) {
        return match.index >= anchorStart ? html.slice(openingStart, tags.lastIndex) : "";
      }
    } else if (/^<div\b/i.test(match[0]) && !/\/\s*>$/.test(match[0])) {
      depth += 1;
    }
  }
  return "";
}

function extractNoonListingProducts(html: string, baseUrl: string): SiteProduct[] {
  const out: SiteProduct[] = [];
  const nameMatches = [...html.matchAll(/"product_name"\s*:\s*"((?:[^"\\]|\\.){2,250})"/gi)];
  for (const nameMatch of nameMatches) {
    const pos = nameMatch.index || 0;
    const start = Math.max(0, pos - 2800);
    const end = Math.min(html.length, pos + 2800);
    const windowText = html.substring(start, end);
    const urlMatch =
      windowText.match(/"product_url"\s*:\s*"([^"\\]+)"/i) ||
      windowText.match(/"url"\s*:\s*"([^"\\]+)"/i) ||
      windowText.match(/(\/[a-z]{2}(?:-[a-z]{2,3})?\/p\/[^"\\\s]+)/i);
    if (!urlMatch) continue;
    const abs = safeResolve(urlMatch[1], baseUrl);
    if (!abs || !isProductHref(abs)) continue;
    const imageMatch =
      windowText.match(/"image_url"\s*:\s*"(https:\\?\/?\/?f\.nooncdn\.com[^"\\\s]+?\.(?:jpe?g|webp|png|avif))"/i) ||
      windowText.match(/"image"\s*:\s*"(https:\\?\/?\/?f\.nooncdn\.com[^"\\\s]+?\.(?:jpe?g|webp|png|avif))"/i) ||
      windowText.match(/"thumbnail"\s*:\s*"(https:\\?\/?\/?f\.nooncdn\.com[^"\\\s]+?\.(?:jpe?g|webp|png|avif))"/i);
    const image = imageMatch ? resolveAndNormalizeImage(imageMatch[1], baseUrl) : "";
    const priceMatch = windowText.match(/"price"\s*:\s*\{\s*"amount"\s*:\s*([\d.]+)/i) || windowText.match(/"amount"\s*:\s*([\d.]+)/i);
    const price = priceMatch ? parseFloat(priceMatch[1]) : null;
    out.push({
      url: abs,
      product_name: cleanProductName(nameMatch[1].replace(/\\"/g, '"')),
      price: price && price > 0 ? price : null,
      image_url: image,
      image_url_high: upgradeImageQuality(image),
    });
  }
  return out;
}

function extractAnchorProducts(html: string, baseUrl: string): SiteProduct[] {
  const byUrl = new Map<string, SiteProduct>();
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']+?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const rawHref = match[1];
    const inner = match[2];
    const anchorStart = match.index || 0;
    const abs = safeResolve(rawHref, baseUrl);
    const anchorTag = match[0].slice(0, match[0].indexOf(">") + 1);
    // كلاس كارت المنتج وحده دليل كافٍ: ماجنتو وبعض المنصات تضع اسم المنتج نصًا داخل الرابط بدون صورة
    const isCatalogProductAnchor =
      /(?:product_icon_lnk|product-link|product__link|product__title|product-title|product-card|product_item|product-item|product-tile|grid-product|item-card|woocommerce-loop-product__link)/i.test(anchorTag);
    if (!abs || (!isProductHref(abs) && !isCatalogProductAnchor)) continue;
    const existing = byUrl.get(abs);
    // الرابط نفسه يظهر مرتين (كارت الصورة وكارت العنوان) — نتخطاه فقط إذا اكتملت بياناته
    if (existing && existing.product_name && existing.image_url) continue;
    const nearbyMarkup = html.slice(Math.max(0, anchorStart - 1200), Math.min(html.length, anchorStart + match[0].length + 1800));
    // نتجاهل نصوص السكربتات داخل النافذة حتى لا تُسقط منتجات متوفرة بسبب قوالب جاهزة
    const nearbyText = nearbyMarkup.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
    if (isOutOfStockText(inner) || isOutOfStockText(nearbyText)) continue;

    let name = "";
    const titleAttr = match[0].match(/\btitle\s*=\s*["']([^"']+)["']/i);
    const altAttr = match[0].match(/\balt\s*=\s*["']([^"']+)["']/i);
    const innerImages = [...inner.matchAll(/<img\b[^>]*>/gi)];
    const innerImg = innerImages[0]?.[0] || "";
    const imgAlt = innerImg ? extractImgAlt(innerImg) : "";
    const qaName = inner.match(/data-qa\s*=\s*["']productImagePLP_([^"']+)["']/i);
    const innerText = stripTags(inner);
    const candidates = [
      qaName ? qaName[1] : "",
      titleAttr?.[1],
      altAttr?.[1],
      imgAlt,
      innerText,
    ];
    for (const candidate of candidates) {
      const cleaned = cleanProductName(candidate || "");
      if (cleaned.length >= 3) {
        name = cleaned;
        break;
      }
    }

    let image = "";
    for (const imageMatch of innerImages) {
      const candidate = resolveAndNormalizeImage(extractImgSrc(imageMatch[0]), baseUrl);
      if (candidate && isProductImageUrl(candidate, baseUrl)) {
        image = candidate;
        break;
      }
    }

    const productCard = extractProductCardMarkup(html, anchorStart);
    const price = extractPriceFromInner(productCard || inner);
    if (!existing) {
      byUrl.set(abs, {
        url: abs,
        product_name: name,
        price,
        image_url: image,
        image_url_high: upgradeImageQuality(image),
      });
      continue;
    }
    if (!existing.product_name && name) existing.product_name = name;
    if ((existing.price === null || existing.price === undefined) && price) existing.price = price;
    if (!existing.image_url && image) {
      existing.image_url = image;
      existing.image_url_high = upgradeImageQuality(image);
    }
  }
  return [...byUrl.values()];
}

/* ---------- استخراج المنتجات من بيانات الصفحة المدمجة (متاجر تُبنى بالجافاسكربت) ---------- */

const EMBEDDED_NAME_KEYS = ["product_name", "productName", "name", "title", "product_title", "productTitle", "display_name"];
const EMBEDDED_PRICE_KEYS = ["price", "sale_price", "salePrice", "regular_price", "regularPrice", "final_price", "finalPrice", "current_price", "currentPrice", "amount"];
const EMBEDDED_IMAGE_KEYS = ["image_url", "imageUrl", "image", "images", "thumb", "thumbnail", "thumbnail_url", "thumbnailUrl", "main_image", "mainImage", "photo", "picture"];
const EMBEDDED_URL_KEYS = ["url", "link", "href", "permalink", "product_url", "productUrl", "absolute_url", "absoluteUrl", "canonical_url", "canonicalUrl"];

function firstTextValue(value: unknown, depth = 0): string {
  if (depth > 3 || value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstTextValue(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["src", "url", "value", "text", "content", "large", "medium"]) {
      const found = firstTextValue(record[key], depth + 1);
      if (found) return found;
    }
  }
  return "";
}

function firstPositiveNumber(value: unknown, depth = 0): number | null {
  if (depth > 3 || value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === "string") {
    const parsed = parseFloat(value.replace(/,/g, "").replace(/[^\d.]/g, ""));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstPositiveNumber(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["value", "amount", "price", "raw", "minimum", "min", "maximum"]) {
      const found = firstPositiveNumber(record[key], depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function pickKeyValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && value.trim().length === 0) continue;
    return value;
  }
  return undefined;
}

/** كائن يشبه المنتج: له اسم واضح + رابط (أو slug) + صورة أو سعر */
function embeddedProductRecord(record: Record<string, unknown>): {
  name: string;
  url: string;
  images: string[];
  price: number | null;
  description: string;
} | null {
  const nameRaw = pickKeyValue(record, EMBEDDED_NAME_KEYS);
  if (typeof nameRaw !== "string") return null;
  const name = cleanProductName(nameRaw);
  if (!name) return null;

  const imageRaw = pickKeyValue(record, EMBEDDED_IMAGE_KEYS);
  const priceRaw = pickKeyValue(record, EMBEDDED_PRICE_KEYS);
  if (imageRaw === undefined && priceRaw === undefined) return null;

  const urlRaw = pickKeyValue(record, EMBEDDED_URL_KEYS);
  const slug = typeof record.handle === "string" ? record.handle : typeof record.slug === "string" ? record.slug : "";
  const url = typeof urlRaw === "string" ? urlRaw : slug;
  if (!url) return null;

  const images: string[] = [];
  const collectImages = (value: unknown, depth: number) => {
    if (images.length >= 3 || depth > 3 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (/\.(?:jpe?g|webp|png|avif|gif)(?:$|[?#])/i.test(value)) images.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectImages(item, depth + 1));
      return;
    }
    if (typeof value === "object") {
      const nested = value as Record<string, unknown>;
      for (const key of ["src", "url", "image", "images", "image_url", "large", "original", "main"]) {
        collectImages(nested[key], depth + 1);
      }
    }
  };
  collectImages(imageRaw, 0);
  if (images.length === 0) collectImages(record.images, 0);

  return {
    name,
    url,
    images,
    price: firstPositiveNumber(priceRaw),
    description: firstTextValue(record.description ?? record.short_description ?? record.body_html),
  };
}

function resolveEmbeddedProductUrl(raw: string, baseUrl: string, origin: URL | null, record: Record<string, unknown>): string | null {
  const direct = safeResolve(raw, baseUrl);
  if (direct) return direct;
  const handle = typeof record.handle === "string" ? record.handle : raw;
  if (!origin || !handle || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,120}$/.test(handle)) return null;
  // المنصات التي تعتمد على handle (شوبيفاي وأمثالها): /products/{handle}
  return `${origin.protocol}//${origin.host}/products/${handle}`;
}

/** نرفض روابط غير مفيدة مثل جذر الموقع أو صفحاته العامة حتى لا تُحسب منتجات */
function isUsableEmbeddedProductUrl(abs: string): boolean {
  try {
    const parsed = new URL(abs);
    const path = parsed.pathname.replace(/\/+$/, "");
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) return false;
    if (segments.length === 1 && segments[0].length < 4) return false;
    return !/^\/(?:cart|checkout|login|account|search|blog|about|contact|privacy|terms|faq|sitemap)(?:\/|$)/i.test(path);
  } catch {
    return false;
  }
}

/** يقتطع أول قيمة JSON متوازنة (كائن/مصفوفة) من نص قد يتبعه كود */
function sliceBalancedJson(text: string): string | null {
  const trimmed = text.trimStart();
  const firstChar = trimmed[0];
  if (firstChar !== "{" && firstChar !== "[") return null;
  const open = firstChar;
  const close = firstChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return trimmed.slice(0, index + 1);
    }
    if (depth > 400) return null;
  }
  return null;
}

function collectEmbeddedJsonPayloads(html: string): string[] {
  const payloads: string[] = [];
  for (const block of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = block[1] || "";
    const body = (block[2] || "").trim();
    if (body.length < 40) continue;
    const isDataScript =
      /type\s*=\s*["'](?:application\/(?:ld\+)?json|text\/json)["']/i.test(attrs) ||
      /id\s*=\s*["']__NEXT_DATA__["']/i.test(attrs);
    if (isDataScript && /^[[{]/.test(body)) {
      payloads.push(body);
      continue;
    }
    const assignment = body.match(
      /(?:window\.__NUXT__|__NUXT_DATA__|window\.__PRELOADED_STATE__|window\.__INITIAL_STATE__|window\.__APP_DATA__|window\.__INITIAL_DATA__|window\.__STORE__)\s*=\s*/
    );
    if (assignment && typeof assignment.index === "number") {
      const json = sliceBalancedJson(body.slice(assignment.index + assignment[0].length));
      if (json) payloads.push(json);
    }
  }
  return payloads;
}

/** المنتجات المدمجة في بيانات الصفحة (Next.js/Nuxt ومنصات تُبنى بالجافاسكربت) */
function extractProductsFromEmbeddedJson(html: string, baseUrl: string): SiteProduct[] {
  const out: SiteProduct[] = [];
  const seen = new Set<string>();
  let origin: URL | null = null;
  try {
    origin = new URL(baseUrl);
  } catch {
    origin = null;
  }

  for (const payload of collectEmbeddedJsonPayloads(html)) {
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      continue;
    }
    const visit = (node: unknown) => {
      if (out.length >= 1000) return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      const found = embeddedProductRecord(record);
      if (found) {
        const abs = resolveEmbeddedProductUrl(found.url, baseUrl, origin, record);
        if (abs && isUsableEmbeddedProductUrl(abs) && !seen.has(abs) && !isOutOfStockRecord(record) && !isOutOfStockText(JSON.stringify(record).slice(0, 1500))) {
          const images = found.images
            .map((image) => resolveAndNormalizeImage(image, baseUrl))
            .filter(Boolean)
            .slice(0, 3);
          seen.add(abs);
          out.push({
            url: abs,
            product_name: found.name,
            price: found.price,
            image_url: images[0] || "",
            image_url_high: upgradeImageQuality(images[0] || ""),
            description: cleanDescription(found.description),
            images,
          });
        }
      }
      for (const key of Object.keys(record)) {
        const value = record[key];
        if (Array.isArray(value) || (value && typeof value === "object")) visit(value);
      }
    };
    visit(data);
  }

  return out;
}

/** روابط المنتجات المكتوبة داخل سكربتات الصفحة (بيانات Next.js/React المضغوطة) */
function extractScriptProductUrls(html: string, baseUrl: string): SiteProduct[] {
  const out: SiteProduct[] = [];
  const seen = new Set<string>();
  for (const block of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = block[1] || "";
    if (body.length < 40) continue;
    for (const match of body.matchAll(/["'`(]((?:https?:(?:\\?\/){2}[^"'`\s)]+)|(?:\/[^"'`\s)]+))["'`)\s,]/g)) {
      const raw = match[1].replace(/\\\//g, "/");
      if (raw.length > 400) continue;
      const abs = safeResolve(raw, baseUrl);
      if (!abs || seen.has(abs) || !isProductHref(abs)) continue;
      seen.add(abs);
      out.push({
        url: abs,
        product_name: productNameFromUrl(abs),
        price: null,
        image_url: "",
        image_url_high: "",
      });
      if (out.length >= 300) return out;
    }
  }
  return out;
}


function extractSiteProductsFromHtml(html: string, baseUrl: string): SiteProduct[] {
  const merged: SiteProduct[] = [];
  const isNoon = /noon\.com|nooncdn\.com/i.test(baseUrl);

  if (isDirectProductTarget(baseUrl)) {
    return extractSingleProductPage(html, baseUrl).map(finalizeSiteProduct);
  }

  if (isNoon) {
    merged.push(...extractNoonListingProducts(html, baseUrl));
    merged.push(...extractAnchorProducts(html, baseUrl));
  } else {
    // بيانات المنتجات المدمجة داخل الصفحة (Next.js/Nuxt/متاجر تُبنى بالجافاسكربت) قبل الاعتماد على الروابط
    merged.push(...extractJsonLdProducts(html, baseUrl));
    merged.push(...extractProductsFromEmbeddedJson(html, baseUrl));
    merged.push(...extractAnchorProducts(html, baseUrl));
    merged.push(...extractScriptProductUrls(html, baseUrl));
    merged.push(...extractNoonListingProducts(html, baseUrl));
  }

  const deduped = dedupeSiteProducts(merged);
  const withImage = deduped.filter((p) => p.image_url);
  return withImage.length > 0 ? withImage : deduped.filter((p) => p.product_name);
}

function findNextPageUrl(html: string, currentUrl: string): string | null {
  const linkNext =
    html.match(/<link\b[^>]*\brel\s*=\s*["']next["'][^>]*\bhref\s*=\s*["']([^"']+)["']/i) ||
    html.match(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["']next["']/i);
  if (linkNext && linkNext[1]) {
    const resolved = safeResolve(linkNext[1], currentUrl);
    if (resolved && resolved !== currentUrl) return resolved;
  }

  const pageMatch = currentUrl.match(/[?&](page|p)=(\d+)/i) || currentUrl.match(/\/page\/(\d+)/i);
  if (pageMatch) {
    const pageNumberIndex = pageMatch[2] ? 2 : 1;
    const next = parseInt(pageMatch[pageNumberIndex], 10) + 1;
    if (/[?&]page=/i.test(currentUrl)) return currentUrl.replace(/([?&]page=)\d+/i, `$1${next}`);
    if (/[?&]p=/i.test(currentUrl)) return currentUrl.replace(/([?&]p=)\d+/i, `$1${next}`);
    return currentUrl.replace(/(\/page\/)\d+\/?/i, `/page/${next}`);
  }

  // لا نخمّن صفحة تالية إلا إذا كان في الصفحة رابط ترقيم حقيقي (تجنّب طلب صفحات غير موجودة)
  const pageLinkMatch = html.match(/<a\b[^>]*href\s*=\s*["'][^"']*[?&](?:page|p)=\d+/i);
  const pathPageLink = html.match(/<a\b[^>]*href\s*=\s*["'][^"']*\/page\/\d+/i);
  if (pageLinkMatch || pathPageLink) {
    const sep = currentUrl.includes("?") ? "&" : "?";
    const param = pageLinkMatch && /[?&]p=\d+/i.test(pageLinkMatch[0]) ? "p" : "page";
    return `${currentUrl}${sep}${param}=2`;
  }
  return null;
}

function findCatalogSeedUrls(html: string, currentUrl: string): string[] {
  const current = new URL(currentUrl);
  const candidates: string[] = [];
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']+?)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null) {
    const resolved = safeResolve(match[1], currentUrl);
    if (!resolved || resolved === currentUrl || seenUrlHasProductShape(resolved)) continue;
    let parsed: URL;
    try {
      parsed = new URL(resolved);
    } catch {
      continue;
    }
    if (parsed.hostname !== current.hostname || NON_PRODUCT_URL_PATTERNS.some((pattern) => pattern.test(resolved))) continue;
    if (!/^\/(?:[a-z0-9%_.-]+\/){0,5}[a-z0-9%_.-]+\/?$/i.test(parsed.pathname)) continue;
    if (!candidates.includes(resolved)) candidates.push(resolved);
  }
  const prioritized = candidates.filter((candidate) =>
    /(?:all-products|all_products|all-products\.html|\/products\/?|\/shop\/?)/i.test(candidate)
  );
  const categoryCandidates = candidates.filter((candidate) => !prioritized.includes(candidate));
  const knownCategoryCandidates = categoryCandidates.filter((candidate) =>
    /\/(?:laptops?|computers?|printers?|network(?:ing)?|ups|servers?|mobiles?|tablets?|clearance|datashow)\b/i.test(candidate)
  );
  return [...prioritized, ...knownCategoryCandidates, ...categoryCandidates.filter((candidate) => !knownCategoryCandidates.includes(candidate))];
}

function seenUrlHasProductShape(url: string): boolean {
  return SITE_PRODUCT_HREF_PATTERNS.some((pattern) => pattern.test(url));
}

function sleepMillis(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNoonProductUrl(url: string): boolean {
  return /\/(?:[a-z]{2,7}(?:-[a-z]{2,3})?)\/[A-Za-z0-9%._-]+\/[A-Za-z0-9_-]{6,}\/p\/?(\?|$)/i.test(url);
}

function productNameFromUrl(productUrl: string): string {
  try {
    const parsed = new URL(productUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const productMarkerIndex = segments.findIndex((segment) => /^p$/i.test(segment));
    // نفضّل الـ slug الوصفي (كلمات مفصولة بشرطات) على معرّف المنتج القصير
    const ordered: string[] = (productMarkerIndex >= 2
      ? [segments[productMarkerIndex - 1], segments[productMarkerIndex - 2]]
      : [...segments].reverse()
    ).filter((item): item is string => Boolean(item) && !/^p$/i.test(item));
    const slugLike = ordered.find(
      (item) =>
        item.length >= 12 &&
        (item.match(/-/g) || []).length >= 2 &&
        (item.match(/[A-Za-z]/g) || []).length >= 3
    );
    const chosen = slugLike || ordered.find((item) => item.length >= 3) || "";
    return cleanProductName(decodeURIComponent(chosen).replace(/[-_]+/g, " "));
  } catch {
    return "";
  }
}

function isLikelySitemapProductUrl(productUrl: string): boolean {
  if (isProductHref(productUrl)) return true;
  try {
    const parsed = new URL(productUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) return false;
    const lastSegment = segments[segments.length - 1].replace(/\.(?:html?|php)$/i, "");
    if (lastSegment.length < 4 || /^\d+$/.test(lastSegment)) return false;
    if (NON_PRODUCT_LAST_SEGMENT.test(lastSegment.replace(/[-_]+/g, "-").toLowerCase())) return false;
    if (/(?:category|categories|collection|collections|blog|news|article|articles|brand|brands|search|tag|tags|page|account|cart|checkout)/i.test(parsed.pathname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** أسماء ملفات خرائط المنتجات — نتجنّب كلمة "item" داخل "sitemap" حتى لا يتطابق كل ملف */
const PRODUCT_SITEMAP_NAME_PATTERN = /(?:^|[-_/])(?:products?|pdp|items?|catalog)(?:[-_.]|$)/i;

const SITEMAP_SEED_PATHS = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/product-sitemap.xml",
  "/products-sitemap.xml",
  "/sitemap_products_1.xml",
  "/sitemap_products.xml",
  "/sitemap-products.xml",
  "/wp-sitemap.xml",
  "/catalog-sitemap.xml",
];

function sameHostname(url: string, hostname: string): boolean {
  try {
    return new URL(url).hostname === hostname;
  } catch {
    return false;
  }
}

function isProductSitemapName(sitemapUrl: string): boolean {
  let fileName = sitemapUrl;
  try {
    const parts = new URL(sitemapUrl).pathname.split("/").filter(Boolean);
    fileName = parts[parts.length - 1] || sitemapUrl;
  } catch {
    fileName = sitemapUrl.split("/").pop() || sitemapUrl;
  }
  return PRODUCT_SITEMAP_NAME_PATTERN.test(fileName);
}

/** robots.txt يعلن عن خرائط الموقع — أهم مصدر لروابط المنتجات في المتاجر التي تُبنى بالجافاسكربت */
async function fetchRobotsSitemapUrls(siteUrl: string): Promise<string[]> {
  let origin: URL;
  try {
    origin = new URL(siteUrl);
  } catch {
    return [];
  }
  const robots = await fetchProductPage(`${origin.protocol}//${origin.host}/robots.txt`, 15000);
  if (!robots) return [];
  const found: string[] = [];
  for (const match of robots.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)) {
    const raw = match[1].replace(/[.,;]+$/, "");
    const absolute = raw.startsWith("//") ? `https:${raw}` : raw;
    if (!sameHostname(absolute, origin.hostname) || found.includes(absolute)) continue;
    found.push(absolute);
  }
  return found;
}

/** بعض المتاجر الحديثة لا تعرض المنتجات في HTML، لكنها تنشر روابطها في robots.txt ثم sitemap */
async function fetchSitemapProducts(siteUrl: string, maxProducts: number): Promise<SiteProduct[]> {
  let origin: URL;
  try {
    origin = new URL(siteUrl);
  } catch {
    return [];
  }

  const seeds = await fetchRobotsSitemapUrls(siteUrl);
  for (const path of SITEMAP_SEED_PATHS) {
    const candidate = `${origin.protocol}//${origin.host}${path}`;
    if (!seeds.includes(candidate)) seeds.push(candidate);
  }

  const sitemapQueue = [...seeds];
  const queued = new Set(sitemapQueue);
  const visited = new Set<string>();
  const products = new Map<string, SiteProduct>();
  const MAX_SITEMAPS = 40;
  // حد أقصى لزمن فحص الخرائط حتى لا يتعطل السحب على المواقع التي لا تملك sitemap
  const deadline = Date.now() + 30000;

  while (
    sitemapQueue.length > 0 &&
    Date.now() < deadline &&
    visited.size < MAX_SITEMAPS &&
    products.size < maxProducts
  ) {
    const sitemapUrl = sitemapQueue.shift();
    if (!sitemapUrl || visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);

    const xml = await fetchProductPage(sitemapUrl, 20000);
    if (!xml || !/<(?:urlset|sitemapindex)\b/i.test(xml)) continue;

    const productSitemap = isProductSitemapName(sitemapUrl);
    const locations = [...xml.matchAll(/<loc[^>]*>\s*([\s\S]*?)\s*<\/loc>/gi)]
      .map((match) => safeResolve(stripTags(match[1]), sitemapUrl))
      .filter((value): value is string => Boolean(value));

    const childSitemaps: string[] = [];
    for (const location of locations) {
      if (/\.xml(?:[?#]|$)/i.test(location)) {
        if (!queued.has(location) && sameHostname(location, origin.hostname)) {
          queued.add(location);
          childSitemaps.push(location);
        }
        continue;
      }
      if (products.size >= maxProducts) break;
      if (!sameHostname(location, origin.hostname)) continue;
      // خرائط المنتجات المتخصصة نثق بمحتواها، وغيرها نشترط أن يشبه الرابط رابط منتج
      if (!(productSitemap && isProductHref(location)) && !isLikelySitemapProductUrl(location)) continue;
      const key = location.toLowerCase();
      if (products.has(key)) continue;
      products.set(key, {
        url: location,
        product_name: productNameFromUrl(location),
        price: null,
        image_url: "",
        image_url_high: "",
      });
    }

    // ملفات المنتجات الفرعية أولاً حتى نصل لروابط المنتجات بأقل عدد من الطلبات
    childSitemaps.sort((a, b) => Number(isProductSitemapName(b)) - Number(isProductSitemapName(a)));
    sitemapQueue.unshift(...childSitemaps);
  }

  return [...products.values()];
}

/* ---------- Shopify: سحب كل المنتجات عبر products.json ---------- */

function isShopifyProductPageUrl(url: string): boolean {
  return /\/products\/[A-Za-z0-9%._-]+\/?(\?|$)/i.test(url) && !/\.json$/i.test(url);
}

interface ShopifyJsonProduct {
  title?: string;
  handle?: string;
  body_html?: string;
  images?: Array<{ src?: string }>;
  variants?: Array<{ price?: string; available?: boolean }>;
}

async function fetchShopifyProductsPage(
  jsonUrlBase: string,
  page: number,
  limit: number
): Promise<ShopifyJsonProduct[] | null> {
  try {
    const separator = jsonUrlBase.includes("?") ? "&" : "?";
    const response = await fetch(`${jsonUrlBase}${separator}limit=${limit}&page=${page}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { products?: ShopifyJsonProduct[] };
    return Array.isArray(data.products) ? data.products : null;
  } catch {
    return null;
  }
}

function shopifyJsonToSiteProduct(product: ShopifyJsonProduct, origin: URL): SiteProduct | null {
  if (!product.handle) return null;
  const prices = (product.variants || [])
    .map((v) => parseFloat(String(v.price || "")))
    .filter((v) => !Number.isNaN(v) && v > 0);
  const images = (product.images || [])
    .map((im) => (typeof im?.src === "string" ? im.src : ""))
    .filter(Boolean);
  return {
    url: `${origin.protocol}//${origin.host}/products/${product.handle}`,
    product_name: cleanProductName(product.title || ""),
    price: prices.length > 0 ? Math.min(...prices) : null,
    image_url: images[0] || "",
    image_url_high: images[0] || "",
    description: product.body_html ? cleanDescription(product.body_html) : "",
    images: images.slice(0, 3),
  };
}

/** جرّب سحب كل منتجات متجر Shopify دفعة واحدة عبر products.json (كل منتج بوصفه وكل صوره) */
async function fetchShopifyCatalog(siteUrl: string, maxProducts: number): Promise<SiteProduct[] | null> {
  let origin: URL;
  try {
    origin = new URL(siteUrl);
  } catch {
    return null;
  }
  const jsonUrlBase = `${origin.protocol}//${origin.host}/products.json`;
  const firstPage = await fetchShopifyProductsPage(jsonUrlBase, 1, 250);
  if (!firstPage || firstPage.length === 0) return null;

  const out: SiteProduct[] = [];
  let page = 1;
  let products: ShopifyJsonProduct[] | null = firstPage;
  while (products && products.length > 0 && out.length < maxProducts) {
    for (const item of products) {
      if (out.length >= maxProducts) break;
      if (item.variants?.length && !item.variants.some((variant) => variant.available === true)) continue;
      const mapped = shopifyJsonToSiteProduct(item, origin);
      if (mapped) out.push(mapped);
    }
    if (products.length < 250 || out.length >= maxProducts) break;
    page++;
    await sleepMillis(300);
    products = await fetchShopifyProductsPage(jsonUrlBase, page, 250);
  }
  return out.length > 0 ? out : null;
}

/* ---------- WooCommerce: الكتالوج العام عبر Store API (يعمل حتى مع المتاجر التي تُبنى بالجافاسكربت) ---------- */

const SITE_PAGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface WooStoreProduct {
  name?: string;
  permalink?: string;
  description?: string;
  short_description?: string;
  prices?: {
    price?: string | number;
    regular_price?: string | number;
    sale_price?: string | number;
    currency_minor_unit?: number;
  };
  images?: Array<{ src?: string; thumbnail?: string }>;
  is_in_stock?: boolean;
  stock_status?: string;
  stock_quantity?: number | null;
}

function wooPriceValue(value: unknown, minorUnit: unknown): number | null {
  const parsed = parseFloat(String(value ?? "").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const unit = typeof minorUnit === "number" && minorUnit > 0 && minorUnit <= 6 ? minorUnit : 0;
  const scaled = unit > 0 ? parsed / Math.pow(10, unit) : parsed;
  return scaled > 0 ? Number(scaled.toFixed(2)) : null;
}

async function fetchWooProductsPage(origin: URL, page: number, limit: number): Promise<WooStoreProduct[] | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    const response = await fetch(
      `${origin.protocol}//${origin.host}/wp-json/wc/store/v1/products?per_page=${limit}&page=${page}`,
      {
        headers: { "User-Agent": SITE_PAGE_USER_AGENT, Accept: "application/json" },
        signal: controller.signal,
      }
    );
    clearTimeout(timeoutId);
    if (!response.ok) return null;
    // المتاجر التي تُبنى بالجافاسكربت ترد بصفحة HTML على كل المسارات — نرفض أي استجابة ليست JSON
    if (!/json/i.test(response.headers.get("content-type") || "")) return null;
    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) return null;
    return data as WooStoreProduct[];
  } catch {
    return null;
  }
}

/** سحب كتالوج WooCommerce كامل عبر Store API العام (اسم + سعر + وصف + كل الصور) */
async function fetchWooCatalog(siteUrl: string, maxProducts: number): Promise<SiteProduct[] | null> {
  let origin: URL;
  try {
    origin = new URL(siteUrl);
  } catch {
    return null;
  }

  const out: SiteProduct[] = [];
  const seen = new Set<string>();
  const limit = 100;
  const maxPages = 500;

  for (let page = 1; page <= maxPages && out.length < maxProducts; page += 1) {
    const items = await fetchWooProductsPage(origin, page, limit);
    if (!items) return null;
    if (items.length === 0) break;

    for (const item of items) {
      if (out.length >= maxProducts) break;
      if (!isInStockRecord(item as Record<string, unknown>)) continue;
      const abs = safeResolve(String(item.permalink || ""), `${origin.protocol}//${origin.host}/`);
      const name = cleanProductName(String(item.name || ""));
      if (!abs || !name || seen.has(abs)) continue;
      const images = (Array.isArray(item.images) ? item.images : [])
        .map((image) => resolveAndNormalizeImage(String(image?.src || image?.thumbnail || ""), abs))
        .filter(Boolean)
        .slice(0, 30);
      seen.add(abs);
      out.push({
        url: abs,
        product_name: name,
        price: wooPriceValue(item.prices?.sale_price ?? item.prices?.price ?? item.prices?.regular_price, item.prices?.currency_minor_unit),
        image_url: images[0] || "",
        image_url_high: upgradeImageQuality(images[0] || ""),
        description: cleanDescription(stripTags(String(item.short_description || item.description || ""))),
        images,
      });
    }

    if (items.length < limit) break;
    await sleepMillis(150);
  }

  return out.length > 0 ? out : null;
}

/* ---------- EasyOrders: متاجر تُبنى بالجافاسكربت (Next.js) — الكتالوج يُسحب من API المنصة ---------- */

const EASY_ORDERS_API_BASE = "https://api.easy-orders.net/api/v1";

interface EasyOrdersProduct {
  id?: string;
  name?: string;
  price?: number;
  sale_price?: number;
  description?: string;
  slug?: string;
  thumb?: string;
  images?: string[];
  hidden?: boolean;
  in_stock?: boolean;
  available?: boolean;
  stock_status?: string;
  stock_quantity?: number;
  quantity?: number;
}

interface EasyOrdersProductsPage {
  data?: EasyOrdersProduct[];
  next_page?: number | string | null;
  page?: number;
  total?: number;
  totalPages?: number;
}

/** هل الموقع متجر على منصة EasyOrders؟ ولو نعم نرجّع معرّف المتجر وأصله */
async function resolveEasyOrdersStore(
  targetUrl: string
): Promise<{ storeId: string; origin: string } | null> {
  let origin: URL;
  try {
    origin = new URL(targetUrl);
  } catch {
    return null;
  }
  const siteOrigin = `${origin.protocol}//${origin.host}`;
  let html = "";
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    const response = await fetch(`${siteOrigin}/`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) return null;
    html = await response.text();
  } catch {
    return null;
  }
  if (!/easyorders/i.test(html)) return null;
  const scriptMatch = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!scriptMatch) return null;
  try {
    const nextData = JSON.parse(scriptMatch[1]) as {
      props?: { pageProps?: { appSettings?: { id?: unknown } } };
    };
    const storeId = nextData.props?.pageProps?.appSettings?.id;
    if (typeof storeId !== "string" || storeId.length < 8) return null;
    return { storeId, origin: siteOrigin };
  } catch {
    return null;
  }
}

function easyOrdersImageUrl(value: string): string {
  return cleanUpImageUrl(String(value || "")).replace(
    "https://easyorders.fra1.digitaloceanspaces.com",
    "https://files.easy-orders.net"
  );
}

function easyOrdersProductToSiteProduct(
  product: EasyOrdersProduct,
  siteOrigin: string
): SiteProduct | null {
  const slug = String(product.slug || "").trim();
  if (!slug) return null;
  const images = (Array.isArray(product.images) ? product.images : [])
    .map((image) => easyOrdersImageUrl(String(image || "")))
    .filter(Boolean);
  const thumb = easyOrdersImageUrl(String(product.thumb || "")) || images[0] || "";
  const salePrice = typeof product.sale_price === "number" && product.sale_price > 0 ? product.sale_price : null;
  const basePrice = typeof product.price === "number" && product.price > 0 ? product.price : null;
  return {
    url: `${siteOrigin}/products/${slug}`,
    product_name: cleanProductName(product.name || ""),
    price: salePrice || basePrice,
    image_url: thumb || images[0] || "",
    image_url_high: images[0] || thumb || "",
    description: product.description ? cleanDescription(product.description) : "",
    images: images.slice(0, 3),
  };
}

async function fetchEasyOrdersProductsPage(
  storeId: string,
  siteOrigin: string,
  page: number,
  limit: number
): Promise<EasyOrdersProductsPage | null> {
  try {
    const params = new URLSearchParams({ limit: String(limit), page: String(page), store_id: storeId });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    const response = await fetch(`${EASY_ORDERS_API_BASE}/products?${params.toString()}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json",
        Origin: siteOrigin,
        Referer: `${siteOrigin}/`,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) return null;
    const payload = (await response.json()) as EasyOrdersProductsPage | EasyOrdersProduct[];
    if (Array.isArray(payload)) return { data: payload, totalPages: 1 };
    return payload;
  } catch {
    return null;
  }
}

/** سحب كل منتجات متجر EasyOrders من API المنصة (صفحة المتجر تُبنى بالجافاسكربت ولا تحتوي المنتجات في HTML) */
async function fetchEasyOrdersCatalog(
  targetUrl: string,
  maxProducts: number
): Promise<SiteProduct[] | null> {
  const store = await resolveEasyOrdersStore(targetUrl);
  if (!store) return null;

  const out: SiteProduct[] = [];
  const seen = new Set<string>();
  const limit = 100;
  let page = 1;
  const maxPages = 500;

  while (out.length < maxProducts && page <= maxPages) {
    const payload = await fetchEasyOrdersProductsPage(store.storeId, store.origin, page, limit);
    if (!payload || !Array.isArray(payload.data)) return null;
    const items = payload.data;
    if (items.length === 0) break;

    for (const item of items) {
      if (out.length >= maxProducts) break;
      if (item.hidden === true || !isInStockRecord(item as Record<string, unknown>)) continue;
      const mapped = easyOrdersProductToSiteProduct(item, store.origin);
      if (!mapped || !mapped.url || seen.has(mapped.url)) continue;
      seen.add(mapped.url);
      out.push(mapped);
    }

    if (
      (typeof payload.totalPages === "number" && page >= payload.totalPages) ||
      items.length < limit
    ) {
      break;
    }
    const nextPage = Number(payload.next_page);
    page = Number.isInteger(nextPage) && nextPage > page ? nextPage : page + 1;
    await sleepMillis(250);
  }

  return out.length > 0 ? out : null;
}

/** صفات الصفحة التي تُبنى بالجافاسكربت (React/Next.js) — لا تحتوي المنتجات في الـ HTML */
function looksLikeClientRenderedPage(html: string): boolean {
  if (!html) return false;
  if (/__NEXT_DATA__|id=["']__next["']|__NUXT__|__NUXT_DATA__/i.test(html)) return true;
  const anchorCount = (html.match(/<a\b/gi) || []).length;
  if (anchorCount < 5 && /<script\b/i.test(html)) return true;
  if (anchorCount < 15 && /_next\/static|nuxt|webpack|vite\/client|__vite/i.test(html)) return true;
  return false;
}

/** سحب منتج Shopify واحد عبر {url}.json (اسم + سعر + وصف + كل الصور بالجودة الأصلية) */
async function tryShopifyProductJson(productUrl: string): Promise<DeepProduct | null> {
  const cleanUrl = productUrl.split("?")[0].replace(/\/$/, "");
  if (!/\/products\/[A-Za-z0-9%._-]+$/i.test(cleanUrl)) return null;
  try {
    const response = await fetch(`${cleanUrl}.json`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { product?: ShopifyJsonProduct };
    const product = data.product;
    if (!product) return null;
    const prices = (product.variants || [])
      .map((v) => parseFloat(String(v.price || "")))
      .filter((v) => !Number.isNaN(v) && v > 0);
    const images = (product.images || [])
      .map((im) => (typeof im?.src === "string" ? im.src : ""))
      .filter(Boolean);
    return {
      url: productUrl,
      product_name: cleanProductName(product.title || ""),
      price: prices.length > 0 ? Math.min(...prices) : null,
      description: product.body_html ? cleanDescription(product.body_html) : "",
      images: images.slice(0, 3),
      image_url: images[0] || "",
    };
  } catch {
    return null;
  }
}

async function extractSiteProducts(
  targetUrl: string,
  maxPages: number,
  maxProducts: number
): Promise<{ products: SiteProduct[]; pagesFetched: number; stoppedReason: string }> {
  const all: SiteProduct[] = [];
  const seen = new Set<string>();
  let currentUrl = targetUrl;
  let pagesFetched = 0;
  let emptyStreak = 0;
  let stoppedReason = "اكتمل السحب بنجاح";
  let lastFetchedHtml = "";
  const pendingCatalogUrls: string[] = [];
  const queuedCatalogUrls = new Set<string>();

  // Shopify: سحب كل المنتجات مباشرة عبر products.json (كل منتج بوصفه وكل صوره بالجودة الأصلية)
  if (!isShopifyProductPageUrl(targetUrl)) {
    const shopifyCatalog = await fetchShopifyCatalog(targetUrl, maxProducts);
    if (shopifyCatalog && shopifyCatalog.length > 0) {
      return {
        products: shopifyCatalog,
        pagesFetched: Math.max(1, Math.ceil(shopifyCatalog.length / 250)),
        stoppedReason: `تم سحب كل منتجات متجر Shopify (${shopifyCatalog.length} منتج) بكل بياناتها`,
      };
    }
  }

  // EasyOrders: متاجر تُبنى بالجافاسكربت، فالمنتجات تُسحب من API المنصة لأن صفحة المتجر لا تحتويها في HTML
  if (!isDirectProductTarget(targetUrl)) {
    const easyOrdersCatalog = await fetchEasyOrdersCatalog(targetUrl, maxProducts);
    if (easyOrdersCatalog && easyOrdersCatalog.length > 0) {
      return {
        products: easyOrdersCatalog,
        pagesFetched: 1,
        stoppedReason: `تم سحب كل منتجات المتجر (${easyOrdersCatalog.length} منتج) مباشرة من كتالوج المنصة`,
      };
    }
  }

  // WooCommerce (Store API عام): كتالوج كامل بنقرة واحدة، ويعمل أيضًا مع المتاجر التي تُبنى بالجافاسكربت
  if (!isDirectProductTarget(targetUrl)) {
    const wooCatalog = await fetchWooCatalog(targetUrl, maxProducts);
    if (wooCatalog && wooCatalog.length > 0) {
      return {
        products: wooCatalog,
        pagesFetched: Math.max(1, Math.ceil(wooCatalog.length / 100)),
        stoppedReason: `تم سحب ${wooCatalog.length} منتج من كتالوج المتجر (WooCommerce Store API)`,
      };
    }
  }

  // نون: رفع حد العناصر في الصفحة الواحدة لجلب أكبر عدد من المنتجات
  if (/noon\.com/i.test(currentUrl) && !isNoonProductUrl(currentUrl)) {
    try {
      const boosted = new URL(currentUrl);
      boosted.searchParams.set("limit", "1000");
      currentUrl = boosted.href;
    } catch {
      // نتجاهل أخطاء التحليل
    }
  }

  while (pagesFetched < maxPages && all.length < maxProducts) {
    let html = "";
    let lastError = "";
    // جرّب الجلب مع إعادة محاولة (نون وأمازون يقيّدان الطلبات المتكررة)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        html = await fetchProductPage(currentUrl, 60000);
        if (html && html.length > 1000) break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempt < 3) await sleepMillis(1500 * attempt);
    }
    if (!html || html.length <= 1000) {
      const httpStatus = lastPageFetch.status;
      const fetchError = lastError || lastPageFetch.error;
      stoppedReason = httpStatus
        ? `الموقع رد بحالة HTTP ${httpStatus} على الصفحة ${pagesFetched + 1} (الرابط غير متاح للزوار العاديين أو الموقع يحجب الجلب الآلي)`
        : fetchError
          ? `تعذّر الوصول للصفحة ${pagesFetched + 1}: ${fetchError}`
          : `تعذّر الوصول للصفحة ${pagesFetched + 1} (قد يكون الموقع يمنع الوصول الآلي)`;
      break;
    }
    lastFetchedHtml = html;
    pagesFetched++;

    const pageProducts = extractSiteProductsFromHtml(html, currentUrl);
    let added = 0;
    for (const product of pageProducts) {
      if (all.length >= maxProducts) break;
      const key = product.url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(product);
      added++;
    }
    emptyStreak = added === 0 ? emptyStreak + 1 : 0;
    if (emptyStreak >= 2) {
      stoppedReason = "لا توجد منتجات جديدة في الصفحات التالية";
      break;
    }
    if (all.length >= maxProducts) {
      stoppedReason = `وصلنا للحد الأقصى (${maxProducts} منتج)`;
      break;
    }
    if (pagesFetched >= maxPages) {
      stoppedReason = `فحصنا ${maxPages} صفحة`;
      break;
    }

    if (pageProducts.length === 0) {
      for (const catalogUrl of findCatalogSeedUrls(html, currentUrl)) {
        if (catalogUrl !== currentUrl && !queuedCatalogUrls.has(catalogUrl)) {
          queuedCatalogUrls.add(catalogUrl);
          pendingCatalogUrls.push(catalogUrl);
        }
      }
    }
    const nextUrl = findNextPageUrl(html, currentUrl) || pendingCatalogUrls.shift() || null;
    if (!nextUrl) {
      stoppedReason = pagesFetched === 1 ? "لا توجد صفحات أخرى" : "انتهت صفحات الترقيم";
      break;
    }
    currentUrl = nextUrl;
  }

  // إن لم نجد سوى رابطة أو رابطتين فالصفحة غالبًا غلاف جافاسكربت — نجرّب robots/sitemap بدل إعلان الفشل
  // ولا نطبّق ذلك على رابط منتج مباشر حتى لا نستبدل المنتج المطلوب بكتالوج الموقع كله
  if (all.length < 3 && !isDirectProductTarget(targetUrl)) {
    if (all.length === 0) {
      const isBlockedDirectProduct = isDirectProductTarget(targetUrl) ||
        (/(^|\.)noon\.com$/i.test(new URL(targetUrl).hostname) && /\/[^/]+\/[^/]+\/p\/?$/i.test(new URL(targetUrl).pathname));
      if (isBlockedDirectProduct) {
        const fallbackProduct = extractSingleProductPage("", targetUrl);
        if (fallbackProduct.length > 0) {
          return {
            products: fallbackProduct,
            pagesFetched,
            stoppedReason: "تعذر فتح صفحة المنتج آليًا، تمت إضافة الرابط وسيتم محاولة سحب بياناته لاحقًا",
          };
        }
      }
    }
    const sitemapProducts = await fetchSitemapProducts(targetUrl, maxProducts);
    if (sitemapProducts.length > all.length) {
      for (const product of sitemapProducts) {
        if (all.length >= maxProducts) break;
        const key = product.url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(product);
      }
      return {
        products: dedupeSiteProducts(all),
        pagesFetched,
        stoppedReason: `تم العثور على ${sitemapProducts.length} رابط منتج من خريطة الموقع (robots/sitemap)، وسيتم جلب بياناتها عند السحب الكامل`,
      };
    }
    if (all.length > 0) return { products: dedupeSiteProducts(all), pagesFetched, stoppedReason };

    // المواقع الحديثة (React/Next.js) تبني المنتجات بالجافاسكربت — نوضّح السبب بدل ترك رسالة غامضة
    if (looksLikeClientRenderedPage(lastFetchedHtml)) {
      stoppedReason = `${stoppedReason} — الصفحة تُبنى بالجافاسكربت (React/Next.js) ولا تحتوي روابط منتجات في HTML، ولم نجد كتالوجًا عبر robots/sitemap. جرّب رابط قسم/بحث من نفس الموقع أو رابط منتج مباشر`;
    } else {
      stoppedReason = `${stoppedReason} — لم نجد روابط منتجات في الصفحة ولا في خريطة الموقع (sitemap). تأكد أن الرابط صفحة قسم/بحث أو رابط منتج مباشر`;
    }
  }

  return { products: dedupeSiteProducts(all), pagesFetched, stoppedReason };
}

/* ==========================================================
   سحب كامل لصفحات المنتجات: الاسم + السعر + الوصف + كل الصور
   ========================================================== */

interface DeepProduct {
  url: string;
  product_name: string;
  product_name_ar?: string;
  price: number | null;
  description: string;
  description_ar?: string;
  images: string[];
  image_url: string;
  error?: string;
}

function cleanDescription(raw: string): string {
  return repairUtf8Mojibake(String(raw || "").trim());
}

function containsArabic(value: string): boolean {
  return /[\u0600-\u06ff]/.test(value);
}

interface JsonLdProductRecord {
  name?: string;
  url?: string;
  description?: string;
  imageUrls: string[];
  price: number | null;
}

function collectJsonImageUrls(node: unknown, baseUrl: string, out: string[]): void {
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const resolved = resolveAndNormalizeImage(value, baseUrl);
    if (resolved && !out.includes(resolved)) out.push(resolved);
  };
  if (!node) return;
  if (typeof node === "string") {
    push(node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => collectJsonImageUrls(child, baseUrl, out));
    return;
  }
  if (typeof node === "object") {
    const record = node as Record<string, unknown>;
    for (const key of ["url", "contentUrl", "@id", "src"]) {
      if (typeof record[key] === "string") push(record[key]);
    }
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (Array.isArray(value) || (value && typeof value === "object")) collectJsonImageUrls(value, baseUrl, out);
    }
  }
}

function collectJsonLdProductRecords(html: string, baseUrl: string): JsonLdProductRecord[] {
  const records: JsonLdProductRecord[] = [];
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    if (!block[1]) continue;
    let data: unknown;
    try {
      data = JSON.parse(block[1].trim());
    } catch {
      continue;
    }
    const walk = (node: unknown) => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      const t = record["@type"];
      const types = Array.isArray(t) ? t.map(String).join(" ") : String(t || "");
      if (/Product/i.test(types)) {
        const offers = Array.isArray(record.offers) ? record.offers : [record.offers];
        const offerUrl = offers.find(
          (offer): offer is Record<string, unknown> =>
            Boolean(offer && typeof offer === "object" && typeof (offer as Record<string, unknown>).url === "string")
        )?.url;
        const record2: JsonLdProductRecord = {
          name: typeof record.name === "string" ? record.name : undefined,
          url: typeof record.url === "string"
            ? record.url
            : typeof record["@id"] === "string"
              ? String(record["@id"])
              : typeof offerUrl === "string"
                ? offerUrl
                : undefined,
          description: typeof record.description === "string" ? record.description : undefined,
          imageUrls: [],
          price: extractJsonOfferPrice(record.offers),
        };
        collectJsonImageUrls(record.image, baseUrl, record2.imageUrls);
        records.push(record2);
      }
      for (const key of Object.keys(record)) {
        const value = record[key];
        if (Array.isArray(value) || (value && typeof value === "object")) walk(value);
      }
    };
    walk(data);
  }
  return records;
}

function normalizeProductPageUrl(value: string, baseUrl: string): string {
  const resolved = safeResolve(value, baseUrl);
  if (!resolved) return "";
  try {
    const parsed = new URL(resolved);
    return `${parsed.origin.toLowerCase()}${parsed.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return "";
  }
}

function getPrimaryJsonLdProductRecord(
  records: JsonLdProductRecord[],
  html: string,
  baseUrl: string
): JsonLdProductRecord | undefined {
  if (records.length === 0) return undefined;

  const canonicalMatch =
    html.match(/<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']canonical["'][^>]*>/i);
  const pageUrls = new Set([baseUrl, canonicalMatch?.[1] || ""].map((url) => normalizeProductPageUrl(url, baseUrl)).filter(Boolean));
  const urlMatch = records.find((record) => record.url && pageUrls.has(normalizeProductPageUrl(record.url, baseUrl)));
  if (urlMatch) return urlMatch;

  const title = cleanProductName(
    extractMetaContent(html, "og:title") ||
      extractMetaContent(html, "twitter:title") ||
      html.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i)?.[1] ||
      ""
  ).toLowerCase().replace(/\s+/g, " ").trim();
  if (title.length >= 5) {
    const nameMatches = records.filter((record) => {
      const name = cleanProductName(record.name || "").toLowerCase().replace(/\s+/g, " ").trim();
      return name.length >= 5 && (name === title || name.includes(title) || title.includes(name));
    });
    nameMatches.sort((left, right) => {
      const leftName = cleanProductName(left.name || "").toLowerCase().replace(/\s+/g, " ").trim();
      const rightName = cleanProductName(right.name || "").toLowerCase().replace(/\s+/g, " ").trim();
      return Number(rightName === title) - Number(leftName === title) || rightName.length - leftName.length;
    });
    if (nameMatches[0]) return nameMatches[0];
  }

  return undefined;
}

function extractProductPagePrice(
  html: string,
  records: JsonLdProductRecord[],
  allowGenericPagePrice = true
): number | null {
  // 1) meta og:price:amount / product:price:amount
  const meta =
    html.match(/property=["'](?:og:price:amount|product:price:amount)["']\s*content=["']([\d.,]+)["']/i) ||
    html.match(/content=["']([\d.,]+)["']\s*property=["'](?:og:price:amount|product:price:amount)["']/i);
  if (meta) {
    const value = parseFloat(meta[1].replace(/,/g, ""));
    if (value > 0) return value;
  }
  // 2) JSON-LD offers
  const jsonPrices = records.map((r) => r.price).filter((p): p is number => typeof p === "number" && p > 0);
  if (jsonPrices.length > 0) return Math.min(...jsonPrices);
  if (!allowGenericPagePrice) return null;
  const currencyPattern = "(?:EGP|AED|SAR|QAR|KWD|OMR|BHD|JOD|LBP|USD|EUR|GBP|LE|ج\\.م|ر\\.س|درهم|ريال|جنيه)";
  const prominentPrice = new RegExp(
    `<(?:span|div)\\b[^>]*class=["'][^"']*(?:h3|price|accent)[^"']*["'][^>]*>\\s*${currencyPattern}\\s*([\\d,]+(?:\\.\\d{1,2})?)`,
    "i"
  ).exec(html);
  if (prominentPrice) {
    const value = parseFloat(prominentPrice[1].replace(/,/g, ""));
    if (value > 0) return value;
  }
  // 3) حاويات الأسعار (Dawn وغيره) — سعر التخفيض مقدمًا إن وجد
  const containers = [
    /price__sale[\s\S]{0,800}?([\d,]+(?:\.\d{1,2})?)\s*(?:EGP|ج\.م|ر\.س|درهم|LE|AED|SAR|USD)/i,
    /price__regular[\s\S]{0,800}?([\d,]+(?:\.\d{1,2})?)\s*(?:EGP|ج\.م|ر\.س|درهم|LE|AED|SAR|USD)/i,
    /(?:price|sale)[^<>{}]{0,40}?>[^<]{0,20}([\d,]+(?:\.\d{1,2})?)\s*(?:EGP|ج\.م|ر\.س|درهم|LE|AED|SAR|USD)/i,
  ];
  for (const pattern of containers) {
    const match = html.match(pattern);
    if (match) {
      const value = parseFloat(match[1].replace(/,/g, ""));
      if (value > 0) return value;
    }
  }
  const currencyPrices = [...html.matchAll(new RegExp(`${currencyPattern}\\s*([\\d,]+(?:\\.\\d{1,2})?)`, "gi"))]
    .map((match) => parseFloat(match[1].replace(/,/g, "")))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (currencyPrices.length > 0) return currencyPrices[0];
  return null;
}

const NOISE_IMAGE_URL: RegExp =
  /(?:^|[/_.-])(?:logo|icon|favicon|sprite|place[-_]?holder|avatar|payment|flag|badge|spinner|loader|loading|no[-_]?bg|default[-_]?image)(?:[/_.-]|$)/i;

function isProductImageUrl(imageUrl: string, pageUrl: string): boolean {
  if (NOISE_IMAGE_URL.test(imageUrl)) return false;
  try {
    const pageHost = new URL(pageUrl).hostname;
    const image = new URL(imageUrl);
    if (/(^|\.)elarabygroup\.com$/i.test(pageHost)) {
      return /(^|\.)elarabygroup\.com$/i.test(image.hostname) && /\/media\/catalog\/product\//i.test(image.pathname);
    }
  } catch {
    return false;
  }
  return true;
}

function extractElArabyMagentoGalleryImages(html: string): string[] {
  const images: string[] = [];
  const scripts = html.matchAll(/<script\b[^>]*type=["']text\/x-magento-init["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const script of scripts) {
    let config: unknown;
    try {
      config = JSON.parse((script[1] || "").trim());
    } catch {
      continue;
    }
    if (!config || typeof config !== "object") continue;
    const galleryConfig = (config as Record<string, unknown>)["[data-gallery-role=gallery-placeholder]"];
    if (!galleryConfig || typeof galleryConfig !== "object") continue;
    const gallery = (galleryConfig as Record<string, unknown>)["mage/gallery/gallery"];
    if (!gallery || typeof gallery !== "object") continue;
    const entries = (gallery as { data?: unknown }).data;
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const image = entry as Record<string, unknown>;
      if (typeof image.type === "string" && image.type !== "image") continue;
      const url = [image.full, image.img, image.thumb].find((value) => typeof value === "string");
      if (typeof url === "string" && !images.includes(url)) images.push(url);
      if (images.length >= 3) return images;
    }
  }
  return images;
}

function extractProductGalleryImgTags(html: string, galleryContext: RegExp): string[] {
  const tags = /<!--[\s\S]*?-->|<\/?([a-z][\w:-]*)\b[^>]*>/gi;
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const ancestors: Array<{ name: string; isGallery: boolean }> = [];
  const imageTags: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = tags.exec(html)) !== null) {
    const tag = match[0];
    const tagName = (match[1] || "").toLowerCase();
    if (!tagName) continue;

    if (/^<\//.test(tag)) {
      for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        if (ancestors[index].name === tagName) {
          ancestors.length = index;
          break;
        }
      }
      continue;
    }

    if (tagName === "img" && (ancestors.some((ancestor) => ancestor.isGallery) || galleryContext.test(tag))) {
      imageTags.push(tag);
    }
    if (!voidTags.has(tagName) && !/\/\s*>$/.test(tag)) {
      ancestors.push({ name: tagName, isGallery: galleryContext.test(tag) });
    }
  }

  return imageTags;
}

function extractGalleryImgSrc(imgTag: string): string {
  if (!imgTag) return "";
  const priority: RegExp[] = [
    /\bdata-large_image\s*=\s*["']([^"']+)["']/i,
    /\bdata-zoom-image\s*=\s*["']([^"']+)["']/i,
    /\bdata-large-src\s*=\s*["']([^"']+)["']/i,
    /\bdata-full-src\s*=\s*["']([^"']+)["']/i,
    /\bdata-hi-res-src\s*=\s*["']([^"']+)["']/i,
    /\bdata-src\s*=\s*["']([^"']+)["']/i,
    /\bdata-lazy-src\s*=\s*["']([^"']+)["']/i,
    /\bdata-original\s*=\s*["']([^"']+)["']/i,
    /\bsrc\s*=\s*["']([^"']+)["']/i,
  ];
  for (const pattern of priority) {
    const match = imgTag.match(pattern);
    if (match && match[1]) return match[1].trim();
  }
  // srcset: اختر الأكبر عرضاً
  const srcsetMatch = imgTag.match(/\b(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/i);
  if (srcsetMatch && srcsetMatch[1]) {
    const entries = srcsetMatch[1].split(",").map((entry) => entry.trim()).filter(Boolean);
    let bestUrl = "";
    let bestWidth = -1;
    for (const entry of entries) {
      const parts = entry.split(/\s+/);
      const url = parts[0];
      const widthMatch = parts[1] && parts[1].match(/^(\d+)w$/i);
      const width = widthMatch ? parseInt(widthMatch[1], 10) : 0;
      if (width > bestWidth) {
        bestWidth = width;
        bestUrl = url;
      }
    }
    if (bestUrl) return bestUrl;
  }
  return "";
}

function toHighQualityImageUrl(url: string): string {
  // Shopify / أي CDN بمعامل width: ارفع الدقة إلى 2000
  if (/width=\d+/i.test(url)) return url.replace(/width=\d+/gi, "width=2000");
  if (/\/cdn\/shop\//i.test(url)) {
    const upgraded = `${url}${url.includes("?") ? "&" : "?"}width=2000`;
    return upgraded;
  }
  return upgradeImageQuality(url);
}

function extractGalleryImages(html: string, baseUrl: string): string[] {
  const collected: Array<{ url: string; priority: number; order: number }> = [];
  let order = 0;

  const addImage = (rawUrl: string, priority: number) => {
    const resolved = resolveAndNormalizeImage(rawUrl, baseUrl);
    if (!resolved) return;
    if (!isProductImageUrl(resolved, baseUrl)) return;
    collected.push({ url: resolved, priority, order: order++ });
  };

  // 1) JSON-LD Product images (أضمن مصدر لصور المنتج)
  const jsonLdRecords = collectJsonLdProductRecords(html, baseUrl);
  const primaryRecord = getPrimaryJsonLdProductRecord(jsonLdRecords, html, baseUrl);
  if (primaryRecord) {
    for (const url of primaryRecord.imageUrls) addImage(url, 2);
  }

  // 2) نون: image_urls / media_gallery (كل صور المنتج)
  const noonArrays = [...html.matchAll(/(?:image_urls|media_gallery):\$\s*\[\d+\]\s*=\s*(\[[\s\S]*?\]|\{[\s\S]*?\})/g)];
  for (const arrayMatch of noonArrays.slice(0, 1)) {
    const urls = arrayMatch[1].match(/https:\/\/f\.nooncdn\.com\/[^"'\\\s,]+/g) || [];
    for (const url of urls) addImage(url.replace(/\\(.)"/g, "$1"), 2);
  }

  const productGalleryContext =
    /product(?:__|[-_ ])(?:media|gallery|images|carousel|slider)|woocommerce-product-gallery|pdp[-_ ](?:gallery|images)|ProductGallery|ProductImages/i;

  const isElArabyGroup = /(^|\.)elarabygroup\.com$/i.test(new URL(baseUrl).hostname);
  if (isElArabyGroup) {
    for (const url of extractElArabyMagentoGalleryImages(html)) addImage(url, 3);
  } else {
    // 3) أمازون: الصور الديناميكية داخل صورة المنتج الرئيسية أو معرضه فقط
    const dynamicImages = [...html.matchAll(/\bdata-a-dynamic-image\s*=\s*(["'])([\s\S]*?)\1/gi)].filter((match) => {
      const tagStart = match.index || 0;
      const context = html.substring(Math.max(0, tagStart - 600), tagStart);
      return /id=["']landingImage["']/i.test(context) || productGalleryContext.test(context);
    });
    for (const match of dynamicImages) {
      const jsonText = match[2]
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&apos;/g, "'");
      const urls = jsonText.match(/https?:[\\/]{2}[^"'\s<>]+?\.(?:jpe?g|png|webp|avif)/gi) || [];
      for (const url of urls) addImage(cleanUpImageUrl(url), 2);
    }

    // 4) وسوم <img> داخل حاويات معرض المنتج فقط
    for (const imgTag of extractProductGalleryImgTags(html, productGalleryContext)) {
      addImage(extractGalleryImgSrc(imgTag), 1);
    }
  }

  const socialImage = extractMetaContent(html, "og:image") || extractMetaContent(html, "twitter:image");
  if (socialImage) addImage(socialImage, 0);

  // دمج: الأعلى أولوية ثم الأقرب للترتيب، وإزالة التكرار بنفس الملف الأساسي
  const byBase = new Map<string, { url: string; priority: number; order: number; width: number }>();
  for (const item of collected) {
    const base = item.url
      .split("?")[0]
      .replace(/\/media\/catalog\/product\/cache\/[^/]+\//i, "/media/catalog/product/")
      .toLowerCase();
    const widthMatch = item.url.match(/width=(\d+)/i);
    const width = widthMatch ? parseInt(widthMatch[1], 10) : 0;
    const existing = byBase.get(base);
    if (!existing || item.priority > existing.priority || (item.priority === existing.priority && width > existing.width)) {
      byBase.set(base, { ...item, width });
    }
  }
  const merged = [...byBase.values()].sort(
    (a, b) => b.priority - a.priority || a.order - b.order
  );

  const images = merged.slice(0, 3).map((item) => toHighQualityImageUrl(item.url));
  return images;
}

function extractFullProductFromHtml(html: string, pageUrl: string): DeepProduct {
  const isNoon = /noon\.com/i.test(pageUrl);
  const isAmazon = /amazon\./i.test(pageUrl);

  let name = "";
  let nameAr = "";
  let price: number | null = null;
  let description = "";
  let descriptionAr = "";

  if (isNoon || isAmazon) {
    const base = extractFromHtml(html);
    name = base.product_name || "";
    nameAr = containsArabic(name) ? name : "";
    price = base.price ?? null;
    description = base.description_ar || base.description_en || "";
    descriptionAr = containsArabic(description) ? description : "";
  } else {
    const records = collectJsonLdProductRecords(html, pageUrl);
    const primaryRecord = getPrimaryJsonLdProductRecord(records, html, pageUrl);
    const productRecords = primaryRecord ? [primaryRecord] : [];
    const namedRecord = productRecords.find((r) => r.name && r.name.trim());
    if (namedRecord?.name) name = namedRecord.name;
    const arabicRecord = productRecords.find((r) => r.name && containsArabic(r.name));
    if (arabicRecord?.name) nameAr = arabicRecord.name;
    const describedRecord = productRecords.find((r) => r.description && r.description.trim());
    if (describedRecord?.description) description = describedRecord.description;
    const arabicDescriptionRecord = productRecords.find((r) => r.description && containsArabic(r.description));
    if (arabicDescriptionRecord?.description) descriptionAr = arabicDescriptionRecord.description;
    const jsonPrice = productRecords.map((r) => r.price).find((p) => typeof p === "number" && p > 0);
    price = typeof jsonPrice === "number"
      ? jsonPrice
      : extractProductPagePrice(html, productRecords, records.length <= 1 || Boolean(primaryRecord));
  }

  if (!name) {
    const ogTitle = extractMetaContent(html, "og:title");
    name = ogTitle || "";
  }
  if (!nameAr) {
    const arabicTitle = extractMetaContent(html, "og:title") || extractMetaContent(html, "twitter:title");
    if (arabicTitle && containsArabic(arabicTitle)) nameAr = arabicTitle;
  }
  if (!name) {
    const h1 = html.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i);
    if (h1) name = stripTags(h1[1]);
  }
  if (!description) {
    description = extractProductOverviewDescription(html) || extractDescriptionFromHtml(html) || "";
  }
  if (!descriptionAr) {
    const arabicDescription = extractProductOverviewDescription(html) || extractDescriptionFromHtml(html);
    if (arabicDescription && containsArabic(arabicDescription)) descriptionAr = arabicDescription;
  }

  const galleryImages = extractGalleryImages(html, pageUrl).filter((candidate) => !NOISE_IMAGE_URL.test(candidate));
  const socialImage = extractMetaContent(html, "og:image") || extractMetaContent(html, "twitter:image") || "";
  const images = galleryImages.length > 0
    ? galleryImages
    : socialImage && !NOISE_IMAGE_URL.test(socialImage)
      ? [socialImage]
      : [];

  return {
    url: pageUrl,
    product_name: cleanProductName(name),
    product_name_ar: cleanProductName(nameAr),
    price,
    description: cleanDescription(description),
    description_ar: cleanDescription(descriptionAr),
    images,
    image_url: images[0] || "",
  };
}

function getAlternateNoonUrl(url: string): string | null {
  if (!/noon\.com/i.test(url)) return null;
  if (/\/en-[a-z]{2,3}(?=\/|$)/i.test(url)) return url.replace(/\/en-([a-z]{2,3})(?=\/|$)/i, "/ar-$1");
  if (/\/ar-[a-z]{2,3}(?=\/|$)/i.test(url)) return url.replace(/\/ar-([a-z]{2,3})(?=\/|$)/i, "/en-$1");
  return null;
}

function mergeLocalizedProduct(english: DeepProduct, arabic: DeepProduct): DeepProduct {
  return {
    ...english,
    product_name: containsArabic(english.product_name) ? arabic.product_name || english.product_name : english.product_name,
    product_name_ar: containsArabic(english.product_name) ? english.product_name : arabic.product_name_ar || (containsArabic(arabic.product_name) ? arabic.product_name : english.product_name_ar),
    description: containsArabic(english.description) ? arabic.description || english.description : english.description,
    description_ar: containsArabic(english.description) ? english.description : arabic.description_ar || (containsArabic(arabic.description) ? arabic.description : english.description_ar),
  };
}

async function deepScrapeProducts(urls: string[]): Promise<DeepProduct[]> {
  const results: DeepProduct[] = new Array(urls.length);
  let nextIndex = 0;
  let done = 0;

  const scrapeOne = async (index: number): Promise<void> => {
    const targetUrl = urls[index];
    // Shopify: البيانات الكاملة عبر {url}.json (أسرع وأدق من HTML)
    if (isShopifyProductPageUrl(targetUrl) && !/noon\.com|amazon\./i.test(targetUrl)) {
      const fromJson = await tryShopifyProductJson(targetUrl);
      if (fromJson) {
        results[index] = fromJson;
        return;
      }
    }
    let html = "";
    let lastError = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        html = await fetchProductPage(targetUrl, 45000);
        if (html && html.length > 1000) break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempt < 2) await sleepMillis(1200);
    }
    if (!html || html.length <= 1000) {
      results[index] = {
        url: targetUrl,
        product_name: "",
        price: null,
        description: "",
        images: [],
        image_url: "",
        error: lastError || "تعذّر فتح صفحة المنتج",
      };
      return;
    }
    try {
      let product = extractFullProductFromHtml(html, targetUrl);
      const alternateUrl = getAlternateNoonUrl(targetUrl);
      if (alternateUrl) {
        try {
          const alternateHtml = await fetchProductPage(alternateUrl, 45000);
          if (alternateHtml && alternateHtml.length > 1000) {
            product = mergeLocalizedProduct(product, extractFullProductFromHtml(alternateHtml, alternateUrl));
          }
        } catch {
          // Keep the original locale when the Arabic version is unavailable.
        }
      }
      if (!product.product_name && product.images.length === 0) {
        product.error = "لم يتم العثور على بيانات المنتج في الصفحة";
      }
      results[index] = product;
    } catch (err) {
      results[index] = {
        url: targetUrl,
        product_name: "",
        price: null,
        description: "",
        images: [],
        image_url: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const worker = async (): Promise<void> => {
    while (nextIndex < urls.length) {
      const index = nextIndex++;
      await scrapeOne(index);
      done++;
      if (done % 5 === 0) {
        // إتاحة نفس للخادم بين المنتجات
        await sleepMillis(120);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(6, Math.max(1, urls.length)) }, () => worker())
  );
  return results;
}

function getAlternateLocaleProductUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const locale = parsed.pathname.match(/^\/(egypt-(?:ar|en)|(?:ar|en)(?:-[a-z]{2,3})?)(?=\/|$)/i);
    if (!locale) return null;
    const current = locale[1].toLowerCase();
    const alternate = current === "egypt-en"
      ? "egypt-ar"
      : current === "egypt-ar"
        ? "egypt-en"
        : `${current.startsWith("ar") ? "en" : "ar"}${current.slice(2)}`;
    parsed.pathname = parsed.pathname.replace(locale[0], `/${alternate}`);
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function normalizeLocalizedProductUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    const path = parsed.pathname
      .replace(/^\/(?:egypt-(?:ar|en)|(?:ar|en)(?:-[a-z]{2,3})?)(?=\/|$)/i, "/locale")
      .replace(/\/+$/, "")
      .toLowerCase();
    return `${parsed.origin.toLowerCase()}${path}`;
  } catch {
    return "";
  }
}

function getNoonProductId(url: string): string {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)noon\.com$/i.test(parsed.hostname)) return "";
    const segments = parsed.pathname.split("/").filter(Boolean);
    const productMarker = segments.findIndex((segment) => /^p$/i.test(segment));
    return productMarker > 0 ? segments[productMarker - 1].toUpperCase() : "";
  } catch {
    return "";
  }
}

function isMatchingLocalizedProductPage(html: string, expectedUrl: string): boolean {
  const canonicalMatch =
    html.match(/<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']+)["'][^>]*>/i) ||
    html.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']canonical["'][^>]*>/i);
  const canonicalUrl = canonicalMatch ? safeResolve(canonicalMatch[1], expectedUrl) : null;
  if (!canonicalUrl) return false;
  const expectedNoonId = getNoonProductId(expectedUrl);
  if (expectedNoonId) return getNoonProductId(canonicalUrl) === expectedNoonId;
  return normalizeLocalizedProductUrl(canonicalUrl) === normalizeLocalizedProductUrl(expectedUrl);
}

function extractOriginalProductText(html: string, pageUrl: string): { name: string; description: string } {
  const extracted = extractFromHtml(html);
  const record = getPrimaryJsonLdProductRecord(collectJsonLdProductRecords(html, pageUrl), html, pageUrl);
  return {
    name: record?.name || extracted.product_name || "",
    description: record?.description || extracted.description_ar || extracted.description_en || "",
  };
}

export function localApiPlugin(): Plugin {
  return {
    name: "local-api-plugin",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || "";

        if (url === "/api/noon-scraper" && req.method === "POST") {
          try {
            let body = "";
            for await (const chunk of req) {
              body += chunk;
            }
            const { url: targetUrl, openaiApiKey, sourceProductName, sourcePrice, fastMode = false } = JSON.parse(body);

            if (!targetUrl) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "URL is required" }));
              return;
            }

            let html = "";
            if (!isDirectImageUrl(targetUrl)) {
              html = fastMode
                ? await fetchProductPage(targetUrl, 15000, 1)
                : await fetchProductPage(targetUrl, 120000);
            }

            let extracted = extractFromHtml(html);
            const sourceText = extractOriginalProductText(html, targetUrl);
            if (sourceText.name) extracted.product_name = sourceText.name;
            if (sourceText.description) {
              extracted.description_ar = containsArabic(sourceText.description) ? sourceText.description : "";
              extracted.description_en = containsArabic(sourceText.description) ? "" : sourceText.description;
            }
            if (isDirectImageUrl(targetUrl)) {
              extracted.image_url = targetUrl;
              extracted.image_url_high = targetUrl;
            }
            if (!extracted.product_name && sourceProductName) extracted.product_name = sourceProductName;
            if (typeof sourcePrice === "number" && sourcePrice > 0) extracted.price = sourcePrice;

            let productNameAr = containsArabic(extracted.product_name || "") ? extracted.product_name || "" : "";
            let productNameEn = productNameAr ? "" : extracted.product_name || "";
            let descriptionAr = extracted.description_ar || "";
            let descriptionEn = extracted.description_en || "";
            const alternateUrl = /(^|\.)noon\.com$/i.test(new URL(targetUrl).hostname)
              ? getAlternateLocaleProductUrl(targetUrl)
              : null;
            if (!fastMode && alternateUrl && (!productNameAr || !productNameEn || !descriptionAr || !descriptionEn)) {
              try {
                const alternateHtml = await fetchProductPage(alternateUrl, 25000);
                if (alternateHtml && isMatchingLocalizedProductPage(alternateHtml, alternateUrl)) {
                  const alternateText = extractOriginalProductText(alternateHtml, alternateUrl);
                  if (alternateText.name) {
                    if (containsArabic(alternateText.name)) productNameAr = alternateText.name;
                    else productNameEn = alternateText.name;
                  }
                  if (alternateText.description) {
                    if (containsArabic(alternateText.description)) descriptionAr = alternateText.description;
                    else descriptionEn = alternateText.description;
                  }
                }
              } catch {
                // Keep only text extracted from the original page when the other locale is unavailable.
              }
            }
            if (/amazon\./i.test(targetUrl)) {
              const fallback = extractAmazonFallback(targetUrl);
              if (fallback) {
                extracted.product_name = extracted.product_name || fallback.product_name;
                // لا تستبدل صورة حقيقية استخرجناها من HTML برابط ASIN البديل (الذي غالباً ما يكون صورة بديلة معطوبة)
                if (!extracted.image_url) {
                  extracted.image_url = fallback.image_url;
                  extracted.image_url_high = fallback.image_url;
                }
              }
            }

            if (!fastMode && (!extracted.product_name || !extracted.image_url || !extracted.price) && openaiApiKey) {
              try {
                const aiResult = await extractWithOpenAI(html, openaiApiKey);
                extracted = {
                  product_name: extracted.product_name || "",
                  price: extracted.price || aiResult.price || null,
                  image_url: extracted.image_url || aiResult.image_url,
                  image_url_high: extracted.image_url_high || aiResult.image_url_high,
                  description_ar: extracted.description_ar || "",
                  description_en: extracted.description_en || "",
                };
              } catch (aiErr) {
                const errMsg = aiErr instanceof Error ? aiErr.message : String(aiErr);
                if (errMsg.includes("401") || errMsg.includes("invalid_api_key")) {
                  throw new Error("مفتاح OpenAI API غير صالح. يرجى التحقق من المفتاح وإدخاله مرة أخرى.");
                }
                if (!extracted.product_name && !extracted.image_url) {
                  throw new Error(`OpenAI extraction failed: ${errMsg}`);
                }
              }
            }

            if (!extracted.product_name && !extracted.image_url) {
              throw new Error("Could not extract product name or image from the page");
            }

            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                success: true,
                product_name: extracted.product_name || "",
                product_name_ar: productNameAr,
                product_name_en: productNameEn,
                price: extracted.price || null,
                image_url: extracted.image_url || "",
                image_url_high: extracted.image_url_high || extracted.image_url || "",
                description_ar: descriptionAr,
                description_en: descriptionEn,
              })
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        if (url === "/api/egypt-image-search" && req.method === "POST") {
          try {
            let body = "";
            for await (const chunk of req) body += chunk;
            const payload = JSON.parse(body) as { rows?: Array<{ index: number; productName: string; sku?: string }>; openaiApiKey?: string };
            const rows = (payload.rows || []).filter((row) => row && typeof row.productName === "string").slice(0, 200);
            if (rows.length === 0) throw new Error("لا توجد أسماء منتجات صالحة");
            const results = [];
            for (const row of rows) {
              try {
                results.push(await searchEgyptProduct(row, String(payload.openaiApiKey || "")));
              } catch (err) {
                results.push({
                  index: row.index,
                  productName: row.productName,
                  sku: row.sku || "",
                  title: "",
                  productUrl: "",
                  imageUrl: "",
                  source: "",
                  score: 0,
                  status: "not_found",
                  reason: err instanceof Error ? `تعذر البحث: ${err.message}` : "تعذر البحث عن المنتج",
                });
              }
            }
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: true, results }));
          } catch (err) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }

        if (url === "/api/barcode-lookup" && req.method === "POST") {
          try {
            let body = "";
            for await (const chunk of req) body += chunk;
            const payload = JSON.parse(body) as { rows?: Array<{ index: number; sourceName: string; englishName: string; barcode: string; price: number | null; sku: string }> };
            const rows = (payload.rows || []).filter((row) => row && typeof row.barcode === "string").slice(0, MAX_BARCODE_LOOKUP_ROWS);
            if (!rows.length) throw new Error("لا توجد باركودات صالحة للبحث");
            const results = await mapWithConcurrency(rows, 4, async (row) => {
              try {
                return await searchBarcodeProduct(row);
              } catch {
                return {
                  ...row,
                  productName: "",
                  description: "",
                  imageUrl: "",
                  productUrl: "",
                  source: "",
                  matchScore: 0,
                  barcodeVerified: false,
                  candidates: [],
                  status: "not_found",
                };
              }
            });
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: true, results }));
          } catch (err) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
          return;
        }

        if (url.startsWith("/api/image-proxy") && (req.method === "POST" || req.method === "GET")) {
          try {
            let imageUrl = "";
            if (req.method === "POST") {
              let body = "";
              for await (const chunk of req) {
                body += chunk;
              }
              ({ imageUrl } = JSON.parse(body));
            } else {
              const parsedUrl = new URL(req.url || "", "http://localhost");
              imageUrl = parsedUrl.searchParams.get("url") || "";
            }

            if (!imageUrl) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "imageUrl is required" }));
              return;
            }

            const imageResponse = await fetch(imageUrl, {
              headers: getImageFetchHeaders(imageUrl),
            });

            const contentType = imageResponse.headers.get("content-type") || "";
            const blob = await imageResponse.arrayBuffer();
            if (!imageResponse.ok || blob.byteLength < 1024 || !contentType.startsWith("image/")) {
              throw new Error(`Failed to fetch image (${imageResponse.status})`);
            }

            res.statusCode = 200;
            res.setHeader("Content-Type", contentType);
            res.end(Buffer.from(blob));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        if (url === "/api/extract-site" && req.method === "POST") {
          try {
            let body = "";
            for await (const chunk of req) {
              body += chunk;
            }
            const { url: siteUrl, maxPages, maxProducts } = JSON.parse(body);

            if (!siteUrl || typeof siteUrl !== "string") {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "الرابط مطلوب" }));
              return;
            }

            let normalizedUrl = siteUrl.trim();
            if (!/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = `https://${normalizedUrl}`;

            let parsedUrl: URL;
            try {
              parsedUrl = new URL(normalizedUrl);
            } catch {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "الرابط غير صالح، تأكد من صحته" }));
              return;
            }
            const proto = typeof parsedUrl.protocol === "string" ? parsedUrl.protocol : "";
            if (!/^https?:$/i.test(proto)) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "يجب أن يبدأ الرابط بـ http:// أو https://" }));
              return;
            }

            const pages = Math.min(Math.max(parseInt(String(maxPages || ""), 10) || 500, 1), 500);
            const productsLimit = Math.min(Math.max(parseInt(String(maxProducts || ""), 10) || 50000, 1), 50000);

            const result = await extractSiteProducts(normalizedUrl, pages, productsLimit);

            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                success: true,
                total: result.products.length,
                pagesFetched: result.pagesFetched,
                stoppedReason: result.stoppedReason,
                products: result.products,
              } as {
                success: boolean;
                total: number;
                pagesFetched: number;
                stoppedReason: string;
                products: SiteProduct[];
              })
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        if (url === "/api/scrape-batch" && req.method === "POST") {
          try {
            let body = "";
            for await (const chunk of req) {
              body += chunk;
            }
            const { urls } = JSON.parse(body) as { urls?: unknown };

            if (!Array.isArray(urls) || urls.length === 0) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "قائمة الروابط مطلوبة" }));
              return;
            }

            const validUrls = urls
              .filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u.trim()))
              .slice(0, 40)
              .map((u) => u.trim());

            if (validUrls.length === 0) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "لا توجد روابط صالحة" }));
              return;
            }

            const results = await deepScrapeProducts(validUrls);

            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ success: true, results }));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: message }));
          }
          return;
        }

        next();
      });
    },
  };
}