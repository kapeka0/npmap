#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { buildSignatures } from "./signature.js";
import { scanAll } from "./scanner.js";
import { render, type OutputFormat } from "./output.js";
import type { MatchMode, ScanOptions } from "./types.js";

const DEFAULT_UA = "npmap/0.1 (+https://github.com/npmap)";

const HELP = `npmap — fingerprint npm libraries on websites by scanning HTML, bundles and chunks.

USAGE
  npmap [targets...] [options]
  npmap -f targets.txt --signature "__REACT_DEVTOOLS_GLOBAL_HOOK__"
  cat subs.txt | npmap --lib react --signatures signatures.json --list

TARGETS
  Positional URLs/hosts, a file via -f/--file (one per line, # comments ok),
  or piped via stdin. Bare hosts get https:// prepended.

SIGNATURES (at least one required)
  --signature <str>     Literal string to search for (repeatable).
  --regex <pattern>     Regular expression to search for (repeatable).
  --signatures <file>   JSON file of named signatures (use with --lib).
  --lib <name>          Select an entry from the --signatures file.
  --ignore-case         Case-insensitive regex/file-regex matching.
  --match-mode <mode>   "any" (default) or "all": require every signature.

SCANNING
  --follow-chunks       Recursively discover & scan chunks referenced in JS.
  --depth <n>           Extra chunk-follow levels (default 2).
  --concurrency <n>     Targets scanned in parallel (default 8).
  --asset-concurrency <n>  Assets per target in parallel (default 6).
  --timeout <ms>        Per-request timeout (default 15000).
  --max-size <bytes>    Max bytes read per asset (default 5242880).
  --retries <n>         Network retries per request (default 1).
  --user-agent <str>    Override the User-Agent header.
  --tmp-dir <dir>       Base dir for temp downloads (default OS temp).
  --keep                Keep temp files and print their location.

OUTPUT
  --json                Pretty JSON array of results.
  --ndjson              One JSON result per line.
  --list                Only matching hosts, one per line (pipe-friendly).
  --quiet               Alias for --list (suppresses the report).
  --no-color            Disable ANSI colors.
  -h, --help            Show this help.
  --version             Show version.

EXIT CODES
  0  at least one target matched
  1  no target matched
  2  usage or input error
`;

function fail(message: string): never {
  process.stderr.write(`npmap: ${message}\n`);
  process.exit(2);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

function toInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail(`invalid value for ${name}: ${value}`);
  return Math.floor(n);
}

async function readVersion(): Promise<string> {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(await readFile(pkgUrl, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: "string", short: "f" },
      signature: { type: "string", multiple: true },
      regex: { type: "string", multiple: true },
      signatures: { type: "string" },
      lib: { type: "string" },
      "ignore-case": { type: "boolean", default: false },
      "match-mode": { type: "string", default: "any" },
      "follow-chunks": { type: "boolean", default: false },
      depth: { type: "string" },
      concurrency: { type: "string" },
      "asset-concurrency": { type: "string" },
      timeout: { type: "string" },
      "max-size": { type: "string" },
      retries: { type: "string" },
      "user-agent": { type: "string" },
      "tmp-dir": { type: "string" },
      keep: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      ndjson: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      "no-color": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${await readVersion()}\n`);
    return;
  }

  // Collect targets from positionals, file, and/or stdin.
  const targets: string[] = [...positionals];
  if (values.file) {
    try {
      targets.push(...parseLines(await readFile(values.file, "utf8")));
    } catch (err) {
      fail(`cannot read targets file ${values.file}: ${(err as Error).message}`);
    }
  }
  const stdinRequested = positionals.includes("-");
  const noExplicitTargets = targets.length === 0 && !values.file;
  if (stdinRequested || (noExplicitTargets && !process.stdin.isTTY)) {
    const idx = targets.indexOf("-");
    if (idx !== -1) targets.splice(idx, 1);
    targets.push(...parseLines(await readStdin()));
  }

  const uniqueTargets = [...new Set(targets)];
  if (uniqueTargets.length === 0) fail("no targets provided. See --help.");

  const matchMode = values["match-mode"] as string;
  if (matchMode !== "any" && matchMode !== "all") fail(`--match-mode must be "any" or "all".`);

  let built: Awaited<ReturnType<typeof buildSignatures>>;
  try {
    built = await buildSignatures({
      literals: values.signature ?? [],
      regexes: values.regex ?? [],
      ignoreCase: Boolean(values["ignore-case"]),
      signaturesFile: values.signatures,
      lib: values.lib,
    });
  } catch (err) {
    fail((err as Error).message);
  }

  const options: ScanOptions = {
    signatures: built.signatures,
    matchMode: (built.forcedMode ?? matchMode) as MatchMode,
    followChunks: Boolean(values["follow-chunks"]),
    depth: toInt(values.depth, 2, "--depth"),
    timeoutMs: toInt(values.timeout, 15000, "--timeout"),
    maxBytes: toInt(values["max-size"], 5 * 1024 * 1024, "--max-size"),
    retries: toInt(values.retries, 1, "--retries"),
    userAgent: values["user-agent"] ?? DEFAULT_UA,
    assetConcurrency: Math.max(1, toInt(values["asset-concurrency"], 6, "--asset-concurrency")),
    tmpDir: values["tmp-dir"],
    keepTemp: Boolean(values.keep),
  };

  const targetConcurrency = Math.max(1, toInt(values.concurrency, 8, "--concurrency"));
  const results = await scanAll(uniqueTargets, options, targetConcurrency);

  let format: OutputFormat = "human";
  if (values.json) format = "json";
  else if (values.ndjson) format = "ndjson";
  else if (values.list) format = "list";

  const color = !values["no-color"] && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const output = render(results, { format, color, quiet: Boolean(values.quiet) });
  if (output) process.stdout.write(`${output}\n`);

  if (values.keep) {
    process.stderr.write(`npmap: temp files kept under ${options.tmpDir ?? "OS temp dir"}\n`);
  }

  // Set the exit code and let the event loop drain naturally. Avoid
  // process.exit() here: with open (undici) sockets it races handle teardown
  // and aborts with a libuv assertion on Windows.
  const anyMatched = results.some((r) => r.matched);
  process.exitCode = anyMatched ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`npmap: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 2;
});
