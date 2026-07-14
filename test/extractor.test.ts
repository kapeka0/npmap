import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAssetUrls, extractChunkRefs } from "../src/extractor.js";

const BASE = "https://example.com/app/";

test("extractAssetUrls resolves relative and absolute script sources", () => {
  const html = `
    <script src="/assets/a.js"></script>
    <script src="b.js"></script>
    <script src="https://cdn.example.org/react.production.min.js"></script>
  `;
  const { assetUrls } = extractAssetUrls(html, BASE);
  assert.deepEqual(assetUrls, [
    "https://example.com/assets/a.js",
    "https://example.com/app/b.js",
    "https://cdn.example.org/react.production.min.js",
  ]);
});

test("extractAssetUrls captures inline scripts and dedupes urls", () => {
  const html = `
    <script>window.foo = 1;</script>
    <script src="/x.js"></script>
    <script src="/x.js"></script>
  `;
  const { assetUrls, inlineScripts } = extractAssetUrls(html, BASE);
  assert.equal(assetUrls.length, 1);
  assert.equal(assetUrls[0], "https://example.com/x.js");
  assert.equal(inlineScripts.length, 1);
  assert.match(inlineScripts[0]!, /window\.foo = 1/);
});

test("extractAssetUrls picks up modulepreload and preload-as-script links", () => {
  const html = `
    <link rel="modulepreload" href="/m.js" />
    <link rel="preload" as="script" href="/p.js" />
    <link rel="stylesheet" href="/style.css" />
    <link rel="preload" as="font" href="/font.woff2" />
  `;
  const { assetUrls } = extractAssetUrls(html, BASE);
  assert.deepEqual(assetUrls, ["https://example.com/m.js", "https://example.com/p.js"]);
});

test("extractAssetUrls handles single quotes and unquoted attributes", () => {
  const html = `<script src='/single.js'></script><script src=/bare.js></script>`;
  const { assetUrls } = extractAssetUrls(html, BASE);
  assert.deepEqual(assetUrls, ["https://example.com/single.js", "https://example.com/bare.js"]);
});

test("extractChunkRefs finds js string literals and skips maps", () => {
  const js = `var m={main:"chunk.abc123.js",vendor:"vendor.def.js"};
    var css="skip.css"; var src="bundle.js.map"; import("/assets/lazy.mjs");`;
  const refs = extractChunkRefs(js, "https://example.com/assets/bundle.js");
  assert.ok(refs.includes("https://example.com/assets/chunk.abc123.js"));
  assert.ok(refs.includes("https://example.com/assets/vendor.def.js"));
  assert.ok(refs.includes("https://example.com/assets/lazy.mjs"));
  assert.ok(!refs.some((r) => r.endsWith(".map")));
  assert.ok(!refs.some((r) => r.endsWith(".css")));
});
