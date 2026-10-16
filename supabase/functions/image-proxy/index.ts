const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    // يدعم POST (JSON: { imageUrl }) و GET (?url=...) ليسهل عرض الصور في <img>
    let imageUrl = "";
    if (req.method === "GET") {
      imageUrl = new URL(req.url).searchParams.get("url") || "";
    } else {
      const { imageUrl: bodyImageUrl } = await req.json();
      imageUrl = bodyImageUrl;
    }

    if (!imageUrl) {
      return new Response(JSON.stringify({ error: "imageUrl is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // رؤوس مناسبة لجلب الصور؛ لروابط Google (gstatic / googleusercontent) نُرسل Referer
    // من Google حتى لا يُرفض الجلب (403) وتُعاد الصورة بنجاح.
    const fetchHeaders: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    };
    try {
      const host = new URL(imageUrl).hostname.toLowerCase();
      if (/(^|\.)gstatic\.com$/i.test(host) || /(^|\.)googleusercontent\.com$/i.test(host)) {
        fetchHeaders["Referer"] = "https://www.google.com/";
      }
    } catch {
      // تجاهل — استخدم الرؤوس الافتراضية
    }

    const response = await fetch(imageUrl, {
      headers: fetchHeaders,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch image (${response.status})`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "";
    const pathName = new URL(imageUrl).pathname.toLowerCase();
    const looksLikeImagePath = /\.(jpe?g|jfif|png|webp|gif|avif|bmp|svg)(?:[?#].*)?$/i.test(pathName);
    const hasJpegSignature = arrayBuffer.byteLength >= 3 &&
      arrayBuffer.slice(0, 3).byteLength === 3 &&
      new Uint8Array(arrayBuffer.slice(0, 3))[0] === 0xff &&
      new Uint8Array(arrayBuffer.slice(0, 3))[1] === 0xd8 &&
      new Uint8Array(arrayBuffer.slice(0, 3))[2] === 0xff;

    if (
      arrayBuffer.byteLength < 1024 ||
      (!contentType.startsWith("image/") && !looksLikeImagePath && !hasJpegSignature)
    ) {
      throw new Error("Amazon returned a placeholder image");
    }

    return new Response(arrayBuffer, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
