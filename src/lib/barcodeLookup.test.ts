import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { exportBarcodeResults, parseBarcodeSheet, type BarcodeLookupResult } from "./barcodeLookup.ts";

function makeWorkbook(rows: unknown[][]): ArrayBuffer {
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Products");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

test("barcode lookup parses barcode and price from columns A and B without a product name", async () => {
  const rows = await parseBarcodeSheet(
    makeWorkbook([["3606000537671", 199], ["1234567890123", 250]]),
    "ABCD0001"
  );

  assert.deepEqual(rows.map(({ barcode, price, sku, sourceName, englishName }) => ({
    barcode, price, sku, sourceName, englishName,
  })), [
    { barcode: "3606000537671", price: 199, sku: "ABCD0001", sourceName: "", englishName: "" },
    { barcode: "1234567890123", price: 250, sku: "ABCD0002", sourceName: "", englishName: "" },
  ]);
});

test("barcode lookup detects barcode and price headers", async () => {
  const rows = await parseBarcodeSheet(
    makeWorkbook([["الباركود", "السعر"], ["03606000537671", 199]]),
    "ABCD0001"
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].barcode, "03606000537671");
  assert.equal(rows[0].price, 199);
});

test("barcode lookup preserves the existing product-name and barcode column layout", async () => {
  const rows = await parseBarcodeSheet(
    makeWorkbook([["اسم المنتج", "الباركود", "السعر", "English Name"], ["مرطب", "3606000537671", 199, "Moisturizer"]]),
    "ABCD0001"
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceName, "مرطب");
  assert.equal(rows[0].englishName, "Moisturizer");
  assert.equal(rows[0].barcode, "3606000537671");
  assert.equal(rows[0].price, 199);
});

test("barcode export completes with partial image failures and reports progress", async () => {
  const descriptors = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    fetch: Object.getOwnPropertyDescriptor(globalThis, "fetch"),
    createObjectURL: Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
    revokeObjectURL: Object.getOwnPropertyDescriptor(URL, "revokeObjectURL"),
  };
  const downloadCapture: { blob?: Blob } = {};
  const progressStages: string[] = [];

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      body: { appendChild: () => undefined },
      createElement: () => ({ click: () => undefined, remove: () => undefined, href: "", download: "" }),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.includes("failed.example")
        ? new Response(null, { status: 502 })
        : new Response(Uint8Array.from([255, 216, 255, 217]), {
          headers: { "content-type": "image/jpeg" },
        });
    },
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      downloadCapture.blob = blob;
      return "blob:test";
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });

  const makeResult = (index: number, imageUrl: string): BarcodeLookupResult => ({
    index,
    sourceName: `Product ${index}`,
    englishName: "",
    barcode: `123456789012${index}`,
    price: null,
    sku: `ABCD000${index}`,
    productName: `Product ${index}`,
    description: "",
    imageUrl,
    productUrl: "",
    source: "",
    matchScore: 0,
    barcodeVerified: false,
    candidates: [],
    status: "not_found",
  });

  try {
    const failedImages = await exportBarcodeResults([
      makeResult(1, "https://success.example/image.jpg"),
      makeResult(2, "https://failed.example/image.jpg"),
    ], (progress) => progressStages.push(progress.stage));

    assert.equal(failedImages, 1);
    if (!downloadCapture.blob) throw new Error("Expected export to trigger a file download");
    assert.ok(progressStages.includes("images"));
    assert.ok(progressStages.includes("workbook"));
    assert.ok(progressStages.includes("zip"));

    const archive = await JSZip.loadAsync(await downloadCapture.blob.arrayBuffer());
    assert.ok(archive.file("images/ABCD0001.jpg"));
    assert.equal(archive.file("images/ABCD0002.jpg"), null);
    assert.ok(archive.file("barcode-lookup-results.xlsx"));
  } finally {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) {
        if (key === "createObjectURL" || key === "revokeObjectURL") {
          Object.defineProperty(URL, key, descriptor);
        } else {
          Object.defineProperty(globalThis, key, descriptor);
        }
      } else if (key === "createObjectURL" || key === "revokeObjectURL") {
        Reflect.deleteProperty(URL, key);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  }
});
