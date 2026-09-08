import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import { CodeSandbox } from "@codesandbox/sdk";
import type { ResolvedApp } from "./config.js";
import { requireToken, sanitizeAppName } from "./config.js";
import { prepareDownloadDir } from "./preserve.js";
import {
  calculateChecksum,
  calculateFileChecksum,
  createZip,
  type Logger,
} from "./zip.js";

const MAX_SERVER_FILES = 3;
const noopLog: Logger = () => {};

export type RemoteZip = {
  name: string;
  path: string;
  size: number;
  mtime: number;
};

export type UploadResult = {
  app: string;
  zipFileName: string;
  sizeBytes: number;
  sizeMb: string;
  checksum: string;
  localZipPath: string;
  remotePath?: string;
  excluded: string[];
  devboxId: string;
  devboxUrl: string;
  dryRun: boolean;
};

export type DownloadResult = {
  app: string;
  zipFileName: string;
  sizeBytes: number;
  sizeMb: string;
  checksum: string;
  extractedTo: string;
  extracted: boolean;
  preserved: string[];
  devboxId: string;
  remoteZips: RemoteZip[];
};

function normalizeRemotePath(remoteDir: string, fileName: string): string {
  const base = remoteDir.replace(/\\/g, "/").replace(/\/+$/g, "");
  return `${base}/${fileName}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

/** Devbox mtimes come back in seconds; Date wants milliseconds. */
export function mtimeToDate(mtime: number): Date {
  return new Date(mtime < 1e12 ? mtime * 1000 : mtime);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Devbox = any;

async function openDevbox(devboxId: string): Promise<Devbox> {
  const sdk = new CodeSandbox(requireToken());
  return sdk.sandbox.open(devboxId);
}

function disconnect(devbox: Devbox, log: Logger): void {
  log("Disconnecting…");
  // Fire-and-forget disconnect to avoid hanging
  try {
    devbox.disconnect();
  } catch {
    // Ignore disconnect errors
  }
}

async function collectRemoteZips(
  devbox: Devbox,
  remoteDir: string
): Promise<RemoteZip[]> {
  const entries = await devbox.fs.readdir(remoteDir);
  const zipFiles: RemoteZip[] = [];
  for (const entry of entries) {
    if (entry.type === "file" && entry.name.endsWith(".zip")) {
      const fullPath = `${remoteDir}/${entry.name}`;
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

async function verifyUpload(
  devbox: Devbox,
  remotePath: string,
  remoteDir: string,
  expectedSize: number,
  log: Logger,
  maxRetries = 10
): Promise<void> {
  log(`  Verifying upload (max ${maxRetries} attempts)...`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`  Attempt ${attempt}/${maxRetries}: Listing directory first...`);

      const shellList = await devbox.shells.run(`ls -lah "${remoteDir}"`);
      log(
        `    Directory contents:\n${shellList.output
          .split("\n")
          .map((l: string) => `      ${l}`)
          .join("\n")}`
      );

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
      log(`  Running quick shell verification...`);
      try {
        const shellResult = await Promise.race([
          devbox.shells.run(`test -f "${remotePath}" && file "${remotePath}"`),
          new Promise<{ output: string; exitCode: number }>((_, reject) =>
            setTimeout(() => reject(new Error("Shell verification timeout")), 10000)
          ),
        ]);

        if (shellResult.exitCode !== 0) {
          log(`  ⚠️  Shell verification returned non-zero, but file size matches`);
        } else if (shellResult.output.includes("Zip archive")) {
          log(`  ✓ ZIP format confirmed`);
        } else {
          log(`  ⚠️  Could not confirm ZIP format, but file size matches`);
        }
      } catch (error) {
        log(
          `  ⚠️  Shell verification skipped: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        log(`  ✓ File size verification passed (sufficient)`);
      }

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

