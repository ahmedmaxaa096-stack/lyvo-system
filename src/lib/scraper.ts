import { EDGE_FUNCTIONS, HEADERS } from "./supabase";

export interface ScrapedProduct {
  url: string;
  product_name: string;
  product_name_ar?: string;
  product_name_en?: string;
  price: number | null;
  image_url: string;
  image_url_high: string;
  images: string[];
  description_ar: string;
  description_en: string;
  sku: string;
}

export async function generateProductNames(
  sourceProductName: string,
  openaiApiKey: string
): Promise<{ product_name_ar: string; product_name_en: string }> {
  const name = (sourceProductName || "").trim();
  if (!name) {
    return { product_name_ar: "", product_name_en: "" };
  }

  const containsArabic = /[\u0600-\u06FF]/.test(name);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a professional e-commerce naming specialist. Return ONLY valid JSON with exactly these keys: product_name_ar, product_name_en. Create a high-converting product title in Arabic and English, marketing-style, concise and natural, matching the product concept. Avoid emojis. If the input is already Arabic, generate the English product title; if the input is already English, generate the Arabic one.",
          },
          {
            role: "user",
            content: `Product reference name: ${name}`,
          },
        ],
        temperature: 0.6,
        max_tokens: 300,
      }),
    });

    if (!response.ok) throw new Error(`OpenAI error (${response.status})`);

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned no content");

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    const productNameAr = String(parsed.product_name_ar || "").trim();
    const productNameEn = String(parsed.product_name_en || "").trim();

    return {
      product_name_ar: productNameAr || (containsArabic ? name : ""),
      product_name_en: productNameEn || (containsArabic ? "" : name),
    };
  } catch {
    return {
      product_name_ar: containsArabic ? name : "",
      product_name_en: containsArabic ? "" : name,
    };
  }
}

export async function translateProductContent(
  productName: string,
  description: string,
  openaiApiKey: string
): Promise<{ product_name_ar: string; description_ar: string }> {
  if (!openaiApiKey || (!productName && !description)) {
    return { product_name_ar: "", description_ar: "" };
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Translate the provided e-commerce product name and description into natural Modern Standard Arabic. Preserve the exact meaning, brand names, model numbers, measurements, and technical specifications. Do not add marketing claims. Return only valid JSON with exactly: product_name_ar, description_ar.",
          },
          {
            role: "user",
            content: `Product name: ${productName || ""}\nDescription: ${description || ""}`,
          },
        ],
        temperature: 0.2,
        max_tokens: 700,
      }),
    });
    if (!response.ok) return { product_name_ar: "", description_ar: "" };
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { product_name_ar: "", description_ar: "" };
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      product_name_ar: String(parsed.product_name_ar || "").trim(),
      description_ar: String(parsed.description_ar || "").trim(),
    };
  } catch {
    return { product_name_ar: "", description_ar: "" };
  }
}

