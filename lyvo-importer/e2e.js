/* ============================================================
 * اختبار شامل E2E — يرفع الخادم فعليًا ويختبر دورة العمل كاملة
 * يحاكي موقع براند محلي (بالصور) للتأكد من الجلب الحقيقي
 * ============================================================ */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const zlib = require("zlib");

const PORT = "4178";
const BASE = "http://127.0.0.1:" + PORT;

let child;
let mockServer;

/* ---------- أدوات HTTP ---------- */
function get(p) {
  return new Promise((resolve) => {
    http.get(BASE + p, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString() }));
    }).on("error", (e) => resolve({ status: 0, body: null, text: String(e.message) }));
  });
}

function post(p, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const req = http.request(BASE + p, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", (e) => resolve({ status: 0, body: null, text: String(e.message) }));
    req.write(data);
    req.end();
  });
}

/* رفع ملفات متعددة (multipart/form-data) */
function postForm(p, fields, files) {
  return new Promise((resolve) => {
    const boundary = "----LYVO" + Date.now();
    const parts = [];
    for (const [k, v] of Object.entries(fields || {})) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    for (const f of files || []) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
      parts.push(f.buffer);
      parts.push(Buffer.from("\r\n"));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const payload = Buffer.concat(parts);
    const req = http.request(BASE + p, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": payload.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", (e) => resolve({ status: 0, text: String(e.message) }));
    req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("PASS -", name); }
  else { failed++; console.log("FAIL -", name, extra != null ? JSON.stringify(extra).slice(0, 300) : ""); }
}

/* ---------- صورة PNG حقيقية 60x60 (صالحة لـ sharp) ---------- */
function makePngBuffer() {
  const width = 60, height = 60;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; /* 8-bit RGB */
  const raw = [];
  for (let y = 0; y < height; y++) {
    raw.push(0);
    for (let x = 0; x < width; x++) raw.push(200, 60 + (x % 40), 120 + (y % 40));
  }
  const idat = zlib.deflateSync(Buffer.from(raw));
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
// __PART2__

/* ---------- صفحة منتج حقيقية الشكل ---------- */
const productHtml = `<!doctype html><html><head><title>LYVO Serum Vitamin C 30ml | Brand Store</title>
  <meta property="og:title" content="LYVO Serum Vitamin C 30ml"/>
  <meta property="og:image" content="/media/product-1.png"/>
  <meta property="product:price:amount" content="249"/>
  <meta property="product:price:currency" content="EGP"/>
  <meta name="description" content="سيروم فيتامين سي المركز 30 مل"/>
  </head><body><h1>LYVO Serum Vitamin C 30ml</h1>
  <div class="price">EGP 249.00</div>
  <div class="woocommerce-product-details__short-description">سيروم فيتامين سي المركز 30 مل لبشرة أكثر إشراقا.</div>
  <img src="/media/product-1.png"/></body></html>`;

function makeMockBrandServer(png) {
  return http.createServer((req, res) => {
    const u = req.url;
    if (u.startsWith("/?s=")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><body>
        <li class="product"><a href="/product/vitamin-c-serum" title="LYVO Serum Vitamin C 30ml">LYVO Serum Vitamin C 30ml</a><span class="price">EGP 249.00</span></li>
        <li class="product"><a href="/product/other-item" title="LYVO Face Cream 50ml">LYVO Face Cream 50ml</a></li>
      </body></html>`);
    } else if (u === "/product/vitamin-c-serum") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(productHtml);
    } else if (u === "/product/other-item") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(productHtml.replace(/Serum Vitamin C 30ml/g, "Face Cream 50ml"));
    } else if (u === "/media/product-1.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(png);
    } else {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Not Found</h1></body></html>");
    }
  });
}

/* ---------- الدورة الكاملة ---------- */
async function main() {
  console.log("=== LYVO E2E — بدء الاختبار الشامل ===");

  /* 1) موقع البراند الوهمي */
  const PNG = makePngBuffer();
  mockServer = makeMockBrandServer(PNG);
  await new Promise((r) => mockServer.listen(4599, r));
  console.log("✓ موقع البراند الوهمي يعمل على :4599");

  /* 2) ملف Excel للاختبار */
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([["اسم المنتج"], ["LYVO Serum Vitamin C 30ml"], ["منتج غير موجود في الموقع XYZ"]]);
  XLSX.utils.book_append_sheet(wb, ws, "Products");
  const xlsxBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  /* 3) رفع الخادم الفعلي */
  child = spawn("node", ["server.js"], { cwd: __dirname, stdio: "ignore", env: { ...process.env, PORT } });
  await sleep(1800);

  /* 4) اختبارات */
  let r = await get("/api/state");
  check("GET /api/state يعمل", r.status === 200 && r.text.includes('"ok":true'));

  r = await get("/");
  check("الصفحة الرئيسية تحمل الواجهة", r.status === 200 && r.text.includes("LYVO Product Importer") && r.text.includes("style.css"));

  r = await get("/style.css");
  check("ملف CSS يُخدم", r.status === 200 && r.text.includes("--primary"));

  /* رفع الإكسل */
  r = await postForm("/api/upload", {}, [{ name: "file", filename: "test-products.xlsx", buffer: xlsxBuffer }]);
  check("POST /api/upload يرفع الملف", r.status === 200 && r.text.includes('"ok":true'), r.text.slice(0, 200));
  check("كشف الشيتات", r.text.includes("Products"));

  /* استخراج الأسماء */
  r = await post("/api/extract", { sheetName: "Products", columnIndex: 0, hasHeader: true });
  check("POST /api/extract يستخرج الأسماء", r.status === 200, r.text.slice(0, 200));
  let ex = {};
  try { ex = JSON.parse(r.text); } catch {}
  check("عدد الصفوف = 2", ex.count === 2, ex.count);

  /* الإعدادات */
  r = await post("/api/settings", { brand: "LYVO", siteUrl: "http://localhost:4599", currency: "EGP", writeSkuOnImage: true });
  check("POST /api/settings يحفظ", r.status === 200 && r.text.includes("LYVO"));

  /* تخصيص SKU */
  r = await post("/api/sku", { firstSku: "LYVO-000100" });
  check("POST /api/sku يخصص متسلسلًا", r.status === 200 && r.text.includes("LYVO-000101"), r.text.slice(0, 200));

  /* بدء المعالجة (جلب حقيقي من الموقع الوهمي) */
  r = await post("/api/process/start", {});
  check("POST /api/process/start يبدأ", r.status === 200 && r.text.includes('"ok":true'));

  /* انتظار اكتمال المعالجة */
  let done = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const s = await get("/api/process/status");
    try {
      const j = JSON.parse(s.text);
      if (!j.processing.active && j.processing.done >= j.processing.total && j.processing.total > 0) { done = true; break; }
    } catch {}
  }
  check("المعالجة اكتملت", done);
}

let passedCount = passed, failedCount = failed;
main().catch((e) => { console.error("E2E ERROR:", e); failedCount++; })
  .finally(() => {
    try { if (child) child.kill(); } catch {}
    try { if (mockServer) mockServer.close(); } catch {}
    setTimeout(() => process.exit(failedCount ? 1 : 0), 300);
  });


