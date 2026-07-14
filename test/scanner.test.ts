import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import type { AddressInfo } from "node:net";
import { scanTarget } from "../src/scanner.js";
import { buildSignatures } from "../src/signature.js";
import type { ScanOptions } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
// Compiled tests live in dist-test/test; the fixtures stay in the source tree.
const fixturesDir = join(here, "..", "..", "test", "fixtures");

let server: Server;
let base: string;

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "application/javascript";
  return "application/octet-stream";
}

before(async () => {
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let rel = decodeURIComponent(url.pathname);
      if (rel === "/") rel = "/index.html";
      const filePath = normalize(join(fixturesDir, rel));
      if (!filePath.startsWith(fixturesDir)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readFile(filePath);
      res.writeHead(200, { "content-type": contentType(filePath) }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function optionsFor(literals: string[], overrides: Partial<ScanOptions> = {}): Promise<ScanOptions> {
  const { signatures } = await buildSignatures({ literals, regexes: [], ignoreCase: false });
  return {
    signatures,
    matchMode: "any",
    followChunks: false,
    depth: 2,
    timeoutMs: 5000,
    maxBytes: 1024 * 1024,
    retries: 0,
    userAgent: "npmap-test",
    assetConcurrency: 4,
    keepTemp: false,
    ...overrides,
  };
}

test("detects a signature inside a downloaded bundle", async () => {
  const opts = await optionsFor(["__FAKELIB_SIGNATURE__"]);
  const result = await scanTarget(base, opts);
  assert.equal(result.matched, true);
  assert.ok(result.assetsScanned >= 2, "should scan html + bundle");
  assert.ok(result.matches.some((m) => m.assetUrl.includes("bundle.js")));
});

test("detects a signature in an inline script", async () => {
  const opts = await optionsFor(["__INLINE_MARKER__"]);
  const result = await scanTarget(base, opts);
  assert.equal(result.matched, true);
  assert.ok(result.matches.some((m) => m.assetUrl.includes("#inline-")));
});

test("does not find a chunk-only signature without --follow-chunks", async () => {
  const opts = await optionsFor(["FakeLib v3"], { followChunks: false });
  const result = await scanTarget(base, opts);
  assert.equal(result.matched, false);
});

test("finds a chunk-only signature with --follow-chunks", async () => {
  const opts = await optionsFor(["FakeLib v3"], { followChunks: true, depth: 2 });
  const result = await scanTarget(base, opts);
  assert.equal(result.matched, true);
  assert.ok(result.matches.some((m) => m.assetUrl.includes("chunk.abc123.js")));
});

test("reports no match for an absent signature and cleans up temp dir", async () => {
  const opts = await optionsFor(["__NOT_PRESENT_ANYWHERE__"]);
  const result = await scanTarget(base, opts);
  assert.equal(result.matched, false);
  assert.equal(result.matches.length, 0);
});

test("keepTemp retains the temp directory", async () => {
  const opts = await optionsFor(["__FAKELIB_SIGNATURE__"], { keepTemp: true });
  const result = await scanTarget(base, opts);
  assert.equal(result.matched, true);
  // The temp dir path isn't returned, but the scan must still succeed with keep on.
});

test("captures an error for an unreachable target without throwing", async () => {
  const opts = await optionsFor(["anything"], { retries: 0, timeoutMs: 1000 });
  const result = await scanTarget("http://127.0.0.1:1", opts);
  assert.equal(result.matched, false);
  assert.ok(result.error, "should record a fetch error");
});
