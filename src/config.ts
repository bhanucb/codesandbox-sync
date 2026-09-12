import fs from "fs";
import path from "path";
import { configPath } from "./paths.js";

export type AppEntry = {
  sourceDir: string;
  /** Object key prefix in the bucket. Defaults to the app name. */
  remotePrefix?: string;
  downloadDir?: string;
  exclude?: string[];
};

/** Everything needed to reach an R2 bucket. Secrets come from the environment. */
export type R2Settings = {
  bucket: string;
  accountId: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type SyncConfig = {
  defaults: {
    /** R2 connection settings, credentials included. */
    r2?: {
      bucket?: string;
      accountId?: string;
      endpoint?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
    };
    /** App used by the `npm run …` scripts when --app is omitted. */
    app?: string;
    exclude?: string[];
    preserveNodeModules?: boolean;
  };
  apps: Record<string, AppEntry>;
};

export type ResolvedApp = {
  name: string;
  sourceDir: string;
  /** Objects land at "<remotePrefix>/<app>_<timestamp>.zip". */
  remotePrefix: string;
  downloadDir?: string;
  r2: R2Settings;
  exclude: string[];
  /** Undefined when unset in config, so PRESERVE_NODE_MODULES can decide. */
  preserveNodeModules?: boolean;
};

const ALWAYS_EXCLUDED = ["node_modules", ".next"] as const;

/**
 * Dot-directories and dot-files belonging to LLM coding assistants. These hold
 * local session state, transcripts and prompts that have no business being
 * uploaded to shared storage, so they are excluded from every app's ZIP.
 * Patterns support a trailing `*` (see zipEntryMatchesExclude).
 *
 * Microsoft Copilot is the deliberate exception: nothing here matches
 * `.github/copilot-instructions.md` or `.vscode/`, and any path containing
 * "copilot" is kept even if one of these patterns would otherwise match it.
 */
export const LLM_EXCLUDE_PATTERNS = [
  ".claude*",
  ".cursor*",
  ".aider*",
  ".windsurf*",
  ".cline*",
  ".roo*",
  ".roomodes",
  ".continue",
  ".codeium*",
  ".gemini*",
  ".goose*",
  ".opencode*",
  ".augment*",
  ".tabnine*",
  ".specstory",
  ".crush*",
  ".amazonq*",
  ".kiro*",
  ".junie*",
  ".qodo*",
  ".cody*",
  ".devin*",
  ".sourcegraph",
  ".openai*",
  ".llm*",
  ".mcp.json",
] as const;

const LLM_PATTERN_SET: ReadonlySet<string> = new Set(LLM_EXCLUDE_PATTERNS);

/** True when the LLM exclusions should not apply to this pattern's match. */
export function isLlmExcludePattern(pattern: string): boolean {
  return LLM_PATTERN_SET.has(pattern);
}

/** Microsoft Copilot artifacts are explicitly allowed through. */
export function isCopilotPath(relativePath: string): boolean {
  return /copilot/i.test(relativePath);
}
export function sanitizeAppName(raw: string): string {
  const sanitized = raw
    .trim()
    .replace(/[/\\]+/g, "-")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!sanitized) {
    throw new Error(
      "App name must resolve to a non-empty value (use letters, numbers, hyphens, or underscores)"
    );
  }
  return sanitized;
}

export function assertSafeExcludePattern(pattern: string): void {
  const posix = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = posix.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "..")) {
    throw new Error(`exclude: invalid pattern "${pattern}" (cannot contain "..")`);
  }
}

function normalizeExcludePattern(pattern: string): string {
  return pattern
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "");
}

