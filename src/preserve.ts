import fs from "fs";
import path from "path";
import { zipEntryMatchesExclude, type Logger } from "./zip.js";

/**
 * Kept regardless of configuration: local git metadata that is not part of the
 * uploaded tree. Not editor- or assistant-specific.
 */
const ALWAYS_PRESERVED = [".git/info/exclude"] as const;

const NODE_MODULES = "node_modules";

function shouldPreserveNodeModules(override?: boolean): boolean {
  if (override !== undefined) {
    return override;
  }
  const raw = process.env.PRESERVE_NODE_MODULES;
  if (raw === undefined) {
    return true;
  }
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/**
 * The reset must not destroy anything the upload refused to carry — otherwise a
 * download silently deletes local state that no ZIP can restore. So whatever is
 * excluded from the archive is preserved here, which keeps this tool-agnostic:
 * no editor or assistant is named, the exclude list decides.
 */
export function buildPreservePatterns(
  excludePatterns: readonly string[],
  preserveNodeModules?: boolean
): string[] {
  const keepNodeModules = shouldPreserveNodeModules(preserveNodeModules);
  const patterns = excludePatterns.filter(
    (p) => keepNodeModules || p !== NODE_MODULES
  );
  const seen = new Set<string>();
  return [...patterns, ...ALWAYS_PRESERVED].filter((p) => {
    if (seen.has(p)) {
      return false;
    }
    seen.add(p);
    return true;
  });
}

/**
 * Walks the tree and returns the relative paths that must survive the reset.
 * Preserved directories are never descended into, so a monorepo with many
 * nested node_modules stays cheap to scan.
 */
export function findPreservedEntries(
  root: string,
  patterns: readonly string[]
): string[] {
  const found: string[] = [];

  const walk = (relDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (zipEntryMatchesExclude(rel, patterns)) {
        found.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        walk(rel);
      }
    }
  };

  walk("");
  return found;
}

function collectAncestors(relativePaths: readonly string[]): Set<string> {
  const ancestors = new Set<string>();
  for (const rel of relativePaths) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      ancestors.add(parts.slice(0, i).join("/"));
    }
  }
  return ancestors;
}

/**
 * Deletes everything under `root` except the preserved entries and the
 * directories that contain them.
 */
function pruneDirectory(
  root: string,
  keep: ReadonlySet<string>,
  ancestors: ReadonlySet<string>,
  relDir = ""
): void {
  const entries = fs.readdirSync(path.join(root, relDir), {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (keep.has(rel)) {
      continue;
    }
    if (ancestors.has(rel)) {
      pruneDirectory(root, keep, ancestors, rel);
      continue;
    }
    fs.rmSync(path.join(root, rel), { recursive: true, force: true });
  }
}

export type PrepareOptions = {
  log?: Logger;
  preserveNodeModules?: boolean;
  /** Usually the app's ZIP exclude patterns; same matching syntax. */
  preservePatterns?: readonly string[];
};

/** Resets `localDir` to empty, keeping preserved entries. Returns what survived. */
export function prepareDownloadDir(
  localDir: string,
  options: PrepareOptions = {}
): string[] {
  const log = options.log ?? ((message: string) => console.log(message));
  const patterns = buildPreservePatterns(
    options.preservePatterns ?? [NODE_MODULES],
    options.preserveNodeModules
  );

  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true });
    log(`  ✓ Directory ready`);
    return [];
  }

  log(`  Cleaning existing directory: ${localDir}`);
  if (!patterns.includes(NODE_MODULES)) {
    log(`  node_modules will be removed (PRESERVE_NODE_MODULES is off)`);
  }

  const preserved = findPreservedEntries(localDir, patterns);
  const keep = new Set(preserved);
  const ancestors = collectAncestors(preserved);

  pruneDirectory(localDir, keep, ancestors);

  const nodeModules = preserved.filter((rel) => rel.split("/").pop() === NODE_MODULES);
  for (const rel of preserved) {
    if (!nodeModules.includes(rel)) {
      log(`  ✓ Preserved ${rel}`);
    }
  }
  if (nodeModules.length > 0) {
    log(
      `  ✓ Preserved ${nodeModules.length} node_modules director${
        nodeModules.length === 1 ? "y" : "ies"
      }`
    );
  }
  log(`  ✓ Directory cleaned`);
  log(`  ✓ Directory ready`);
  return preserved;
}
