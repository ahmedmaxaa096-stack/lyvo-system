// تعطيل Supabase في Frontend - استخدام local API فقط
export const supabase = null;

export interface ScrapeResult {
  id: string;
  url: string;
  product_name: string | null;
  image_url: string | null;
  status: "pending" | "completed" | "error";
  error: string | null;
  created_at: string;
}

export const EDGE_FUNCTIONS = {
  scraper: "/api/noon-scraper",
  imageProxy: "/api/image-proxy",
  siteExtractor: "/api/extract-site",
  scrapeBatch: "/api/scrape-batch",
};

export const HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
};
