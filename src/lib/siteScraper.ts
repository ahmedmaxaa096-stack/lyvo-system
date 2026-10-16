import { EDGE_FUNCTIONS, HEADERS } from "./supabase";

export interface SiteProduct {
  url: string;
  product_name: string;
  product_name_ar?: string;
  price: number | null;
  image_url: string;
  image_url_high: string;
  description?: string;
  description_ar?: string;
  description_en?: string;
  images?: string[];
  sku?: string;
}

export interface ExtractSiteResult {
  success: boolean;
  total: number;
  pagesFetched: number;
  stoppedReason: string;
  products: SiteProduct[];
}

export async function extractSiteProducts(
  url: string,
  maxPages = 30,
  maxProducts = 1000
): Promise<ExtractSiteResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 600000); // 10 دقائق
  try {
    const response = await fetch(EDGE_FUNCTIONS.siteExtractor, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ url, maxPages, maxProducts }),
      signal: controller.signal,
    });

    let data: ExtractSiteResult;
    try {
      data = await response.json();
    } catch {
      const text = await response.text();
      throw new Error(`استجابة غير صحيحة من الخادم: ${text.substring(0, 120)}`);
    }

    if (!response.ok) {
      throw new Error(data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `فشل في جلب البيانات (${response.status})`);
    }

    return data;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("انتهت مهلة السحب (10 دقائق). جرّب رابط قسم أصغر إذا كان الموقع يحتوي على عدد ضخم جدًا من المنتجات.");
    }
    throw new Error(`خطأ في سحب المنتجات: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface DeepSiteProduct {
  url: string;
  product_name: string;
  product_name_ar?: string;
  price: number | null;
  description: string;
  description_ar?: string;
  description_en?: string;
  images: string[];
  image_url: string;
  sku?: string;
  error?: string;
}

interface ScrapeBatchResponse {
  success: boolean;
  results?: DeepSiteProduct[];
  error?: string;
}

export async function scrapeProductsBatch(urls: string[]): Promise<DeepSiteProduct[]> {
  const response = await fetch(EDGE_FUNCTIONS.scrapeBatch, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ urls: urls.slice(0, 40) }),
  });

  let data: ScrapeBatchResponse;
  try {
    data = await response.json();
  } catch {
    const text = await response.text();
    throw new Error(`استجابة غير صحيحة من الخادم: ${text.substring(0, 120)}`);
  }

  if (!response.ok) {
    throw new Error(data.error || `فشل في سحب الدفعة (${response.status})`);
  }

  return (data.results || []).map((item) => ({
    ...item,
    product_name: item.product_name || "",
    product_name_ar: item.product_name_ar || "",
    description: item.description || "",
    description_ar: item.description_ar || "",
    description_en: item.description_en || item.description || "",
    images: item.images || [],
    image_url: item.image_url || "",
    sku: item.sku || "",
  }));
}