function buildFallbackMarketingDescriptions(
  productNameAr: string,
  productNameEn: string
): { description_ar: string; description_en: string } {
  const ar = (productNameAr || "").trim();
  const en = (productNameEn || "").trim();
  const combined = `${ar || ""} ${en || ""}`.trim();
  const source = (combined || "Product").toLowerCase();
  const baseAr = ar || en || "منتج";
  const baseEn = en || ar || "Product";

  const productText = source.replace(/[^a-z\u0600-\u06FF\s]/g, " ");
  const tokens = productText.split(/\s+/).filter(Boolean);

  const inferPattern = [
    {
      match: /(water heater|geyser|boiler|tankless water heater|instant water heater|bathroom heater|heater|shower heater)/i,
      summaryAr: "مصمم لتسخين الماء بسرعة وفعالية",
      summaryEn: "built for quick and efficient water heating",
      featureAr: "قدرة تسخين موثوقة وتصميم متين",
      featureEn: "reliable heating capacity and a durable build",
      benefitAr: "يوفر ماءً ساخنًا سريعًا مع ثبات الأداء وسهولة التشغيل",
      benefitEn: "delivers fast hot water with reliable performance and easy operation",
    },
    {
      match: /(portable|travel|carry|go|compact|fold|mini|outdoor)/i,
      summaryAr: "مصمم لسهولة النقل والاستخدام أثناء التنقل",
      summaryEn: "portable and convenient for on-the-go use",
      featureAr: "تصميم خفيف وسهل الحمل",
      featureEn: "a lightweight and easy-to-carry build",
      benefitAr: "يسهل نقله واستخدامه في الحركة اليومية",
      benefitEn: "makes it easy to move and use throughout the day",
    },
    {
      match: /(blender|mixer|juicer|smoothie|processor|grinder)/i,
      summaryAr: "مصمم لخلط وتجهيز المكونات بسرعة",
      summaryEn: "built for fast and efficient mixing or blending",
      featureAr: "أداء قوي ومكونات عملية",
      featureEn: "strong performance and practical components",
      benefitAr: "يوفر تحضير الطعام أو المشروبات بسهولة وفعالية",
      benefitEn: "helps prepare food and drinks quickly and efficiently",
    },
    {
      match: /(fan|ventilator|blower|cooler|air)/i,
      summaryAr: "مصمم لتوفير هواء مريح وفعال",
      summaryEn: "designed to deliver smooth and effective airflow",
      featureAr: "تدفق هواء قوي وتصميم عملي",
      featureEn: "powerful airflow and a practical design",
      benefitAr: "يمنح الراحة في المنزل أو المكتب خلال اليوم",
      benefitEn: "provides comfort at home or in the office throughout the day",
    },
    {
      match: /(bottle|water|flask|jug|cup)/i,
      summaryAr: "مصمم للحفاظ على السوائل مع راحة الحمل",
      summaryEn: "designed for easy hydration and convenience",
      featureAr: "غطاء محكم وتصميم عملي",
      featureEn: "a secure lid and practical, portable design",
      benefitAr: "يساعدك على حمل الماء بسهولة طوال اليوم",
      benefitEn: "helps you carry water comfortably wherever you go",
    },
    {
      match: /(dryer|hair|dry)/i,
      summaryAr: "مصمم لتجفيف سريع وراحة في الاستخدام",
      summaryEn: "made for fast drying and everyday comfort",
      featureAr: "تدفق هواء قوي وبناء خفيف",
      featureEn: "strong airflow and a lightweight build",
      benefitAr: "يُسرّع الروتين اليومي ويحسن التجربة اليومية",
      benefitEn: "speeds up daily routines and improves comfort",
    },
    {
      match: /(fryer|oven|kettle|heater|cook|grill)/i,
      summaryAr: "مصمم لطهي أو تسخين سريع وفعال",
      summaryEn: "designed for fast and efficient cooking or heating",
      featureAr: "تحكم عملي وأداء موثوق",
      featureEn: "practical controls and dependable performance",
      benefitAr: "يُسهّل تحضير الطعام أو التسخين في المنزل",
      benefitEn: "makes home cooking and heating more convenient and efficient",
    },
    {
      match: /(vacuum|cleaner|scrubber|wash|mop)/i,
      summaryAr: "مصمم لتسهيل التنظيف اليومي",
      summaryEn: "made to simplify everyday cleaning",
      featureAr: "قوة فعالة وتصميم عملي",
      featureEn: "strong cleaning power and a practical design",
      benefitAr: "يقلل الوقت والجهد في المنزل",
      benefitEn: "reduces time and effort during daily cleaning",
    },
    {
      match: /(lamp|light|bulb|led|lighting)/i,
      summaryAr: "مصمم لتوفير إضاءة واضحة وموثوقة",
      summaryEn: "made to provide clear and reliable lighting",
      featureAr: "إضاءة متوازنة وتصميم أنيق",
      featureEn: "balanced illumination and a modern look",
      benefitAr: "يحسن الراحة ويُضفي جوًا مناسبًا في المساحات المختلفة",
      benefitEn: "improves comfort and creates a better atmosphere in everyday spaces",
    },
  ];

  const matched = inferPattern.find((item) => item.match.test(source)) || {
    match: /./i,
    summaryAr: "مصمم لتلبية احتياجات الاستخدام اليومي",
    summaryEn: "built to meet everyday needs",
    featureAr: "تصميم عملي",
    featureEn: "a practical build",
    benefitAr: "يوفر راحة وسهولة في الاستخدام",
    benefitEn: "offers comfort and ease of use",
  };

  return {
    description_ar: `منتج ${baseAr} ${matched.summaryAr}. ${matched.benefitAr}.`,
    description_en: `${baseEn} ${matched.summaryEn}. ${matched.benefitEn}.`,
  };
}

