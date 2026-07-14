export interface FetchOptions {
  timeoutMs: number;
  maxBytes: number;
  retries: number;
  userAgent: string;
}

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
  /** Number of bytes actually read (may be capped by maxBytes). */
  bytes: number;
  /** True if the body was cut off at maxBytes. */
  truncated: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Read a fetch Response body as text, stopping once `maxBytes` have been read.
 * Avoids buffering huge assets fully in memory.
 */
async function readCapped(res: Response, maxBytes: number): Promise<{ body: string; bytes: number; truncated: boolean }> {
  if (!res.body) {
    const text = await res.text();
    const buf = Buffer.from(text);
    if (buf.byteLength > maxBytes) {
      return { body: buf.subarray(0, maxBytes).toString("utf8"), bytes: maxBytes, truncated: true };
    }
    return { body: text, bytes: buf.byteLength, truncated: false };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf8");
  let out = "";
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - bytes;
      if (value.byteLength >= remaining) {
        out += decoder.decode(value.subarray(0, remaining), { stream: false });
        bytes += remaining;
        truncated = true;
        break;
      }
      out += decoder.decode(value, { stream: true });
      bytes += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  out += decoder.decode();
  return { body: out, bytes, truncated };
}

/**
 * Fetch a URL as text with a timeout, capped size and simple retry on network
 * failures. HTTP error statuses (4xx/5xx) are returned, not thrown.
 */
export async function fetchText(url: string, opts: FetchOptions): Promise<FetchResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        // "connection: close" keeps undici from pooling keep-alive sockets, so
        // the event loop drains and the CLI can exit cleanly without a forced
        // process.exit() (which races socket teardown on Windows/libuv).
        headers: { "user-agent": opts.userAgent, accept: "*/*", connection: "close" },
      });
      const { body, bytes, truncated } = await readCapped(res, opts.maxBytes);
      return {
        url: res.url || url,
        status: res.status,
        contentType: res.headers.get("content-type") ?? "",
        body,
        bytes,
        truncated,
      };
    } catch (err) {
      lastErr = err;
      // Retry only on network/abort errors, with a short backoff.
      if (attempt < opts.retries) await sleep(200 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`fetch failed for ${url}: ${reason}`);
}
