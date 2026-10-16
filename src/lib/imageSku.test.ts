import test from "node:test";
import assert from "node:assert/strict";
import { extractSalePriceFromText, findSalePriceColumn, generateSku, readCellText } from "./imageSku.ts";

test("prefers the value immediately after sale/old-price markers and otherwise falls back to the last visible price", () => {
  assert.equal(extractSalePriceFromText("SAR 299.00\nSAR 249.00"), "249.00");
  assert.equal(extractSalePriceFromText("Was SAR 299.00 Now SAR 249.00"), "249.00");
  assert.equal(extractSalePriceFromText("Sale SAR 249.00 Was SAR 299.00"), "249.00");
  assert.equal(extractSalePriceFromText("299.00 249.00"), "249.00");
  assert.equal(extractSalePriceFromText("SAR 299.00 - SAR 249.00"), "249.00");
  assert.equal(extractSalePriceFromText("Was 299.00 Now 249.00"), "249.00");
  assert.equal(extractSalePriceFromText("EGP\n399.00\nEGP\n999.00\n60% Off"), "399.00");
  assert.equal(extractSalePriceFromText("EGP\n999.00\nEGP\n399.00\n60% Off"), "399.00");

  const richTextCell = {
    value: {
      richText: [
        { text: "EGP\n399.00\nEGP\n" },
        { text: "999.00", font: { strike: true } },
        { text: "\n60% Off" },
      ],
    },
  } as never;
  assert.equal(extractSalePriceFromText(readCellText(richTextCell)), "399.00");
  assert.equal(findSalePriceColumn(["Price", "Sale Price", "SKU"]), 1);
  assert.equal(findSalePriceColumn(["السعر القديم", "السعر بعد الخصم"]), 1);
  assert.equal(generateSku("ABCD", 0), "ABCD001");
  assert.equal(generateSku("ABCD", 1), "ABCD002");
});
