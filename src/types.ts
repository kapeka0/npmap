/**
 * A single compiled signature to look for inside downloaded content.
 */
export interface Signature {
  /** Human-readable name, e.g. the library or the raw pattern. */
  name: string;
  kind: "literal" | "regex";
  /** The literal string or the regex source. */
  pattern: string;
  /** Regex flags (only used when kind === "regex"). */
  flags?: string;
}

/**
 * Shape of a `--signatures` JSON file: a map of library name to its rules.
 * Entries in `any`/`all` may be plain literals or, when prefixed with `re:`,
 * regular expressions.
 */
export type SignatureFile = Record<string, SignatureDefinition>;

export interface SignatureDefinition {
  /** Match when ANY of these are found (default combine mode). */
  any?: string[];
  /** Match only when ALL of these are found. */
  all?: string[];
  /** Optional free-text note about the library/signature. */
  description?: string;
}

export type MatchMode = "any" | "all";

/** A concrete hit of one signature inside one asset. */
export interface Match {
  signature: string;
  assetUrl: string;
  /** Short surrounding context to make the hit auditable. */
  snippet: string;
}

/** Result of scanning a single target. */
export interface ScanResult {
  target: string;
  host: string;
  matched: boolean;
  matches: Match[];
  assetsScanned: number;
  bytesScanned: number;
  error?: string;
}

/** Everything the scanner needs to process a target. */
export interface ScanOptions {
  signatures: Signature[];
  matchMode: MatchMode;
  followChunks: boolean;
  depth: number;
  timeoutMs: number;
  maxBytes: number;
  retries: number;
  userAgent: string;
  assetConcurrency: number;
  tmpDir?: string;
  keepTemp: boolean;
}