export async function generateMarketingDescriptions(
  productNameAr: string,
  productNameEn: string,
  openaiApiKey: string
): Promise<{ description_ar: string; description_en: string }> {
  const ar = productNameAr?.trim() || "";
  const en = productNameEn?.trim() || "";
  if (!openaiApiKey || (!ar && !en)) {
    return buildFallbackMarketingDescriptions(ar, en);
  }

  try {
    const sourceText = `${en || ar || ""} ${ar || en || ""}`.trim();
    const source = sourceText.toLowerCase().replace(/[^a-z\u0600-\u06FF\s]/g, " ");
    const tokens = source.split(/\s+/).filter(Boolean).slice(0, 8);
    const productType = tokens.includes("fan") || tokens.includes("blower") ? "fan"
      : tokens.includes("blender") || tokens.includes("mixer") || tokens.includes("juicer") ? "blender"
      : tokens.includes("bottle") || tokens.includes("water") || tokens.includes("flask") ? "bottle"
      : tokens.includes("dryer") || tokens.includes("hair") ? "dryer"
      : tokens.includes("fryer") || tokens.includes("oven") ? "fryer"
      : tokens.includes("vacuum") || tokens.includes("cleaner") ? "vacuum"
      : tokens.includes("lamp") || tokens.includes("light") ? "lamp"
      : tokens.includes("kettle") || tokens.includes("heater") ? "kettle"
      : "general";

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
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
            content: `Product name: ${en || ar || "N/A"}\nKeywords: ${tokens.join(", ") || "general product"}\nProduct type: ${productType}\n\nCreate a short and accurate product description in Arabic and English based only on these inputs.`,
          },
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!response.ok) throw new Error(`OpenAI error (${response.status})`);

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned no content");

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    return {
      description_ar: String(parsed.description_ar || "").trim() || buildFallbackMarketingDescriptions(ar, en).description_ar,
      description_en: String(parsed.description_en || "").trim() || buildFallbackMarketingDescriptions(ar, en).description_en,
    };
  } catch {
    return buildFallbackMarketingDescriptions(ar, en);
  }
}