export function dedupeStrings(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of items) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function parseExcludeList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${label}: each entry must be a string`);
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      continue;
    }
    assertSafeExcludePattern(trimmed);
    out.push(normalizeExcludePattern(trimmed));
  }
  return dedupeStrings(out);
}

/** A key prefix is a relative, slash-separated path with no traversal. */
export function normalizePrefix(prefix: string, label: string): string {
  assertSafeExcludePattern(prefix);
  const normalized = prefix
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/g, "");
  if (normalized.length === 0) {
    throw new Error(`${label} cannot be empty`);
  }
  return normalized;
}

function parseAppEntry(name: string, raw: unknown): AppEntry {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`apps."${name}" must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const sourceDir = obj.sourceDir;
  if (typeof sourceDir !== "string" || sourceDir.trim().length === 0) {
    throw new Error(`apps."${name}".sourceDir is required`);
  }
  const entry: AppEntry = { sourceDir: path.resolve(sourceDir.trim()) };

  const remotePrefix = obj.remotePrefix;
  if (remotePrefix !== undefined && typeof remotePrefix !== "string") {
    throw new Error(`apps."${name}".remotePrefix must be a string`);
  }
  if (typeof remotePrefix === "string" && remotePrefix.trim().length > 0) {
    entry.remotePrefix = normalizePrefix(
      remotePrefix.trim(),
      `apps."${name}".remotePrefix`
    );
  }
  if (typeof obj.downloadDir === "string" && obj.downloadDir.trim().length > 0) {
    entry.downloadDir = path.resolve(obj.downloadDir.trim());
  }
  const exclude = parseExcludeList(obj.exclude, `apps."${name}".exclude`);
  if (exclude.length > 0) {
    entry.exclude = exclude;
  }
  return entry;
}

