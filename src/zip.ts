import fs from "fs";
import path from "path";
import crypto from "crypto";
import archiver from "archiver";
import { isCopilotPath, isInsideDir, isLlmExcludePattern } from "./config.js";
import { OUTPUT_DIR } from "./paths.js";

export type Logger = (message: string) => void;

export function normalizeZipEntryPath(relativeEntryName: string): string {
  return relativeEntryName.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Matches a single path segment against a pattern that may end in `*`. */
function segmentMatches(segment: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return segment === pattern;
  }
  const prefix = pattern.slice(0, pattern.indexOf("*"));
  return segment.startsWith(prefix);
}

export type ExcludeMatch = {
  /** The pattern that matched. */
  pattern: string;
  /** The path segment it matched (the whole prefix for slash patterns). */
  segment: string;
};

/**
 * Returns the exclude pattern that matches this entry, or null. Patterns
 * containing a slash match a path prefix; single-segment patterns match any
 * path segment and may end in `*`.
 */
export function matchExcludePattern(
  relativeEntryName: string,
  patterns: readonly string[]
): ExcludeMatch | null {
  const posix = normalizeZipEntryPath(relativeEntryName);
  for (const raw of patterns) {
    const p = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/g, "");
    if (p.length === 0) {
      continue;
    }
    if (p.includes("/")) {
      if (posix === p || posix.startsWith(`${p}/`)) {
        return { pattern: raw, segment: p };
      }
    } else {
      const segments = posix.split("/").filter((s) => s.length > 0);
      const hit = segments.find((segment) => segmentMatches(segment, p));
      if (hit !== undefined) {
        return { pattern: raw, segment: hit };
      }
    }
  }
  return null;
}

export function zipEntryMatchesExclude(
  relativeEntryName: string,
  patterns: readonly string[]
): boolean {
  const match = matchExcludePattern(relativeEntryName, patterns);
  if (match === null) {
    return false;
  }
  // Microsoft Copilot artifacts are allowed through the LLM exclusions — but
  // only when the matched segment is itself Copilot-related. A copilot file
  // buried inside .claude/ stays excluded along with the rest of that tree.
  if (isLlmExcludePattern(match.pattern) && isCopilotPath(match.segment)) {
    return false;
  }
  return true;
}

export function calculateChecksum(data: Buffer): string {
  return crypto.createHash("md5").update(data).digest("hex");
}

export function calculateFileChecksum(filePath: string): string {
  return calculateChecksum(fs.readFileSync(filePath));
}

export function cleanupOldZips(outputDir: string, keepCount: number): void {
  const entries = fs
    .readdirSync(outputDir)
    .filter((name) => name.endsWith(".zip"))
    .map((name) => {
      const fullPath = path.join(outputDir, name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const entry of entries.slice(keepCount)) {
    fs.unlinkSync(entry.fullPath);
  }
}

export async function createZip(
  sourceDir: string,
  zipPrefix: string,
  excludePatterns: readonly string[],
  log: Logger
): Promise<{ zipPath: string; zipFileName: string; sizeBytes: number }> {
  const zipFileName = `${zipPrefix}_${Date.now()}.zip`;
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const zipPath = path.join(OUTPUT_DIR, zipFileName);
  const resolvedSourceDir = path.resolve(sourceDir);

  // When SOURCE_DIR contains the output directory (e.g. zipping this repo
  // itself), archiver would otherwise walk into output/ and stream the archive
  // it is currently writing back into itself, growing without bound. Skip any
  // entry that resolves into the output directory.
  const outputInsideSource = isInsideDir(resolvedSourceDir, OUTPUT_DIR);
  if (outputInsideSource) {
    log(
      `  Excluding ZIP output directory (inside source): ${path
        .relative(resolvedSourceDir, OUTPUT_DIR)
        .split(path.sep)
        .join("/")}`
    );
  }

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);

    archive.directory(resolvedSourceDir, false, (entry) => {
      const absolute = path.resolve(
        resolvedSourceDir,
        normalizeZipEntryPath(entry.name)
      );
      if (absolute === OUTPUT_DIR || absolute === zipPath) {
        return false;
      }
      if (outputInsideSource && isInsideDir(OUTPUT_DIR, absolute)) {
        return false;
      }
      if (zipEntryMatchesExclude(entry.name, excludePatterns)) {
        return false;
      }
      return entry;
    });

    archive.pipe(output);
    void archive.finalize();
  });

  const stats = fs.statSync(zipPath);
  cleanupOldZips(OUTPUT_DIR, 2);
  return { zipPath, zipFileName, sizeBytes: stats.size };
}
