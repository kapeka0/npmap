import { extractAssetUrls, extractChunkRefs } from "./extractor.js";
import { fetchText } from "./fetcher.js";
import { isMatched, matchContent } from "./signature.js";
import { TempStore } from "./tempStore.js";
import { mapLimit } from "./concurrency.js";
import type { Match, ScanOptions, ScanResult } from "./types.js";

/** Normalize a user-supplied target into an absolute http(s) URL. */
export function normalizeTarget(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const fetchOptsFrom = (o: ScanOptions) => ({
  timeoutMs: o.timeoutMs,
  maxBytes: o.maxBytes,
  retries: o.retries,
  userAgent: o.userAgent,
});

/**
 * Scan a single target: fetch its HTML, scan inline scripts, then download and
 * scan every referenced JS asset, optionally following chunk references to a
 * bounded depth. Errors are captured on the result rather than thrown.
 */
export async function scanTarget(rawTarget: string, options: ScanOptions): Promise<ScanResult> {
  const target = normalizeTarget(rawTarget);
  const host = hostOf(target);
  const store = new TempStore(fetchOptsFrom(options), options.tmpDir, options.keepTemp);
  const allHits: Match[] = [];
  let assetsScanned = 0;
  let bytesScanned = 0;

  try {
    const page = await fetchText(target, fetchOptsFrom(options));
    assetsScanned++;
    bytesScanned += page.bytes;

    // Scan the HTML itself.
    allHits.push(...matchContent(page.body, page.url, options.signatures));

    // Scan inline scripts and collect external asset URLs.
    const { assetUrls, inlineScripts } = extractAssetUrls(page.body, page.url);
    inlineScripts.forEach((code, i) => {
      allHits.push(...matchContent(code, `${page.url}#inline-${i}`, options.signatures));
    });

    // BFS over asset URLs, following chunk refs up to `depth` extra levels.
    const visited = new Set<string>();
    let frontier = assetUrls.filter((u) => !visited.has(u));
    frontier.forEach((u) => visited.add(u));

    const maxLevels = options.followChunks ? Math.max(0, options.depth) : 0;
    for (let level = 0; level <= maxLevels && frontier.length > 0; level++) {
      const discovered: string[] = [];
      await mapLimit(frontier, options.assetConcurrency, async (url) => {
        try {
          const asset = await store.download(url);
          assetsScanned++;
          bytesScanned += asset.bytes;
          allHits.push(...matchContent(asset.content, asset.finalUrl, options.signatures));
          if (level < maxLevels) {
            for (const ref of extractChunkRefs(asset.content, asset.finalUrl)) {
              if (!visited.has(ref)) {
                visited.add(ref);
                discovered.push(ref);
              }
            }
          }
        } catch {
          // A single asset failing shouldn't abort the target.
        }
      });
      frontier = discovered;
    }

    return {
      target,
      host,
      matched: isMatched(allHits, options.signatures, options.matchMode),
      matches: allHits,
      assetsScanned,
      bytesScanned,
    };
  } catch (err) {
    return {
      target,
      host,
      matched: false,
      matches: allHits,
      assetsScanned,
      bytesScanned,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await store.cleanup();
  }
}

/** Scan many targets with bounded concurrency across targets. */
export async function scanAll(
  targets: readonly string[],
  options: ScanOptions,
  targetConcurrency: number,
): Promise<ScanResult[]> {
  return mapLimit(targets, targetConcurrency, (t) => scanTarget(t, options));
}
