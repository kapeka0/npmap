import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildSignatures, isMatched, matchContent } from "../src/signature.js";
import type { Signature } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const exampleFile = join(here, "..", "..", "signatures.example.json");

test("buildSignatures collects literals and regexes", async () => {
  const { signatures } = await buildSignatures({
    literals: ["__FAKE__"],
    regexes: ["v\\d+"],
    ignoreCase: false,
  });
  assert.equal(signatures.length, 2);
  assert.equal(signatures[0]!.kind, "literal");
  assert.equal(signatures[1]!.kind, "regex");
});

test("buildSignatures throws when nothing is provided", async () => {
  await assert.rejects(() => buildSignatures({ literals: [], regexes: [], ignoreCase: false }));
});

test("buildSignatures loads a named lib and forces all-mode", async () => {
  const { signatures, forcedMode } = await buildSignatures({
    literals: [],
    regexes: [],
    ignoreCase: false,
    signaturesFile: exampleFile,
    lib: "fakelib",
  });
  assert.equal(forcedMode, "all");
  assert.ok(signatures.some((s) => s.pattern === "__FAKELIB_SIGNATURE__"));
  assert.ok(signatures.some((s) => s.kind === "regex"));
});

test("buildSignatures rejects unknown lib", async () => {
  await assert.rejects(() =>
    buildSignatures({ literals: [], regexes: [], ignoreCase: false, signaturesFile: exampleFile, lib: "nope" }),
  );
});

test("matchContent returns hits with a snippet", () => {
  const sigs: Signature[] = [{ name: "fake", kind: "literal", pattern: "SIGNATURE" }];
  const hits = matchContent("....hidden SIGNATURE here....", "u.js", sigs);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.assetUrl, "u.js");
  assert.match(hits[0]!.snippet, /SIGNATURE/);
});

test("regex signature respects ignore-case flag", async () => {
  const { signatures } = await buildSignatures({ literals: [], regexes: ["fakelib"], ignoreCase: true });
  const hits = matchContent("this is FAKELIB v3", "u.js", signatures);
  assert.equal(hits.length, 1);
});

test("isMatched enforces any vs all", () => {
  const sigs: Signature[] = [
    { name: "a", kind: "literal", pattern: "A" },
    { name: "b", kind: "literal", pattern: "B" },
  ];
  const onlyA = matchContent("has A only", "u", sigs);
  assert.equal(isMatched(onlyA, sigs, "any"), true);
  assert.equal(isMatched(onlyA, sigs, "all"), false);
  const both = matchContent("has A and B", "u", sigs);
  assert.equal(isMatched(both, sigs, "all"), true);
});
