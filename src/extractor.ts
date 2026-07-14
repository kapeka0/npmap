/** URLs and inline scripts discovered in an HTML document. */
export interface ExtractedAssets {
  /** Absolute URLs of external scripts and preloaded modules. */
  assetUrls: string[];
  /** Bodies of inline <script> blocks (scanned directly, not downloaded). */
  inlineScripts: string[];
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  if (!m) return undefined;
  return m[2] ?? m[3] ?? m[4];
}

function resolve(ref: string, baseUrl: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("#") || trimmed.startsWith("javascript:")) {
    return null;
  }
  try {
    const u = new URL(trimmed, baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SELF_CLOSING_SCRIPT = /<script\b([^>]*?)\/>/gi;
const LINK_TAG = /<link\b([^>]*?)\/?>/gi;

/**
 * Pull script sources, inline scripts and preloaded module URLs out of an HTML
 * document, resolving relative references against `baseUrl`. Duplicate URLs are
 * removed while preserving first-seen order.
 */
export function extractAssetUrls(html: string, baseUrl: string): ExtractedAssets {
  const urls = new Set<string>();
  const inlineScripts: string[] = [];

  for (const m of html.matchAll(SCRIPT_TAG)) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    const src = attr(attrs, "src");
    if (src) {
      const abs = resolve(src, baseUrl);
      if (abs) urls.add(abs);
    } else if (body.trim()) {
      inlineScripts.push(body);
    }
  }

  for (const m of html.matchAll(SELF_CLOSING_SCRIPT)) {
    const src = attr(m[1] ?? "", "src");
    if (src) {
      const abs = resolve(src, baseUrl);
      if (abs) urls.add(abs);
    }
  }

  for (const m of html.matchAll(LINK_TAG)) {
    const attrs = m[1] ?? "";
    const rel = (attr(attrs, "rel") ?? "").toLowerCase();
    const as = (attr(attrs, "as") ?? "").toLowerCase();
    const isModulePreload = rel.includes("modulepreload");
    const isScriptPreload = rel.includes("preload") && as === "script";
    if (isModulePreload || isScriptPreload) {
      const href = attr(attrs, "href");
      const abs = href ? resolve(href, baseUrl) : null;
      if (abs) urls.add(abs);
    }
  }

  return { assetUrls: [...urls], inlineScripts };
}

// Path-like string literals ending in a JS extension, e.g. "assets/index-ab12.js".
const JS_STRING_LITERAL = /["'`]([\w./\-@?=&%]+?\.(?:m?js|chunk\.js))(?:\?[\w.=&%-]*)?["'`]/gi;

/**
 * Heuristically discover additional chunk URLs referenced inside a JS bundle.
 * Looks for string literals that resolve to same-family `.js`/`.mjs` files.
 * This is best-effort: webpack/vite emit chunk paths as plain string literals,
 * which this captures, but computed/obfuscated paths may be missed.
 */
export function extractChunkRefs(jsContent: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  for (const m of jsContent.matchAll(JS_STRING_LITERAL)) {
    const ref = m[1];
    if (!ref) continue;
    // Skip source maps and obvious non-chunk noise.
    if (ref.endsWith(".map")) continue;
    const abs = resolve(ref, baseUrl);
    if (abs && abs !== baseUrl) urls.add(abs);
  }
  return [...urls];
}
