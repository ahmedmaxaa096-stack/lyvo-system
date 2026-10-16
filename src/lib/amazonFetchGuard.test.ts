import test from "node:test";
import assert from "node:assert/strict";
import { isAmazonNetworkResetError, shouldLogFetchError } from "../../vite-plugin-local-api.ts";

test("Amazon network resets are treated as expected fallback failures", () => {
  const error = new TypeError("fetch failed");
  Object.assign(error, { cause: "Error: read ECONRESET" });

  assert.equal(isAmazonNetworkResetError("https://www.amazon.eg/dp/B0H4TS22BQ", error), true);
  assert.equal(shouldLogFetchError("https://www.amazon.eg/dp/B0H4TS22BQ", error), false);
  assert.equal(shouldLogFetchError("https://www.noon.com/egypt-en/search?q=mouse", error), true);
});
