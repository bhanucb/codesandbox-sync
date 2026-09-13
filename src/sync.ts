import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import type { ResolvedApp } from "./config.js";
import { sanitizeAppName } from "./config.js";
import { prepareDownloadDir } from "./preserve.js";
import { createStorage } from "./storage/index.js";
import type { RemoteZip, Storage } from "./storage/types.js";
import {
  calculateChecksum,
  calculateFileChecksum,
  createZip,
  type Logger,
} from "./zip.js";

const MAX_SERVER_FILES = 3;
const noopLog: Logger = () => {};

export type { RemoteZip } from "./storage/types.js";

type RemoteInfo = {
  /** Human-readable description of where the ZIPs live. */
  remoteLocation: string;
  /** A URL a human can open. */
  browseUrl?: string;
};

export type UploadResult = RemoteInfo & {
  app: string;
  zipFileName: string;
  sizeBytes: number;
  sizeMb: string;
  checksum: string;
  localZipPath: string;
  remotePath?: string;
  excluded: string[];
  dryRun: boolean;
};

export type DownloadResult = RemoteInfo & {
  app: string;
  zipFileName: string;
  sizeBytes: number;
  sizeMb: string;
  checksum: string;
  extractedTo: string;
  extracted: boolean;
  preserved: string[];
  remoteZips: RemoteZip[];
};

function toMb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

export function mtimeToDate(mtime: number): Date {
  return new Date(mtime);
}

function remoteInfo(storage: Storage): RemoteInfo {
  return {
    remoteLocation: storage.location,
    browseUrl: storage.browseUrl,
  };
}

/**
 * Keeps the newest `keepCount` ZIPs and drops the rest. Failure here is never
 * fatal: the upload has already succeeded by this point.
 */
