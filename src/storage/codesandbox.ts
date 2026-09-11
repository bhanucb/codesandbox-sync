import { CodeSandbox } from "@codesandbox/sdk";
import { requireToken } from "../config.js";
import type { Logger } from "../zip.js";
import type { RemoteZip, Storage } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Devbox = any;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRemotePath(remoteDir: string, fileName: string): string {
  const base = remoteDir.replace(/\\/g, "/").replace(/\/+$/g, "");
  return `${base}/${fileName}`;
}

async function readErrorSnippet(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const trimmed = text.trim().replace(/\s+/g, " ");
    return trimmed.length > 180 ? `${trimmed.slice(0, 180)}…` : trimmed;
  } catch {
    return "";
  }
}

async function downloadBufferFromUrl(
  downloadUrl: string,
  maxAttempts: number,
  log: Logger
): Promise<Buffer | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(downloadUrl);
    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    }
    const retriable = response.status >= 500 && response.status < 600;
    const snippet = await readErrorSnippet(response);
    const detail = snippet ? ` — ${snippet}` : "";
    if (retriable && attempt < maxAttempts) {
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      log(`  ⚠ HTTP ${response.status} ${response.statusText}${detail}`);
      log(`  Retrying in ${delayMs}ms… (attempt ${attempt + 1}/${maxAttempts})`);
      await sleep(delayMs);
      continue;
    }
    log(`  ⚠ HTTP ${response.status} ${response.statusText}${detail}`);
    return null;
  }
  return null;
}

/**
 * The original backend: a CodeSandbox devbox used as a file drop. The devbox
 * is a live machine rather than a store, so writes need explicit verification
 * and the connection has to be torn down without hanging.
 */
export class CodeSandboxStorage implements Storage {
  readonly kind = "codesandbox" as const;
  readonly location: string;
  readonly browseUrl: string;

  private devbox: Devbox | null = null;

  constructor(
    private readonly devboxId: string,
    private readonly remoteDir: string
  ) {
    this.location = `${remoteDir} on devbox ${devboxId}`;
    this.browseUrl = `https://codesandbox.io/p/devbox/${devboxId}`;
  }

  private async open(log: Logger): Promise<Devbox> {
    if (!this.devbox) {
      log("Connecting to Devbox…");
      const sdk = new CodeSandbox(requireToken());
      this.devbox = await sdk.sandbox.open(this.devboxId);
    }
    return this.devbox;
  }

  async list(log: Logger): Promise<RemoteZip[]> {
    const devbox = await this.open(log);
    let entries: Array<{ type: string; name: string }>;
    try {
      entries = await devbox.fs.readdir(this.remoteDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not found") || message.includes("ENOENT")) {
        return [];
      }
      throw error;
    }

    const zipFiles: RemoteZip[] = [];
    for (const entry of entries) {
      if (entry.type === "file" && entry.name.endsWith(".zip")) {
        const fullPath = normalizeRemotePath(this.remoteDir, entry.name);
        const stat = await devbox.fs.stat(fullPath);
        zipFiles.push({
          name: entry.name,
          path: fullPath,
          size: stat.size,
          mtime: stat.mtime,
        });
      }
    }
    zipFiles.sort((a, b) => b.mtime - a.mtime);
    return zipFiles;
  }

  async put(name: string, data: Buffer, log: Logger): Promise<string> {
    const devbox = await this.open(log);
    await devbox.fs.mkdir(this.remoteDir, true);

    const remotePath = normalizeRemotePath(this.remoteDir, name);
    log(`  Writing ${data.length} bytes to remote...`);
    await devbox.fs.writeFile(remotePath, new Uint8Array(data));
    log(`  Write operation completed`);

    log("Verifying upload (this ensures file is fully written)…");
    await this.verify(devbox, remotePath, data.length, log);
    return remotePath;
  }

  /**
   * A devbox write can report success before the bytes land, so the size is
   * re-checked with backoff until it matches.
   */
  private async verify(
    devbox: Devbox,
    remotePath: string,
    expectedSize: number,
    log: Logger,
    maxRetries = 10
  ): Promise<void> {
    log(`  Verifying upload (max ${maxRetries} attempts)...`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        log(`  Checking if file exists at: ${remotePath}`);
        const stat = await devbox.fs.stat(remotePath);

        if (stat.type !== "file") {
          throw new Error(`Remote path is not a file: ${stat.type}`);
        }

        log(`    Remote size: ${stat.size} bytes (expected: ${expectedSize} bytes)`);
        if (stat.size !== expectedSize) {
          if (attempt < maxRetries) {
            log(`    Size mismatch, waiting 3s before retry...`);
            await sleep(3000);
            continue;
          }
          throw new Error(
            `Size mismatch! Expected ${expectedSize} bytes, got ${stat.size} bytes`
          );
        }

        log(`  ✓ Size matches!`);
        return;
      } catch (error) {
        if (attempt < maxRetries) {
          log(`    Error: ${error instanceof Error ? error.message : String(error)}`);
          log(`    Waiting 3s before retry...`);
          await sleep(3000);
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Failed to verify upload after ${maxRetries} attempts`);
  }

  async get(zip: RemoteZip, log: Logger): Promise<Buffer> {
    const devbox = await this.open(log);
    log(`  Getting download URL...`);
    const downloadInfo = await devbox.fs.download(zip.path);
    log(`  ✓ Got download URL`);

    const buffer = await downloadBufferFromUrl(downloadInfo.downloadUrl, 3, log);
    if (buffer) {
      return buffer;
    }
    log(`  Falling back to readFile over Devbox connection…`);
    return Buffer.from(await devbox.fs.readFile(zip.path));
  }

  async remove(zip: RemoteZip, log: Logger): Promise<void> {
    const devbox = await this.open(log);
    await devbox.fs.remove(zip.path, false);
  }

  close(log: Logger): void {
    if (!this.devbox) {
      return;
    }
    log("Disconnecting…");
    // Fire-and-forget disconnect to avoid hanging
    try {
      this.devbox.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    this.devbox = null;
  }
}
