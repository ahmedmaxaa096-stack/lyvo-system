import test from "node:test";
import assert from "node:assert/strict";
import {
  extractGoogleBarcodeCandidates,
  isBarcodeRetailerUrl,
  rankBarcodeCandidates,
  scoreBarcodeCandidate,
  scoreEgyptProductName,
  shouldIncludeBarcodeCandidate,
} from "../../vite-plugin-local-api.ts";

test("exact and near-exact product names score higher than unrelated products", () => {
  const positive = scoreEgyptProductName("Samsung 32 inch TV", "Samsung 32-inch Smart TV");
  const negative = scoreEgyptProductName("Samsung 32 inch TV", "Sony 55 inch OLED TV");
  assert.ok(positive > negative, "exact matching title should outrank unrelated title");
  assert.ok(positive >= 0.7, "strong product-name overlap should remain high");
});

test("barcode candidate scoring prefers strong keyword overlap over generic matches", () => {
  const exact = scoreBarcodeCandidate(["Philips Sonicare 3 Series Toothbrush"], "Philips Sonicare 3 Series Toothbrush", "Philips Sonicare 3 Series Electric Toothbrush");
  const weak = scoreBarcodeCandidate(["Philips Sonicare 3 Series Toothbrush"], "Philips Sonicare 3 Series Toothbrush", "Generic Oral Care Device");
  assert.ok(exact > weak, "real product title should outrank generic alternatives");
  assert.ok(exact >= 0.8, "close product match should remain high confidence");
});

test("barcode search is limited to Amazon Egypt and Noon Egypt product URLs", () => {
  assert.equal(isBarcodeRetailerUrl("https://www.amazon.eg/dp/B012345678"), true);
  assert.equal(isBarcodeRetailerUrl("https://www.noon.com/egypt-en/product/p/123"), true);
  assert.equal(isBarcodeRetailerUrl("https://www.noon.com/saudi-en/product/p/123"), false);
  assert.equal(isBarcodeRetailerUrl("https://www.jumia.com.eg/product/123"), false);
  assert.equal(isBarcodeRetailerUrl("https://example.com/"), false);
});

test("Google barcode results unwrap redirects and exclude non-retailer product links", () => {
  const html = [
    '<a href="/url?q=https%3A%2F%2Fwww.amazon.eg%2Fdp%2FB012345678&amp;sa=U"><h3>Samsung Galaxy A55 256GB</h3></a>',
    '<a href="https://www.jumia.com.eg/product/123"><h3>Samsung Galaxy A55</h3></a>',
  ].join("");
  const candidates = extractGoogleBarcodeCandidates(html, "https://www.google.com/search?q=123");
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].url, "https://www.amazon.eg/dp/B012345678");
  assert.equal(candidates[0].title, "Samsung Galaxy A55 256GB");
});

test("barcode name matching rejects substring-only and conflicting specification matches", () => {
  const requested = "Samsung Galaxy A55 256GB";
  const rightSpec = scoreBarcodeCandidate([requested], requested, "Samsung Galaxy A55 256 GB");
  const wrongSpec = scoreBarcodeCandidate([requested], requested, "Samsung Galaxy A55 128GB");
  const substringOnly = scoreBarcodeCandidate(["Sony"], "Sony", "Sonya headphones");
  assert.ok(rightSpec >= 0.8, "equivalent spacing should preserve a strong match");
  assert.ok(wrongSpec < 0.6, "conflicting storage size should not pass the candidate threshold");
  assert.ok(substringOnly < 0.6, "partial token overlap should not pass the candidate threshold");
});

test("barcode search results remain visible for review when the listing name differs", () => {
  assert.equal(shouldIncludeBarcodeCandidate(0.2, false, true), true);
  assert.equal(shouldIncludeBarcodeCandidate(0.2, false, false), false);
  assert.equal(shouldIncludeBarcodeCandidate(0, true, false), true);
});

test("deduplication keeps barcode-discovered candidates and ranks them before name-only hits", () => {
  const barcodeHit = {
    url: "https://www.amazon.eg/dp/B012345678",
    title: "Unexpected Amazon listing title",
    searchedByBarcode: true,
  };
  const nameHit = {
    url: "https://www.amazon.eg/dp/B012345678",
    title: "Unexpected Amazon listing title",
  };
  const strongNameHit = {
    url: "https://www.noon.com/egypt-en/product/p/123456",
    title: "Samsung Galaxy A55 256GB",
  };
  const ranked = rankBarcodeCandidates([barcodeHit, strongNameHit, nameHit], ["Samsung Galaxy A55 256GB"]);
  assert.equal(ranked.length, 2, "duplicate product URLs should be merged");
  assert.equal(ranked[0].url, barcodeHit.url, "barcode results should not be displaced by name-only results");
  assert.equal(ranked[0].searchedByBarcode, true, "deduplication should preserve barcode provenance");
});