export function loadConfig(): SyncConfig {
  const file = configPath();
  if (!fs.existsSync(file)) {
    return { defaults: {}, apps: {} };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid JSON in ${file}: ${msg}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${file} must be a JSON object with "defaults" and "apps"`);
  }

  const obj = raw as Record<string, unknown>;
  const defaultsRaw = obj.defaults;
  if (
    defaultsRaw !== undefined &&
    (defaultsRaw === null || typeof defaultsRaw !== "object" || Array.isArray(defaultsRaw))
  ) {
    throw new Error(`${file}: "defaults" must be an object`);
  }
  const d = (defaultsRaw ?? {}) as Record<string, unknown>;
  const defaults: SyncConfig["defaults"] = {};

  if (typeof d.app === "string" && d.app.trim().length > 0) {
    defaults.app = d.app.trim();
  }

  if (d.r2 !== undefined) {
    if (d.r2 === null || typeof d.r2 !== "object" || Array.isArray(d.r2)) {
      throw new Error(`${file}: "defaults.r2" must be an object`);
    }
    const r2Raw = d.r2 as Record<string, unknown>;
    const r2: NonNullable<SyncConfig["defaults"]["r2"]> = {};
    for (const key of [
      "bucket",
      "accountId",
      "endpoint",
      "accessKeyId",
      "secretAccessKey",
    ] as const) {
      const value = r2Raw[key];
      if (typeof value === "string" && value.trim().length > 0) {
        r2[key] = value.trim();
      }
    }
    if (Object.keys(r2).length > 0) {
      defaults.r2 = r2;
    }
  }

  const defaultExclude = parseExcludeList(d.exclude, `${file}: defaults.exclude`);
  if (defaultExclude.length > 0) {
    defaults.exclude = defaultExclude;
  }
  if (typeof d.preserveNodeModules === "boolean") {
    defaults.preserveNodeModules = d.preserveNodeModules;
  }

  const appsRaw = obj.apps;
  if (
    appsRaw !== undefined &&
    (appsRaw === null || typeof appsRaw !== "object" || Array.isArray(appsRaw))
  ) {
    throw new Error(`${file}: "apps" must be an object keyed by app name`);
  }
  const apps: Record<string, AppEntry> = {};
  for (const [name, entry] of Object.entries((appsRaw ?? {}) as Record<string, unknown>)) {
    apps[name] = parseAppEntry(name, entry);
  }

  return { defaults, apps };
}

export function saveConfig(config: SyncConfig): void {
  const file = configPath();
  const ordered: SyncConfig = {
    defaults: config.defaults,
    apps: Object.fromEntries(
      Object.keys(config.apps)
        .sort()
        .map((name) => [name, config.apps[name]])
    ),
  };
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function resolveExcludes(entry: AppEntry, config: SyncConfig): string[] {
  return dedupeStrings([
    ...ALWAYS_EXCLUDED,
    ...LLM_EXCLUDE_PATTERNS,
    ...(config.defaults.exclude ?? []),
    ...(entry.exclude ?? []),
  ]);
}

/**
 * apps.json is the single source of configuration. Real environment variables
 * still win where they are set, which keeps CI and one-off overrides working
 * without a second config file to maintain.
 */
export function requireR2Settings(name: string, config: SyncConfig): R2Settings {
  const missing: string[] = [];
  const need = (value: string | undefined, label: string): string => {
    const trimmed = value?.trim();
    if (!trimmed) {
      missing.push(label);
      return "";
    }
    return trimmed;
  };

  const r2 = config.defaults.r2;
  const bucket = need(process.env.R2_BUCKET || r2?.bucket, "defaults.r2.bucket");
  const accountId = need(
    process.env.R2_ACCOUNT_ID || r2?.accountId,
    "defaults.r2.accountId"
  );
  const accessKeyId = need(
    process.env.R2_ACCESS_KEY_ID || r2?.accessKeyId,
    "defaults.r2.accessKeyId"
  );
  const secretAccessKey = need(
    process.env.R2_SECRET_ACCESS_KEY || r2?.secretAccessKey,
    "defaults.r2.secretAccessKey"
  );

  if (missing.length > 0) {
    throw new Error(
      `App "${name}" cannot reach R2 — missing: ${missing.join(", ")} in ${configPath()}`
    );
  }

  const endpoint =
    process.env.R2_ENDPOINT?.trim() ||
    r2?.endpoint ||
    `https://${accountId}.r2.cloudflarestorage.com`;

  return { bucket, accountId, endpoint, accessKeyId, secretAccessKey };
}

export function toResolvedApp(
  name: string,
  entry: AppEntry,
  config: SyncConfig
): ResolvedApp {
  return {
    name,
    sourceDir: entry.sourceDir,
    remotePrefix: entry.remotePrefix ?? sanitizeAppName(name),
    downloadDir: entry.downloadDir,
    r2: requireR2Settings(name, config),
    exclude: resolveExcludes(entry, config),
    preserveNodeModules: config.defaults.preserveNodeModules,
  };
}

export function isInsideDir(parentDir: string, candidate: string): boolean {
  const rel = path.relative(parentDir, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export type ResolveOptions = {
  appName?: string;
  path?: string;
  config?: SyncConfig;
};

/**
 * Resolves an app by explicit name, or by finding the configured app whose
 * sourceDir contains the given path (defaults to cwd). Deepest match wins so
 * nested worktrees resolve to the most specific app.
 */
export function resolveApp(options: ResolveOptions = {}): ResolvedApp {
  const config = options.config ?? loadConfig();
  const names = Object.keys(config.apps).sort();

  if (options.appName) {
    const entry = config.apps[options.appName];
    if (!entry) {
      const known = names.length > 0 ? names.join(", ") : "(none configured)";
      throw new Error(`Unknown app "${options.appName}". Configured apps: ${known}`);
    }
    return toResolvedApp(options.appName, entry, config);
  }

  if (names.length === 0) {
    throw new Error(
      `No apps configured in ${configPath()}. Copy apps.example.json to apps.json and add one, or use --source for a one-off directory.`
    );
  }

  const hint = path.resolve(options.path ?? process.cwd());
  const matches = names.filter(
    (name) =>
      config.apps[name].sourceDir === hint ||
      isInsideDir(config.apps[name].sourceDir, hint)
  );

  if (matches.length === 0) {
    throw new Error(
      `No configured app matches path ${hint}. Pass app_name explicitly. Configured apps: ${names.join(", ")}`
    );
  }

  matches.sort(
    (a, b) => config.apps[b].sourceDir.length - config.apps[a].sourceDir.length
  );
  const [best, next] = matches;
  if (
    next &&
    config.apps[next].sourceDir.length === config.apps[best].sourceDir.length
  ) {
    throw new Error(
      `Path ${hint} matches multiple apps: ${matches.join(", ")}. Pass app_name explicitly.`
    );
  }
  return toResolvedApp(best, config.apps[best], config);
}

export type AppInput = {
  sourceDir: string;
  remotePrefix?: string | null;
  downloadDir?: string | null;
  exclude?: string[] | null;
};

function validateSourceDir(sourceDir: string): string {
  const resolved = path.resolve(sourceDir.trim());
  if (!fs.existsSync(resolved)) {
    throw new Error(`Source directory not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Source path is not a directory: ${resolved}`);
  }
  return resolved;
}

export function addApp(name: string, input: AppInput): ResolvedApp {
  const config = loadConfig();
  const appName = sanitizeAppName(name);
  if (config.apps[appName]) {
    throw new Error(`App "${appName}" already exists — use update_app to modify it`);
  }

  const entry: AppEntry = { sourceDir: validateSourceDir(input.sourceDir) };
  if (input.remotePrefix) {
    entry.remotePrefix = normalizePrefix(
      input.remotePrefix,
      `remotePrefix for "${appName}"`
    );
  }
  if (input.downloadDir) {
    entry.downloadDir = path.resolve(input.downloadDir.trim());
  }
  const exclude = parseExcludeList(input.exclude ?? undefined, `exclude for "${appName}"`);
  if (exclude.length > 0) {
    entry.exclude = exclude;
  }

  config.apps[appName] = entry;
  saveConfig(config);
  return toResolvedApp(appName, entry, config);
}

export function updateApp(name: string, patch: Partial<AppInput>): ResolvedApp {
  const config = loadConfig();
  const entry = config.apps[name];
  if (!entry) {
    const known = Object.keys(config.apps).sort().join(", ") || "(none configured)";
    throw new Error(`Unknown app "${name}". Configured apps: ${known}`);
  }

  const updated: AppEntry = { ...entry };
  if (patch.sourceDir !== undefined) {
    updated.sourceDir = validateSourceDir(patch.sourceDir);
  }
  if (patch.remotePrefix !== undefined) {
    if (patch.remotePrefix === null || patch.remotePrefix.trim() === "") {
      delete updated.remotePrefix;
    } else {
      updated.remotePrefix = normalizePrefix(
        patch.remotePrefix,
        `remotePrefix for "${name}"`
      );
    }
  }
  if (patch.downloadDir !== undefined) {
    if (patch.downloadDir === null || patch.downloadDir.trim() === "") {
      delete updated.downloadDir;
    } else {
      updated.downloadDir = path.resolve(patch.downloadDir.trim());
    }
  }
  if (patch.exclude !== undefined) {
    const exclude = parseExcludeList(patch.exclude ?? undefined, `exclude for "${name}"`);
    if (exclude.length > 0) {
      updated.exclude = exclude;
    } else {
      delete updated.exclude;
    }
  }

  config.apps[name] = updated;
  saveConfig(config);
  return toResolvedApp(name, updated, config);
}

export function removeApp(name: string): void {
  const config = loadConfig();
  if (!config.apps[name]) {
    const known = Object.keys(config.apps).sort().join(", ") || "(none configured)";
    throw new Error(`Unknown app "${name}". Configured apps: ${known}`);
  }
  delete config.apps[name];
  saveConfig(config);
}

export type AppListing = {
  name: string;
  sourceDir: string;
  remotePrefix: string;
  downloadDir?: string;
  exclude?: string[];
  sourceExists: boolean;
  /** Set when the entry cannot be resolved, e.g. missing R2 credentials. */
  error?: string;
};

/** Never throws: a broken entry is reported, so the list stays diagnosable. */
export function listApps(): AppListing[] {
  const config = loadConfig();
  return Object.keys(config.apps)
    .sort()
    .map((name) => {
      const entry = config.apps[name];
      const listing: AppListing = {
        name,
        sourceDir: entry.sourceDir,
        remotePrefix: entry.remotePrefix ?? sanitizeAppName(name),
        downloadDir: entry.downloadDir,
        sourceExists: fs.existsSync(entry.sourceDir),
      };
      try {
        listing.exclude = toResolvedApp(name, entry, config).exclude;
      } catch (error) {
        listing.error = error instanceof Error ? error.message : String(error);
      }
      return listing;
    });
}
