import fs from "fs";
import path from "path";
import { configPath, loadEnv } from "./paths.js";
import type { BackendKind } from "./storage/types.js";

export type AppEntry = {
  sourceDir: string;
  /** Devbox directory, or the R2 key prefix; defaults to the app name on R2. */
  remoteDir?: string;
  downloadDir?: string;
  devboxId?: string;
  backend?: BackendKind;
  exclude?: string[];
};

/** Everything needed to reach an R2 bucket. Secrets come from the environment. */
export type BackendOverride = BackendKind | undefined;

export type R2Settings = {
  bucket: string;
  accountId: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type SyncConfig = {
  defaults: {
    devboxId?: string;
    backend?: BackendKind;
    /** Non-secret R2 settings; credentials stay in the environment. */
    r2?: { bucket?: string; accountId?: string; endpoint?: string };
    /** Parent directory on the devbox for apps that don't set remoteDir. */
    remoteRoot?: string;
    exclude?: string[];
    preserveNodeModules?: boolean;
  };
  apps: Record<string, AppEntry>;
};

export type ResolvedApp = {
  name: string;
  sourceDir: string;
  /** Devbox directory, or the R2 key prefix. */
  remoteDir: string;
  downloadDir?: string;
  backend: BackendKind;
  /** Set only for the codesandbox backend. */
  devboxId?: string;
  /** Set only for the r2 backend. */
  r2?: R2Settings;
  exclude: string[];
  /** Undefined when unset in config, so PRESERVE_NODE_MODULES can decide. */
  preserveNodeModules?: boolean;
};

const ALWAYS_EXCLUDED = ["node_modules", ".next"] as const;

/**
 * Dot-directories and dot-files belonging to LLM coding assistants. These hold
 * local session state, transcripts and prompts that have no business being
 * uploaded to a shared devbox, so they are excluded from every app's ZIP.
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
const EMPTY_CONFIG: SyncConfig = { defaults: {}, apps: {} };

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

const BACKENDS: readonly BackendKind[] = ["codesandbox", "r2"];

function parseBackend(value: unknown, label: string): BackendKind | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || !BACKENDS.includes(value as BackendKind)) {
    throw new Error(`${label} must be one of: ${BACKENDS.join(", ")}`);
  }
  return value as BackendKind;
}

function parseAppEntry(name: string, raw: unknown): AppEntry {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`apps."${name}" must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const sourceDir = obj.sourceDir;
  const remoteDir = obj.remoteDir;
  if (typeof sourceDir !== "string" || sourceDir.trim().length === 0) {
    throw new Error(`apps."${name}".sourceDir is required`);
  }
  // remoteDir is optional: the r2 backend defaults it to the app name, and
  // toResolvedApp requires it only when the resolved backend is codesandbox.
  if (remoteDir !== undefined && typeof remoteDir !== "string") {
    throw new Error(`apps."${name}".remoteDir must be a string`);
  }
  const entry: AppEntry = {
    sourceDir: path.resolve(sourceDir.trim()),
  };
  if (typeof remoteDir === "string" && remoteDir.trim().length > 0) {
    entry.remoteDir = remoteDir.trim();
  }
  entry.backend = parseBackend(obj.backend, `apps."${name}".backend`);
  if (typeof obj.downloadDir === "string" && obj.downloadDir.trim().length > 0) {
    entry.downloadDir = path.resolve(obj.downloadDir.trim());
  }
  if (entry.backend === undefined) {
    delete entry.backend;
  }
  if (typeof obj.devboxId === "string" && obj.devboxId.trim().length > 0) {
    entry.devboxId = obj.devboxId.trim();
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
    return { defaults: { ...EMPTY_CONFIG.defaults }, apps: {} };
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
  if (defaultsRaw !== undefined && (defaultsRaw === null || typeof defaultsRaw !== "object" || Array.isArray(defaultsRaw))) {
    throw new Error(`${file}: "defaults" must be an object`);
  }
  const d = (defaultsRaw ?? {}) as Record<string, unknown>;
  const defaults: SyncConfig["defaults"] = {};
  if (typeof d.devboxId === "string" && d.devboxId.trim().length > 0) {
    defaults.devboxId = d.devboxId.trim();
  }
  if (typeof d.remoteRoot === "string" && d.remoteRoot.trim().length > 0) {
    defaults.remoteRoot = d.remoteRoot.trim().replace(/\/+$/g, "");
  }
  const backend = parseBackend(d.backend, `${file}: defaults.backend`);
  if (backend) {
    defaults.backend = backend;
  }
  if (d.r2 !== undefined) {
    if (d.r2 === null || typeof d.r2 !== "object" || Array.isArray(d.r2)) {
      throw new Error(`${file}: "defaults.r2" must be an object`);
    }
    const r2Raw = d.r2 as Record<string, unknown>;
    const r2: NonNullable<SyncConfig["defaults"]["r2"]> = {};
    for (const key of ["bucket", "accountId", "endpoint"] as const) {
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
  if (appsRaw !== undefined && (appsRaw === null || typeof appsRaw !== "object" || Array.isArray(appsRaw))) {
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

export function resolveDevboxId(
  entry: AppEntry,
  config: SyncConfig
): string | undefined {
  loadEnv();
  return entry.devboxId || config.defaults.devboxId || process.env.DEVBOX_ID;
}

/** Nothing that targets a CodeSandbox environment is defaulted in code. */
export function requireDevboxId(
  name: string,
  entry: AppEntry,
  config: SyncConfig
): string {
  const devboxId = resolveDevboxId(entry, config);
  if (!devboxId) {
    throw new Error(
      `No devbox id for "${name}". Set "devboxId" on the app or "defaults.devboxId" in apps.json, or DEVBOX_ID in the environment. Find it in the devbox URL: https://codesandbox.io/p/devbox/<devbox-id>`
    );
  }
  return devboxId;
}

/** Remote directory for a new app; never guessed from a built-in path. */
export function defaultRemoteDir(name: string, config: SyncConfig): string {
  const root = config.defaults.remoteRoot;
  if (!root) {
    throw new Error(
      `No remote directory for "${name}". Pass one explicitly, or set "defaults.remoteRoot" in apps.json (for example "/project/sandbox/apps") to derive it from the app name.`
    );
  }
  return `${root}/${name}`;
}

/** Which backend an app syncs through; codesandbox unless told otherwise. */
export function resolveBackend(entry: AppEntry, config: SyncConfig): BackendKind {
  loadEnv();
  const fromEnv = process.env.SYNC_BACKEND?.trim();
  if (fromEnv && !BACKENDS.includes(fromEnv as BackendKind)) {
    throw new Error(
      `SYNC_BACKEND must be one of: ${BACKENDS.join(", ")} (got "${fromEnv}")`
    );
  }
  return (
    entry.backend ??
    config.defaults.backend ??
    (fromEnv as BackendKind | undefined) ??
    "codesandbox"
  );
}

/**
 * R2 credentials live in the environment only; apps.json carries the bucket
 * and account id so the registry stays safe to commit.
 */
export function requireR2Settings(name: string, config: SyncConfig): R2Settings {
  loadEnv();
  const missing: string[] = [];
  const need = (value: string | undefined, label: string): string => {
    const trimmed = value?.trim();
    if (!trimmed) {
      missing.push(label);
      return "";
    }
    return trimmed;
  };

  const bucket = need(
    process.env.R2_BUCKET || config.defaults.r2?.bucket,
    "R2_BUCKET (or defaults.r2.bucket in apps.json)"
  );
  const accountId = need(
    process.env.R2_ACCOUNT_ID || config.defaults.r2?.accountId,
    "R2_ACCOUNT_ID (or defaults.r2.accountId in apps.json)"
  );
  const accessKeyId = need(process.env.R2_ACCESS_KEY_ID, "R2_ACCESS_KEY_ID");
  const secretAccessKey = need(
    process.env.R2_SECRET_ACCESS_KEY,
    "R2_SECRET_ACCESS_KEY"
  );

  if (missing.length > 0) {
    throw new Error(
      `App "${name}" uses the r2 backend but is missing: ${missing.join(", ")}. Set them in .env.local.`
    );
  }

  const endpoint =
    process.env.R2_ENDPOINT?.trim() ||
    config.defaults.r2?.endpoint ||
    `https://${accountId}.r2.cloudflarestorage.com`;

  return { bucket, accountId, endpoint, accessKeyId, secretAccessKey };
}

/** The devbox backend cannot guess where files go; R2 falls back to the name. */
function requireRemoteDir(name: string, entry: AppEntry): string {
  if (!entry.remoteDir) {
    throw new Error(
      `App "${name}" has no remoteDir — set one with update_app, or add "defaults.remoteRoot" to apps.json`
    );
  }
  return entry.remoteDir;
}

export function toResolvedApp(
  name: string,
  entry: AppEntry,
  config: SyncConfig
): ResolvedApp {
  const backend = resolveBackend(entry, config);
  const base = {
    name,
    sourceDir: entry.sourceDir,
    downloadDir: entry.downloadDir,
    backend,
    exclude: resolveExcludes(entry, config),
    preserveNodeModules: config.defaults.preserveNodeModules,
  };

  if (backend === "r2") {
    return {
      ...base,
      // A prefix, not a path: objects land at "<prefix>/<app>_<ts>.zip".
      remoteDir: entry.remoteDir ?? sanitizeAppName(name),
      r2: requireR2Settings(name, config),
    };
  }

  return {
    ...base,
    remoteDir: requireRemoteDir(name, entry),
    devboxId: requireDevboxId(name, entry, config),
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
  /** Explicit devbox id (e.g. --devbox); wins over config and environment. */
  devboxId?: string;
  /** Explicit backend (e.g. --backend); wins over config and environment. */
  backend?: BackendKind;
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
      throw new Error(
        `Unknown app "${options.appName}". Configured apps: ${known}`
      );
    }
    return toResolvedApp(options.appName, withOverrides(entry, options), config);
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
  return toResolvedApp(best, withOverrides(config.apps[best], options), config);
}

function withOverrides(entry: AppEntry, options: ResolveOptions): AppEntry {
  let out = entry;
  if (options.devboxId) {
    out = { ...out, devboxId: options.devboxId };
  }
  if (options.backend) {
    out = { ...out, backend: options.backend };
  }
  return out;
}

export function requireToken(): string {
  loadEnv();
  const token = process.env.CSB_API_KEY || process.env.CODESANDBOX_TOKEN;
  if (!token) {
    throw new Error(
      "Missing CodeSandbox token: set CSB_API_KEY (or CODESANDBOX_TOKEN) in .env.local"
    );
  }
  return token;
}

export type AppInput = {
  sourceDir: string;
  remoteDir?: string;
  downloadDir?: string | null;
  devboxId?: string | null;
  backend?: BackendKind | null;
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

  const entry: AppEntry = {
    sourceDir: validateSourceDir(input.sourceDir),
  };
  if (input.backend) {
    entry.backend = input.backend;
  }
  const backend = resolveBackend(entry, config);
  const remoteDir = input.remoteDir?.trim();
  if (remoteDir) {
    entry.remoteDir = remoteDir.replace(/\/+$/g, "");
  } else if (backend === "codesandbox") {
    // R2 derives its prefix from the app name; a devbox needs a real path.
    entry.remoteDir = defaultRemoteDir(appName, config).replace(/\/+$/g, "");
  }
  if (input.downloadDir) {
    entry.downloadDir = path.resolve(input.downloadDir.trim());
  }
  if (input.devboxId) {
    entry.devboxId = input.devboxId.trim();
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
  if (patch.remoteDir !== undefined) {
    const remoteDir = patch.remoteDir.trim().replace(/\/+$/g, "");
    if (!remoteDir) {
      throw new Error("remoteDir cannot be empty");
    }
    updated.remoteDir = remoteDir;
  }
  if (patch.downloadDir !== undefined) {
    if (patch.downloadDir === null || patch.downloadDir.trim() === "") {
      delete updated.downloadDir;
    } else {
      updated.downloadDir = path.resolve(patch.downloadDir.trim());
    }
  }
  if (patch.devboxId !== undefined) {
    if (patch.devboxId === null || patch.devboxId.trim() === "") {
      delete updated.devboxId;
    } else {
      updated.devboxId = patch.devboxId.trim();
    }
  }
  if (patch.backend !== undefined) {
    if (patch.backend === null) {
      delete updated.backend;
    } else {
      updated.backend = patch.backend;
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
  remoteDir?: string;
  downloadDir?: string;
  backend?: BackendKind;
  devboxId?: string;
  exclude?: string[];
  sourceExists: boolean;
  /** Set when the entry cannot be resolved, e.g. no devbox id. */
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
        remoteDir: entry.remoteDir,
        downloadDir: entry.downloadDir,
        sourceExists: fs.existsSync(entry.sourceDir),
      };
      try {
        const resolved = toResolvedApp(name, entry, config);
        listing.backend = resolved.backend;
        listing.remoteDir = resolved.remoteDir;
        listing.devboxId = resolved.devboxId;
        listing.exclude = resolved.exclude;
      } catch (error) {
        listing.error = error instanceof Error ? error.message : String(error);
      }
      return listing;
    });
}
