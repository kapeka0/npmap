#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { buildSignatures } from "./signature.js";
import { scanAll } from "./scanner.js";
import { render, type OutputFormat } from "./output.js";
import type { MatchMode, ScanOptions } from "./types.js";

const DEFAULT_UA = "npmap/0.1 (+https://github.com/kapeka0/npmap)";

/** Thrown for usage/input problems; mapped to exit code 2. */
class UsageError extends Error {}

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

/** commander argument coercer: non-negative integer. */
function intArg(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new InvalidArgumentError("must be a non-negative integer.");
  }
  return n;
}

/** Collect repeatable option values into an array. */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
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

interface CliOptions {
  file?: string;
  signature: string[];
  regex: string[];
  signatures?: string;
  lib?: string;
  ignoreCase: boolean;
  matchMode: string;
  followChunks: boolean;
  depth: number;
  concurrency: number;
  assetConcurrency: number;
  timeout: number;
  maxSize: number;
  retries: number;
  userAgent?: string;
  tmpDir?: string;
  keep: boolean;
  json: boolean;
  ndjson: boolean;
  list: boolean;
  silent: boolean;
  color: boolean;
}

/** Do the actual scan. Throws UsageError for input problems (exit 2). */
async function run(targetArgs: string[], opts: CliOptions): Promise<void> {
  // Collect targets from positionals, a file, and/or stdin.
  const targets: string[] = [...targetArgs];
  if (opts.file) {
    try {
      targets.push(...parseLines(await readFile(opts.file, "utf8")));
    } catch (err) {
      throw new UsageError(`cannot read targets file ${opts.file}: ${(err as Error).message}`);
    }
  }
  const stdinRequested = targets.includes("-");
  const noExplicitTargets = targetArgs.length === 0 && !opts.file;
  if (stdinRequested || (noExplicitTargets && !process.stdin.isTTY)) {
    const idx = targets.indexOf("-");
    if (idx !== -1) targets.splice(idx, 1);
    targets.push(...parseLines(await readStdin()));
  }

  const uniqueTargets = [...new Set(targets)];
  if (uniqueTargets.length === 0) throw new UsageError("no targets provided. See --help.");

  if (opts.matchMode !== "any" && opts.matchMode !== "all") {
    throw new UsageError(`--match-mode must be "any" or "all".`);
  }

  let built: Awaited<ReturnType<typeof buildSignatures>>;
  try {
    built = await buildSignatures({
      literals: opts.signature,
      regexes: opts.regex,
      ignoreCase: opts.ignoreCase,
      signaturesFile: opts.signatures,
      lib: opts.lib,
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }

  const options: ScanOptions = {
    signatures: built.signatures,
    matchMode: (built.forcedMode ?? opts.matchMode) as MatchMode,
    followChunks: opts.followChunks,
    depth: opts.depth,
    timeoutMs: opts.timeout,
    maxBytes: opts.maxSize,
    retries: opts.retries,
    userAgent: opts.userAgent ?? DEFAULT_UA,
    assetConcurrency: Math.max(1, opts.assetConcurrency),
    tmpDir: opts.tmpDir,
    keepTemp: opts.keep,
  };

  const results = await scanAll(uniqueTargets, options, Math.max(1, opts.concurrency));

  let format: OutputFormat = "human";
  if (opts.json) format = "json";
  else if (opts.ndjson) format = "ndjson";
  else if (opts.list || opts.silent) format = "list";

  const color = opts.color && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const output = render(results, { format, color });
  if (output) process.stdout.write(`${output}\n`);

  // In silent mode nothing but the matched hosts is written, so skip the notice.
  if (opts.keep && !opts.silent) {
    process.stderr.write(`npmap: temp files kept under ${options.tmpDir ?? "OS temp dir"}\n`);
  }

  // A successful run always exits 0 (whether or not anything matched). The exit
  // code is left at its default; we avoid process.exit() here because, with open
  // (undici) sockets, it races handle teardown and aborts with a libuv
  // assertion on Windows.
}

async function main(): Promise<void> {
  const program = new Command();
  const MAX = 5 * 1024 * 1024;

  program
    .name("npmap")
    .description("Fingerprint npm libraries on websites by scanning HTML, bundles and chunks.")
    .version(await readVersion(), "-V, --version", "output the version number")
    .argument("[targets...]", "URLs/hosts to scan (also via -f/--file or stdin)")
    // Signatures
    .option("-s, --signature <str>", "literal signature to search for (repeatable)", collect, [])
    .option("-r, --regex <pattern>", "regex signature to search for (repeatable)", collect, [])
    .option("-S, --signatures <file>", "JSON file of named signatures (use with --lib)")
    .option("-l, --lib <name>", "select an entry from the --signatures file")
    .option("-i, --ignore-case", "case-insensitive matching", false)
    .option("-m, --match-mode <mode>", 'combine signatures: "any" or "all"', "any")
    // Targets
    .option("-f, --file <path>", "read targets from a file (one per line, # comments ok)")
    // Scanning
    .option("-c, --follow-chunks", "recursively discover & scan JS chunks", false)
    .option("-d, --depth <n>", "extra chunk-follow levels", intArg, 2)
    .option("-j, --concurrency <n>", "targets scanned in parallel", intArg, 8)
    .option("-a, --asset-concurrency <n>", "assets per target in parallel", intArg, 6)
    .option("-t, --timeout <ms>", "per-request timeout in ms", intArg, 15000)
    .option("-z, --max-size <bytes>", "max bytes read per asset", intArg, MAX)
    .option("-R, --retries <n>", "network retries per request", intArg, 1)
    .option("-A, --user-agent <str>", "override the User-Agent header")
    .option("-k, --keep", "keep temp files and print their location", false)
    .option("--tmp-dir <dir>", "base dir for temp downloads (default OS temp)")
    // Output
    .option("--json", "pretty JSON array of results", false)
    .option("--ndjson", "one JSON result per line", false)
    .option("-L, --list", "only matching hosts, one per line", false)
    .option("-q, --silent", "print only matching hosts, nothing else", false)
    .option("--no-color", "disable ANSI colors")
    .addHelpText(
      "after",
      ["", "Exit codes:", "  0  success", "  2  usage or input error"].join("\n"),
    )
    .action((targets: string[], opts: CliOptions) => run(targets, opts));

  program.exitOverride();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version print their own output and carry exitCode 0; parse/usage
      // errors carry a non-zero exitCode, which we normalize to 2.
      process.exitCode = err.exitCode === 0 ? 0 : 2;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`npmap: ${message}\n`);
    process.exitCode = 2;
  }
}

void main();
