import { readFile } from "node:fs/promises";
import type {
  MatchMode,
  Match,
  Signature,
  SignatureDefinition,
  SignatureFile,
} from "./types.js";

const REGEX_PREFIX = "re:";

/** Build a regex Signature, validating the source eagerly. */
function makeRegexSignature(source: string, ignoreCase: boolean, name?: string): Signature {
  const flags = ignoreCase ? "i" : "";
  // Validate now so bad patterns fail fast with a clear message.
  try {
    new RegExp(source, flags);
  } catch (err) {
    throw new Error(`Invalid regex signature ${JSON.stringify(source)}: ${(err as Error).message}`);
  }
  return { name: name ?? `re:${source}`, kind: "regex", pattern: source, flags };
}

function makeLiteralSignature(value: string, name?: string): Signature {
  return { name: name ?? value, kind: "literal", pattern: value };
}

/**
 * Turn a raw entry from a signatures file into a Signature. Entries prefixed
 * with `re:` are treated as regular expressions, otherwise as literals.
 */
function entryToSignature(entry: string, ignoreCase: boolean, name: string): Signature {
  if (entry.startsWith(REGEX_PREFIX)) {
    return makeRegexSignature(entry.slice(REGEX_PREFIX.length), ignoreCase, name);
  }
  return makeLiteralSignature(entry, name);
}

export interface BuildSignaturesInput {
  literals: string[];
  regexes: string[];
  ignoreCase: boolean;
  signaturesFile?: string;
  lib?: string;
}

export interface BuiltSignatures {
  signatures: Signature[];
  /** Combine mode forced by a signature-file `all` block, if any. */
  forcedMode?: MatchMode;
}

/** Load and validate a `--signatures` JSON file. */
export async function loadSignatureFile(path: string): Promise<SignatureFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`Cannot read signatures file ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Signatures file ${path} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Signatures file ${path} must be a JSON object mapping names to definitions.`);
  }
  return parsed as SignatureFile;
}

/**
 * Assemble the effective list of signatures from CLI inputs. When a signatures
 * file + lib is used and the entry only has an `all` block, `forcedMode` is set
 * to "all" so the caller can require every pattern.
 */
export async function buildSignatures(input: BuildSignaturesInput): Promise<BuiltSignatures> {
  const signatures: Signature[] = [];
  let forcedMode: MatchMode | undefined;

  for (const literal of input.literals) signatures.push(makeLiteralSignature(literal));
  for (const rx of input.regexes) signatures.push(makeRegexSignature(rx, input.ignoreCase));

  if (input.signaturesFile) {
    const file = await loadSignatureFile(input.signaturesFile);
    if (!input.lib) {
      throw new Error("--signatures requires --lib <name> to select an entry from the file.");
    }
    const def: SignatureDefinition | undefined = file[input.lib];
    if (!def) {
      const names = Object.keys(file).join(", ") || "(none)";
      throw new Error(`Library ${JSON.stringify(input.lib)} not found in signatures file. Available: ${names}`);
    }
    const all = def.all ?? [];
    const any = def.any ?? [];
    if (all.length === 0 && any.length === 0) {
      throw new Error(`Signatures file entry ${JSON.stringify(input.lib)} has no "any" or "all" patterns.`);
    }
    for (const e of all) signatures.push(entryToSignature(e, input.ignoreCase, `${input.lib}:${e}`));
    for (const e of any) signatures.push(entryToSignature(e, input.ignoreCase, `${input.lib}:${e}`));
    // If the entry is expressed purely as `all`, require all patterns.
    if (all.length > 0 && any.length === 0) forcedMode = "all";
  }

  if (signatures.length === 0) {
    throw new Error("No signatures provided. Use --signature, --regex, or --signatures/--lib.");
  }

  return { signatures, forcedMode };
}

function snippetAround(content: string, index: number, length: number): string {
  const pad = 30;
  const start = Math.max(0, index - pad);
  const end = Math.min(content.length, index + length + pad);
  return content
    .slice(start, end)
    .replace(/\s+/g, " ")
    .trim();
}

/** Find the first occurrence of a single signature in content, or null. */
function findSignature(content: string, sig: Signature): { index: number; length: number } | null {
  if (sig.kind === "literal") {
    const idx = content.indexOf(sig.pattern);
    return idx === -1 ? null : { index: idx, length: sig.pattern.length };
  }
  const re = new RegExp(sig.pattern, sig.flags ?? "");
  const m = re.exec(content);
  return m ? { index: m.index, length: m[0].length } : null;
}

/**
 * Match all signatures against one asset's content. Returns the individual hits.
 * The caller decides, via matchMode, whether the asset "counts" as a match.
 */
export function matchContent(content: string, assetUrl: string, signatures: Signature[]): Match[] {
  const matches: Match[] = [];
  for (const sig of signatures) {
    const hit = findSignature(content, sig);
    if (hit) {
      matches.push({
        signature: sig.name,
        assetUrl,
        snippet: snippetAround(content, hit.index, hit.length),
      });
    }
  }
  return matches;
}

/**
 * Decide whether the accumulated hits satisfy the requested mode.
 * "any": at least one signature matched. "all": every signature matched at
 * least once (across all scanned assets).
 */
export function isMatched(allHits: Match[], signatures: Signature[], mode: MatchMode): boolean {
  if (allHits.length === 0) return false;
  if (mode === "any") return true;
  const matchedNames = new Set(allHits.map((h) => h.signature));
  return signatures.every((s) => matchedNames.has(s.name));
}
