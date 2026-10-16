import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface ScrapeRequest {
  url: string;
  openaiApiKey: string;
  sourceProductName?: string;
  sourcePrice?: number | null;
  recordId?: string;
}

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
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

function extractDescriptionFromHtml(html: string): string | null {
  // Try og:description
  const ogDesc = extractMetaContent(html, "og:description");
  if (ogDesc && ogDesc.length > 20) return ogDesc;

  // Try twitter:description
  const twitterDesc = extractMetaContent(html, "twitter:description");
  if (twitterDesc && twitterDesc.length > 20) return twitterDesc;

  // Try meta description
  const metaDesc = extractMetaContent(html, "description");
  if (metaDesc && metaDesc.length > 20) return metaDesc;

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

function extractAmazonTitle(html: string): string | null {
  const titleMatch = html.match(/<span[^>]*id=["']productTitle["'][^>]*>([\s\S]*?)<\/span>/i);
  if (titleMatch && titleMatch[1]) {
    return titleMatch[1].replace(/\s+/g, " ").trim();
  }
  const h1Match = html.match(/<h1[^>]*id=["']title["'][^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match && h1Match[1]) {
    return h1Match[1].replace(/\s+/g, " ").trim();
  }
  return null;
}

function extractAmazonPrice(html: string): number | null {
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
  const descMatch = html.match(/<div[^>]*id=["']productDescription["'][^>]*>([\s\S]*?)<\/div>/i);
  if (descMatch && descMatch[1]) {
    const text = descMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length > 20) return text;
  }

  const bulletsMatch = html.match(/<div[^>]*id=["']feature-bullets["'][^>]*>([\s\S]*?)<\/div>/i);
  if (bulletsMatch && bulletsMatch[1]) {
    const text = bulletsMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length > 20) return text;
  }

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

function extractFromHtml(html: string): Partial<ProductData> {
  const result: Partial<ProductData> = {};

  // Detect if this is an Amazon page
  const isAmazon = /amazon\./i.test(html) || /amazon\./i.test(html.substring(0, 5000));

  if (isAmazon) {
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
    if (amazonDesc) {
      result.description_ar = amazonDesc;
      result.description_en = amazonDesc;
    }
  }

  // Product name from og:title or twitter:title
  const ogTitle = extractMetaContent(html, "og:title");
  const twitterTitle = extractMetaContent(html, "twitter:title");
  if (!result.product_name) {
    if (ogTitle) result.product_name = ogTitle.replace(/\s*[-|]\s*noon.*/i, "").trim();
    else if (twitterTitle) result.product_name = twitterTitle.replace(/\s*[-|]\s*noon.*/i, "").trim();
  }

  // Product image from og:image or twitter:image
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

  // Try to find high-res image in JSON-LD or script data
  const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch && jsonLdMatch[1]) {
    try {
      const json = JSON.parse(jsonLdMatch[1].trim());
      if (json.name && !result.product_name) result.product_name = json.name;
      if (json.image) {
        const img = Array.isArray(json.image) ? json.image[0] : json.image;
        if (typeof img === "string") {
          result.image_url_high = img;
          if (!result.image_url) result.image_url = img;
        }
      }
    } catch {
      // ignore JSON parse errors
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

  // Upgrade to high-res: replace size markers in URL
  if (result.image_url_high) {
    result.image_url_high = result.image_url_high
      .replace(/\._AC_(?:SY|SX|UY|UX)\d+_/i, "._AC_SL1500_")
      .replace(/\._AC_UL\d+_/i, "._AC_UL1500_")
      .replace(/\._SL\d+_/i, "._SL1500_")
      .replace(/\/\d+x\d+\//, "/1500x1500/")
      .replace(/\?\w+=\d+/, "")
      .replace(/_\d+w/i, "_2000w");
  }

  // Extract description from HTML
  const description = extractDescriptionFromHtml(html);
  if (description) {
    result.description_ar = description;
    result.description_en = description;
  }

  return result;
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
async function fetchProductPage(url: string): Promise<string> {
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
  for (const headers of headerOptions) {
    try {
      const pageResponse = await fetch(url, { headers, redirect: "follow" });
      if (!pageResponse.ok) continue;
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
    } catch {
      // جرّب خيار الرؤوس التالي
    }
  }
  return fallbackHtml;
}

const OPENAI_TIMEOUT_MS = 20000;

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

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned no content");

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("OpenAI response did not contain JSON");

    const parsed = JSON.parse(jsonMatch[0]);
    const result: Partial<ProductData> = {};
    if (parsed.product_name) result.product_name = parsed.product_name;
    const parsedPrice =
      typeof parsed.price === "number"
        ? parsed.price
        : Number.parseFloat(String(parsed.price || "").replace(/[^\d.]/g, ""));
    if (Number.isFinite(parsedPrice) && parsedPrice > 0) result.price = parsedPrice;
    if (parsed.image_url) {
      result.image_url = parsed.image_url;
      result.image_url_high = parsed.image_url
        .replace(/\._AC_(?:SY|SX|UY|UX)\d+_/i, "._AC_SL1500_")
        .replace(/\/\d+x\d+\//, "/1500x1500/")
        .replace(/_\d+w/i, "_2000w");
    }
    if (parsed.description) {
      result.description_ar = parsed.description;
      result.description_en = parsed.description;
    }
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
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
              "You are a professional e-commerce product description writer. Write a short, specific, and realistic product description in Arabic and English. Use only the actual product name and type. For water heaters, boilers, geysers, or shower heaters, describe heating performance, reliability, and installation suitability, not portability. Do not mention carrying or easy-to-carry claims unless the item is clearly portable. Respond ONLY with JSON in this exact format: {\"description_ar\": \"...\", \"description_en\": \"...\"}. Keep it brief and marketplace-ready.",
          },
          {
            role: "user",
            content: `Write professional product descriptions for this product.\n\nProduct name: ${productName}\n\nExisting description (if any, use it as reference): ${existingDescription || "none"}\n\nWrite a short, accurate description in Arabic and English based only on the product name and type.`,
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

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned no content");

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("OpenAI response did not contain JSON");

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      description_ar: parsed.description_ar || "",
      description_en: parsed.description_en || "",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const { url, openaiApiKey, sourceProductName, sourcePrice, recordId } = (await req.json()) as ScrapeRequest;

    if (!url) {
      return new Response(JSON.stringify({ error: "URL is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!openaiApiKey) {
      return new Response(JSON.stringify({ error: "OpenAI API key is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch the product page unless the input is already an image URL.
    // fetchProductPage يعيد المحاولة برأس مختلف إن بدت الصفحة كصفحة حظر من أمازون.
    let html = "";
    if (!isDirectImageUrl(url)) {
      html = await fetchProductPage(url);
    }

    // First try HTML meta extraction
    let extracted = extractFromHtml(html);
    if (isDirectImageUrl(url)) {
      extracted.image_url = url;
      extracted.image_url_high = url;
    }
    if (sourceProductName) extracted.product_name = sourceProductName;
    if (typeof sourcePrice === "number" && sourcePrice > 0) extracted.price = sourcePrice;
    if (/amazon\./i.test(url)) {
      const fallback = extractAmazonFallback(url);
      if (fallback) {
        extracted.product_name = extracted.product_name || fallback.product_name;
        // لا تستبدل صورة حقيقية استخرجناها من HTML برابط ASIN البديل (الذي غالباً ما يكون صورة بديلة معطوبة)
        if (!extracted.image_url) {
          extracted.image_url = fallback.image_url;
          extracted.image_url_high = fallback.image_url;
        }
      }
    }

    // If we don't have both name and image, use OpenAI
    if (!extracted.product_name || !extracted.image_url || !extracted.price) {
      try {
        const aiResult = await extractWithOpenAI(html, openaiApiKey);
        extracted = {
          product_name: extracted.product_name || aiResult.product_name,
          price: extracted.price || aiResult.price || null,
          image_url: extracted.image_url || aiResult.image_url,
          image_url_high: extracted.image_url_high || aiResult.image_url_high,
          description_ar: extracted.description_ar || aiResult.description_ar,
          description_en: extracted.description_en || aiResult.description_en,
        };
      } catch (aiErr) {
        const errMsg = aiErr instanceof Error ? aiErr.message : String(aiErr);
        if (errMsg.includes("401") || errMsg.includes("invalid_api_key")) {
          throw new Error("مفتاح OpenAI API غير صالح. يرجى التحقق من المفتاح وإدخاله مرة أخرى.");
        }
        // If HTML extraction got something, use it; otherwise fail
        if (!extracted.product_name && !extracted.image_url) {
          throw new Error(`OpenAI extraction failed: ${errMsg}`);
        }
      }
    }

    if (!extracted.product_name && !extracted.image_url) {
      throw new Error("Could not extract product name or image from the page");
    }

    // Generate professional descriptions (Arabic + English) if we have a product name
    let description_ar = extracted.description_ar || "";
    let description_en = extracted.description_en || "";

    if (extracted.product_name) {
      try {
        const generated = await generateDescriptions(
          extracted.product_name,
          extracted.description_ar || extracted.description_en || null,
          openaiApiKey
        );
        description_ar = generated.description_ar || description_ar;
        description_en = generated.description_en || description_en;
      } catch (descErr) {
        const descErrMsg = descErr instanceof Error ? descErr.message : String(descErr);
        if (descErrMsg.includes("401") || descErrMsg.includes("invalid_api_key")) {
          throw new Error("مفتاح OpenAI API غير صالح. يرجى التحقق من المفتاح وإدخاله مرة أخرى.");
        }
        // If description generation fails, keep whatever we extracted from HTML
        console.error("Description generation failed:", descErr);
      }
    }

    // Update the database record if recordId was provided
    if (recordId) {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      await supabase
        .from("scrape_results")
        .update({
          product_name: extracted.product_name || null,
          image_url: extracted.image_url || null,
          description_ar: description_ar || null,
          description_en: description_en || null,
          status: "completed",
          error: null,
        })
        .eq("id", recordId);
    }

    return new Response(
      JSON.stringify({
        success: true,
        product_name: extracted.product_name || "",
        price: extracted.price || null,
        image_url: extracted.image_url || "",
        image_url_high: extracted.image_url_high || extracted.image_url || "",
        description_ar: description_ar || "",
        description_en: description_en || "",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