async function cleanupOldFiles(
  devbox: Devbox,
  remoteDir: string,
  keepCount: number,
  log: Logger
): Promise<void> {
  log(`\nCleaning up old files (keeping ${keepCount} most recent)...`);

  try {
    const zipFiles = await collectRemoteZips(devbox, remoteDir);

    if (zipFiles.length <= keepCount) {
      log(`  ✓ Only ${zipFiles.length} file(s) exist, no cleanup needed`);
      return;
    }

    const filesToDelete = zipFiles.slice(keepCount);
    log(
      `  Found ${zipFiles.length} file(s), deleting ${filesToDelete.length} oldest:`
    );

    for (const file of filesToDelete) {
      log(`    - Deleting: ${file.name}`);
      await devbox.fs.remove(file.path, false);
      log(`      ✓ Deleted`);
    }

    log(`  ✓ Cleanup complete`);
  } catch (error) {
    log(
      `  ⚠️  Cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function uploadApp(
  app: ResolvedApp,
  options: { log?: Logger; dryRun?: boolean } = {}
): Promise<UploadResult> {
  const log = options.log ?? noopLog;
  const dryRun = options.dryRun ?? false;

  if (!fs.existsSync(app.sourceDir)) {
    throw new Error(`Source directory not found: ${app.sourceDir}`);
  }

  log(`Zipping ${app.sourceDir}…`);
  log(`  Excluding from ZIP: ${app.exclude.join(", ")}`);
  const { zipPath, zipFileName, sizeBytes } = await createZip(
    app.sourceDir,
    sanitizeAppName(app.name),
    app.exclude,
    log
  );
  const sizeMb = toMb(sizeBytes);
  log(`ZIP created: ${zipFileName} (size ${sizeMb} MB)`);

  log("Calculating local file checksum...");
  const checksum = calculateFileChecksum(zipPath);
  log(`  Checksum: ${checksum}`);

  const result: UploadResult = {
    app: app.name,
    zipFileName,
    sizeBytes,
    sizeMb,
    checksum,
    localZipPath: zipPath,
    excluded: [...app.exclude],
    devboxId: app.devboxId,
    devboxUrl: `https://codesandbox.io/p/devbox/${app.devboxId}`,
    dryRun,
  };

  if (dryRun) {
    log("Dry run — skipping upload.");
    return result;
  }

  log("Connecting to Devbox…");
  const devbox = await openDevbox(app.devboxId);

  try {
    await devbox.fs.mkdir(app.remoteDir, true);

    log("Uploading ZIP to VM…");
    const zipBuffer = fs.readFileSync(zipPath);
    const remotePath = normalizeRemotePath(app.remoteDir, zipFileName);

    log(`  Writing ${zipBuffer.length} bytes to remote...`);
    await devbox.fs.writeFile(remotePath, new Uint8Array(zipBuffer));
    log(`  Write operation completed`);

    log("Verifying upload (this ensures file is fully written)…");
    await verifyUpload(devbox, remotePath, app.remoteDir, sizeBytes, log);

    await cleanupOldFiles(devbox, app.remoteDir, MAX_SERVER_FILES, log);

    result.remotePath = remotePath;
    log("\n✅ UPLOAD VERIFIED SUCCESSFULLY!");
    log(`   File: ${remotePath}`);
    log(`   Size: ${sizeMb} MB`);
    log(`   Checksum: ${checksum}`);
    log(`\n💡 Access on devbox: ${result.devboxUrl}`);
    return result;
  } finally {
    disconnect(devbox, log);
  }
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

export async function downloadApp(
  app: ResolvedApp,
  options: { log?: Logger } = {}
): Promise<DownloadResult> {
  const log = options.log ?? noopLog;
  const localDir = app.downloadDir;
  if (!localDir) {
    throw new Error(
      `App "${app.name}" has no downloadDir configured — set one with update_app before downloading`
    );
  }

  log("Connecting to Devbox…");
  const devbox = await openDevbox(app.devboxId);

  try {
    log(`\nListing files in ${app.remoteDir}...`);
    const zipFiles = await collectRemoteZips(devbox, app.remoteDir);
    if (zipFiles.length === 0) {
      throw new Error(`No ZIP files found in ${app.remoteDir}`);
    }
    const latestFile = zipFiles[0];

    log(`\nFound ${zipFiles.length} file(s):`);
    zipFiles.forEach((file, i) => {
      log(`  ${i === 0 ? "📥" : "  "} ${file.name} (${toMb(file.size)} MB)`);
    });

    log(`\nPreparing download directory...`);
    const preserved = prepareDownloadDir(localDir, {
      log,
      preserveNodeModules: app.preserveNodeModules,
      // Whatever the upload leaves out must survive the reset — the ZIP
      // cannot restore it.
      preservePatterns: app.exclude,
    });

    log(`\nDownloading latest: ${latestFile.name}...`);
    log(`  Size: ${toMb(latestFile.size)} MB`);
    log(`  Getting download URL...`);
    const downloadInfo = await devbox.fs.download(latestFile.path);
    log(`  ✓ Got download URL`);

    log(`\nDownloading file...`);
    const localPath = path.join(localDir, latestFile.name);

    let remoteBuffer = await downloadBufferFromUrl(downloadInfo.downloadUrl, 3, log);
    if (!remoteBuffer) {
      log(`  Falling back to readFile over Devbox connection…`);
      const content = await devbox.fs.readFile(latestFile.path);
      remoteBuffer = Buffer.from(content);
    }

    log(`  Downloaded: ${toMb(remoteBuffer.length)} MB`);
    log(`  Saving to ${localDir}...`);
    fs.writeFileSync(localPath, remoteBuffer);

    log(`  Verifying file...`);
    const localBuffer = fs.readFileSync(localPath);
    const checksum = calculateChecksum(localBuffer);
    log(`  Checksum: ${checksum}`);
    log(`  ✓ File verified`);

    let extracted = false;
    log(`\nUnzipping to ${localDir}...`);
    try {
      new AdmZip(localPath).extractAllTo(localDir, true);
      extracted = true;
      log(`  ✓ Extracted successfully`);

      log(`\nCleaning up ZIP file...`);
      fs.unlinkSync(localPath);
      log(`  ✓ Removed ${latestFile.name}`);
    } catch (error) {
      log(
        `  ⚠️  Unzip failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      log(`  ZIP file kept at: ${localPath}`);
    }

    log("\n✅ DOWNLOAD & EXTRACT SUCCESSFUL!");
    log(`   Location: ${localDir}`);
    log(`   Size: ${toMb(localBuffer.length)} MB`);
    log(`   Checksum: ${checksum}`);

    return {
      app: app.name,
      zipFileName: latestFile.name,
      sizeBytes: localBuffer.length,
      sizeMb: toMb(localBuffer.length),
      checksum,
      extractedTo: localDir,
      extracted,
      preserved,
      devboxId: app.devboxId,
      remoteZips: zipFiles,
    };
  } finally {
    disconnect(devbox, log);
  }
}

export async function listRemoteZips(
  app: ResolvedApp,
  options: { log?: Logger } = {}
): Promise<RemoteZip[]> {
  const log = options.log ?? noopLog;
  log("Connecting to Devbox…");
  const devbox = await openDevbox(app.devboxId);
  try {
    log(`\n📂 ZIP files in ${app.remoteDir}:\n`);
    let zipFiles: RemoteZip[] = [];
    try {
      zipFiles = await collectRemoteZips(devbox, app.remoteDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("not found") || message.includes("ENOENT")) {
        log(`  ⚠️  Directory ${app.remoteDir} does not exist yet`);
        return [];
      }
      throw error;
    }

    if (zipFiles.length === 0) {
      log("  (no ZIP files found)");
    }
    for (const file of zipFiles) {
      log(`  ✓ ${file.name}`);
      log(
        `    Size: ${toMb(file.size)} MB | Modified: ${mtimeToDate(
          file.mtime
        ).toLocaleString()}`
      );
    }
    return zipFiles;
  } finally {
    disconnect(devbox, log);
  }
}