export async function scrapeProduct(
  url: string,
  openaiApiKey: string,
  sourceProductName = "",
  sourcePrice: number | null = null,
  fastMode = false
): Promise<ScrapedProduct> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 minute timeout
  try {
    const response = await fetch(EDGE_FUNCTIONS.scraper, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ url, openaiApiKey, sourceProductName, sourcePrice, fastMode }),
      signal: controller.signal,
    });

    let data;
    try {
      data = await response.json();
    } catch {
      const text = await response.text();
      throw new Error(`استجابة غير صحيحة من الخادم: ${text.substring(0, 100)}`);
    }

    if (!response.ok) {
      throw new Error(data.error || `فشل في جلب البيانات (${response.status})`);
    }

    const images = Array.isArray(data.images)
      ? data.images.filter((item: unknown): item is string => typeof item === "string" && !!item.trim())
      : [];
    const fallbackImages = [data.image_url || data.image_url_high || ""].filter(Boolean);
    const productName = typeof data.product_name === "string" ? data.product_name : "";
    const productNameIsArabic = /[\u0600-\u06FF]/.test(productName);

    return {
      url,
      product_name: productName,
      product_name_ar: data.product_name_ar || (productNameIsArabic ? productName : ""),
      product_name_en: data.product_name_en || (!productNameIsArabic ? productName : ""),
      price: data.price || null,
      image_url: data.image_url || "",
      image_url_high: data.image_url_high || data.image_url || "",
      images: images.length > 0 ? images : fallbackImages,
      description_ar: data.description_ar || "",
      description_en: data.description_en || "",
      sku: "",
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("انتهت مهلة استخراج البيانات بعد 3 دقائق. تحقق من رابط المنتج أو جرّب مرة أخرى.");
    }
    throw new Error(`خطأ في استخراج البيانات: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchDirectImageBlob(url: string): Promise<Blob | null> {
  try {
    if (new URL(url, window.location.href).origin !== window.location.origin) return null;
  } catch {
    return null;
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      cache: "force-cache",
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });

    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      const clone = response.clone();
      const blob = await clone.blob();
      if (blob.type.startsWith("image/")) return blob;
      return null;
    }

    return await response.blob();
  } catch {
    return null;
  }
}

export async function fetchImageAsBase64(imageUrl: string, sourceUrl?: string): Promise<string> {
  const candidates = getImageCandidates(imageUrl, sourceUrl);
  let lastError = "فشل في جلب الصورة";

  for (const candidate of candidates) {
    const directBlob = await fetchDirectImageBlob(candidate);
    if (directBlob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(directBlob);
      });
    }

    const response = await fetch(EDGE_FUNCTIONS.imageProxy, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ imageUrl: candidate }),
    });

    if (response.ok) {
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    const data = await response.json().catch(() => ({}));
    lastError = data.error || `فشل في جلب الصورة (${response.status})`;
  }

  throw new Error(lastError);
}

export async function fetchImageAsBlob(imageUrl: string, sourceUrl?: string): Promise<Blob> {
  const candidates = getImageCandidates(imageUrl, sourceUrl);
  let lastError = "فشل في جلب الصورة";

  for (const candidate of candidates) {
    const directBlob = await fetchDirectImageBlob(candidate);
    if (directBlob) return directBlob;

    const response = await fetch(EDGE_FUNCTIONS.imageProxy, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ imageUrl: candidate }),
    });

    if (response.ok) return response.blob();

    const data = await response.json().catch(() => ({}));
    lastError = data.error || `فشل في جلب الصورة (${response.status})`;
  }

  throw new Error(lastError);
}

function getImageCandidates(imageUrl: string, sourceUrl?: string): string[] {
  const candidates = [imageUrl];

  // اشتقاق نسخ إضافية من رابط الصورة الفعلي على CDN أمازون (مثل I/<hash>) بدون الاعتماد على ASIN
  const mediaMatch = imageUrl.match(/^(https:\/\/m\.media-amazon\.com\/images\/I\/[^/]+?)(?:\._|$)/i);
  if (mediaMatch) {
    const base = mediaMatch[1];
    for (const variant of [`${base}._AC_SL1500_.jpg`, `${base}.jpg`, `${base}._SL1500_.jpg`]) {
      if (!candidates.includes(variant)) candidates.push(variant);
    }
  }

  const asinMatch = imageUrl.match(/\/images\/P\/([A-Z0-9]{10})\./i)
    || sourceUrl?.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|[?&]asin=)([A-Z0-9]{10})(?:[/?&#]|$)/i)
    || sourceUrl?.match(/(?:^|[/?=&])([A-Z0-9]{10})(?:[/?&#]|$)/i);
  if (!asinMatch) return candidates;

  const asin = asinMatch[1].toUpperCase();
  for (const host of [
    "https://m.media-amazon.com/images/P/",
    "https://images-na.ssl-images-amazon.com/images/P/",
    "https://images.amazon.com/images/P/",
  ]) {
    const candidate = `${host}${asin}.01._SL1500_.jpg`;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

export async function compressImage(
  base64Data: string,
  maxWidth: number = 200,
  quality: number = 0.3
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ratio = img.height / img.width;
      canvas.width = maxWidth;
      canvas.height = Math.round(maxWidth * ratio);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(base64Data);
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(base64Data);
    img.src = base64Data;
  });
}