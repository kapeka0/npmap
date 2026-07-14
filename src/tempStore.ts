import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchText, type FetchOptions } from "./fetcher.js";

export interface DownloadedAsset {
  url: string;
  /** Final URL after redirects. */
  finalUrl: string;
  status: number;
  contentType: string;
  content: string;
  bytes: number;
  truncated: boolean;
  /** Path of the temp file the asset was written to. */
  path: string;
}

/**
 * A temporary staging area on disk for downloaded bundles/chunks. Callers must
 * invoke `cleanup()` when done (or set `keep` to retain the files for auditing).
 */
export class TempStore {
  private dir: string | null = null;

  constructor(
    private readonly fetchOpts: FetchOptions,
    private readonly baseDir: string = tmpdir(),
    private readonly keep: boolean = false,
  ) {}

  private async ensureDir(): Promise<string> {
    if (this.dir) return this.dir;
    await mkdir(this.baseDir, { recursive: true });
    this.dir = await mkdtemp(join(this.baseDir, "npmap-"));
    return this.dir;
  }

  /** The temp directory path, or null if nothing was downloaded yet. */
  get directory(): string | null {
    return this.dir;
  }

  /**
   * Download a URL into the temp directory and return its content. The bytes
   * are written to disk (fulfilling the "download temporarily" contract) and
   * also returned in-memory so the caller can scan without re-reading.
   */
  async download(url: string): Promise<DownloadedAsset> {
    const dir = await this.ensureDir();
    const res = await fetchText(url, this.fetchOpts);
    const name = createHash("sha1").update(url).digest("hex").slice(0, 16);
    const ext = res.contentType.includes("css") ? ".css" : ".js";
    const path = join(dir, `${name}${ext}`);
    await writeFile(path, res.body, "utf8");
    return {
      url,
      finalUrl: res.url,
      status: res.status,
      contentType: res.contentType,
      content: res.body,
      bytes: res.bytes,
      truncated: res.truncated,
      path,
    };
  }

  /** Remove the temp directory unless `keep` was set. */
  async cleanup(): Promise<string | null> {
    if (!this.dir) return null;
    if (this.keep) return this.dir;
    const dir = this.dir;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    this.dir = null;
    return null;
  }
}