async function cleanupOldFiles(
  storage: Storage,
  keepCount: number,
  log: Logger
): Promise<void> {
  log(`\nCleaning up old files (keeping ${keepCount} most recent)...`);

  try {
    const zipFiles = await storage.list(log);
    if (zipFiles.length <= keepCount) {
      log(`  ✓ Only ${zipFiles.length} file(s) exist, no cleanup needed`);
      return;
    }

    const filesToDelete = zipFiles.slice(keepCount);
    log(`  Found ${zipFiles.length} file(s), deleting ${filesToDelete.length} oldest:`);
    for (const file of filesToDelete) {
      log(`    - Deleting: ${file.name}`);
      await storage.remove(file, log);
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
  if (app.include.length > 0) {
    log(`  Included anyway: ${app.include.join(", ")}`);
  }
  const { zipPath, zipFileName, sizeBytes } = await createZip(
    app.sourceDir,
    sanitizeAppName(app.name),
    app.exclude,
    app.include,
    log
  );
  const sizeMb = toMb(sizeBytes);
  log(`ZIP created: ${zipFileName} (size ${sizeMb} MB)`);

  log("Calculating local file checksum...");
  const checksum = calculateFileChecksum(zipPath);
  log(`  Checksum: ${checksum}`);

  const base = {
    app: app.name,
    zipFileName,
    sizeBytes,
    sizeMb,
    checksum,
    localZipPath: zipPath,
    excluded: [...app.exclude],
    dryRun,
  };

  if (dryRun) {
    log("Dry run — skipping upload.");
    return { ...base, remoteLocation: app.remotePrefix };
  }

  const storage = createStorage(app);
  try {
    log(`Uploading ZIP to ${storage.location}…`);
    const zipBuffer = fs.readFileSync(zipPath);
    const remotePath = await storage.put(zipFileName, zipBuffer, log);

    await cleanupOldFiles(storage, MAX_SERVER_FILES, log);

    const result: UploadResult = {
      ...base,
      ...remoteInfo(storage),
      remotePath,
    };
    log("\n✅ UPLOAD VERIFIED SUCCESSFULLY!");
    log(`   File: ${remotePath}`);
    log(`   Size: ${sizeMb} MB`);
    log(`   Checksum: ${checksum}`);
    if (storage.browseUrl) {
      log(`\n💡 Browse: ${storage.browseUrl}`);
    }
    return result;
  } finally {
    storage.close(log);
  }
}

/**
 * The download tail, shared by every source: reset the directory (preserving
 * what the upload omits), write the ZIP, verify, extract. `sourceLabel` is
 * whatever produced the bytes — a bucket, a local file, a URL — so the result
 * and logs read the same regardless.
 */
async function extractIntoApp(
  app: ResolvedApp,
  zipName: string,
  buffer: Buffer,
  sourceLabel: string,
  log: Logger
): Promise<Omit<DownloadResult, "remoteZips" | "browseUrl">> {
  const localDir = app.downloadDir;
  if (!localDir) {
    throw new Error(
      `App "${app.name}" has no downloadDir configured — set one with update_app first`
    );
  }

  log(`\nPreparing download directory...`);
  const preserved = prepareDownloadDir(localDir, {
    log,
    preserveNodeModules: app.preserveNodeModules,
    // Whatever the upload leaves out must survive the reset — the ZIP cannot
    // restore it. What `include` puts back into the ZIP must not be preserved,
    // or stale files would sit under the extracted ones.
    preservePatterns: app.exclude,
    includePatterns: app.include,
  });

  const localPath = path.join(localDir, zipName);
  log(`\nSaving to ${localDir}...`);
  fs.writeFileSync(localPath, buffer);

  log(`  Verifying file...`);
  const localBuffer = fs.readFileSync(localPath);
  const checksum = calculateChecksum(localBuffer);
  log(`  Checksum: ${checksum}`);

  let extracted = false;
  log(`\nUnzipping to ${localDir}...`);
  try {
    new AdmZip(localPath).extractAllTo(localDir, true);
    extracted = true;
    log(`  ✓ Extracted successfully`);
    fs.unlinkSync(localPath);
    log(`  ✓ Removed ${zipName}`);
  } catch (error) {
    log(`  ⚠️  Unzip failed: ${error instanceof Error ? error.message : String(error)}`);
    log(`  ZIP file kept at: ${localPath}`);
  }

  log("\n✅ EXTRACT SUCCESSFUL!");
  log(`   From: ${sourceLabel}`);
  log(`   Location: ${localDir}`);
  log(`   Size: ${toMb(localBuffer.length)} MB`);
  log(`   Checksum: ${checksum}`);

  return {
    app: app.name,
    remoteLocation: sourceLabel,
    zipFileName: zipName,
    sizeBytes: localBuffer.length,
    sizeMb: toMb(localBuffer.length),
    checksum,
    extractedTo: localDir,
    extracted,
    preserved,
  };
}

/**
 * Extract a ZIP already on disk — one the R2 API could not deliver, so it was
 * fetched some other way (the dashboard, an approved transfer, a USB drive).
 * The extract is identical to a normal download; only the source differs.
 */
export async function importZipFile(
  app: ResolvedApp,
  zipPath: string,
  options: { log?: Logger } = {}
): Promise<DownloadResult> {
  const log = options.log ?? noopLog;
  const resolved = path.resolve(zipPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`ZIP not found: ${resolved}`);
  }
  if (!resolved.toLowerCase().endsWith(".zip")) {
    throw new Error(`Not a .zip file: ${resolved}`);
  }
  log(`Importing ${resolved}`);
  const buffer = fs.readFileSync(resolved);
  const base = await extractIntoApp(app, path.basename(resolved), buffer, resolved, log);
  return { ...base, remoteZips: [] };
}

/**
 * Fetch a ZIP from an arbitrary URL, then extract it. Meant for a dashboard
 * download link on a reachable host when the S3 endpoint is blocked. Only
 * self-contained URLs work — anything relying on the browser's session cookies
 * will not.
 */
export async function downloadFromUrl(
  app: ResolvedApp,
  url: string,
  options: { log?: Logger } = {}
): Promise<DownloadResult> {
  const log = options.log ?? noopLog;
  log(`Fetching ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${response.statusText} fetching the URL. If this is a dashboard link, it may have expired or need your browser session — download the file and use --file instead.`
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (/text\/html/i.test(contentType)) {
    throw new Error(
      `The URL returned HTML, not a ZIP (content-type: ${contentType}). A proxy or login page answered instead of the file — download it in the browser and use --file instead.`
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const name = zipNameFromUrl(url, app);
  const base = await extractIntoApp(app, name, buffer, url, log);
  return { ...base, remoteZips: [] };
}

/** A sensible on-disk name for a fetched ZIP: the URL's filename, else app_<ts>. */
function zipNameFromUrl(url: string, app: ResolvedApp): string {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split("/").filter(Boolean).pop() ?? "";
    const decoded = decodeURIComponent(last);
    if (decoded.toLowerCase().endsWith(".zip")) {
      return decoded;
    }
  } catch {
    // fall through
  }
  return `${sanitizeAppName(app.name)}_${Date.now()}.zip`;
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

  const storage = createStorage(app);
  try {
    log(`\nListing files in ${storage.location}...`);
    const zipFiles = await storage.list(log);
    if (zipFiles.length === 0) {
      throw new Error(`No ZIP files found in ${storage.location}`);
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
      // cannot restore it. What `include` puts back into the ZIP must not be
      // preserved, or stale files would sit under the extracted ones.
      preservePatterns: app.exclude,
      includePatterns: app.include,
    });

    log(`\nDownloading latest: ${latestFile.name}...`);
    log(`  Size: ${toMb(latestFile.size)} MB`);
    const remoteBuffer = await storage.get(latestFile, log);

    log(`  Downloaded: ${toMb(remoteBuffer.length)} MB`);
    log(`  Saving to ${localDir}...`);
    const localPath = path.join(localDir, latestFile.name);
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
      ...remoteInfo(storage),
      zipFileName: latestFile.name,
      sizeBytes: localBuffer.length,
      sizeMb: toMb(localBuffer.length),
      checksum,
      extractedTo: localDir,
      extracted,
      preserved,
      remoteZips: zipFiles,
    };
  } finally {
    storage.close(log);
  }
}

export async function listRemoteZips(
  app: ResolvedApp,
  options: { log?: Logger } = {}
): Promise<RemoteZip[]> {
  const log = options.log ?? noopLog;
  const storage = createStorage(app);
  try {
    log(`\n📂 ZIP files in ${storage.location}:\n`);
    const zipFiles = await storage.list(log);

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
    storage.close(log);
  }
}
