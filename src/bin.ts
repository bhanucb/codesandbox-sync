#!/usr/bin/env node
import fs from "fs";
import path from "path";
import readline from "readline/promises";
import { resolveCliApp } from "./cli.js";
import {
  listApps,
  loadConfig,
  resolveApp,
  sanitizeAppName,
  toResolvedApp,
  type ResolvedApp,
} from "./config.js";
import { configPath } from "./paths.js";
import { downloadApp, listRemoteZips, uploadApp } from "./sync.js";

const USAGE = `psync — zip a project to Cloudflare R2, and back

Usage:
  psync upload   [--app <name>] [--source <dir>] [--prefix <key>] [--dry-run]
  psync download [--app <name>] [--to <dir>] [--prefix <key>] [--yes]
  psync verify   [--app <name>] [--prefix <key>]
  psync apps

Target resolution, in order:
  --source <dir>   ad-hoc: use this directory, no apps.json entry needed
  --app <name>     a name from apps.json
  (neither)        the app whose sourceDir contains the current directory,
                   else defaults.app from apps.json

Options:
  --source <dir>   Directory to zip (implies ad-hoc mode)
  --prefix <key>   Object key prefix override (default: the app name)
  --to <dir>       Download target override (download only)
  --dry-run        Build the ZIP and report its size; never contacts R2
  --yes, -y        Skip the download confirmation prompt
  --help, -h       Show this help

Examples:
  cd ~/Work/direct-bidding && psync upload
  psync upload --app ipa --dry-run
  psync upload --source . --prefix scratch
  psync download --app direct-bidding --yes
`;

const BOOLEAN_FLAGS = new Set(["dry-run", "yes", "help"]);

type Flags = Map<string, string | true>;

function parseArgs(argv: readonly string[]): { command?: string; flags: Flags } {
  const flags: Flags = new Map();
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-y") {
      flags.set("yes", true);
    } else if (arg === "-h") {
      flags.set("help", true);
    } else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const name = arg.slice(2);
        if (BOOLEAN_FLAGS.has(name)) {
          flags.set(name, true);
        } else {
          const value = argv[i + 1];
          if (value === undefined || value.startsWith("-")) {
            throw new Error(`Missing value for --${name}`);
          }
          flags.set(name, value);
          i++;
        }
      }
    } else if (command === undefined) {
      command = arg;
    }
  }

  return { command, flags };
}

function str(flags: Flags, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Builds a throwaway app from --source, borrowing apps.json for anything unset. */
function adHocApp(sourceDir: string, flags: Flags): ResolvedApp {
  const abs = path.resolve(sourceDir);
  if (!fs.existsSync(abs)) {
    throw new Error(`Source directory not found: ${abs}`);
  }
  if (!fs.statSync(abs).isDirectory()) {
    throw new Error(`Source path is not a directory: ${abs}`);
  }

  const config = loadConfig();
  const name = sanitizeAppName(str(flags, "app") ?? path.basename(abs));
  const known = config.apps[name];

  return toResolvedApp(
    name,
    {
      sourceDir: abs,
      remotePrefix: str(flags, "prefix") ?? known?.remotePrefix,
      downloadDir: str(flags, "to") ?? known?.downloadDir ?? abs,
      exclude: known?.exclude,
    },
    config
  );
}

function applyOverrides(app: ResolvedApp, flags: Flags): ResolvedApp {
  // One-off overrides apply to registered apps too.
  const prefix = str(flags, "prefix");
  const to = str(flags, "to");
  if (prefix) app.remotePrefix = prefix;
  if (to) app.downloadDir = to;
  return app;
}

/**
 * Resolution order for the global command: --source, --app, the current
 * directory, then defaults.app from apps.json.
 *
 * Current directory beats defaults.app here, unlike `npm run upload`. This command
 * is normally run from inside the project being uploaded, so a stale defaults.app
 * silently retargeting the upload would be the worst kind of surprise.
 */
function resolveTarget(argv: readonly string[], flags: Flags): ResolvedApp {
  const source = str(flags, "source");
  if (source) {
    return applyOverrides(adHocApp(source, flags), flags);
  }

  const config = loadConfig();
  const appName = str(flags, "app");
  if (appName) {
    return applyOverrides(resolveApp({ appName, config }), flags);
  }

  try {
    return applyOverrides(resolveApp({ config }), flags);
  } catch (cwdError) {
    // No app owns this directory — fall back to defaults.app, and surface the
    // original error if that fails too.
    try {
      return applyOverrides(resolveCliApp([...argv], { validate: false }), flags);
    } catch {
      throw cwdError;
    }
  }
}

function describeTarget(app: ResolvedApp, adHoc: boolean): void {
  console.log(`App: ${app.name}${adHoc ? " (ad-hoc)" : ""}`);
  console.log(`  Source: ${app.sourceDir}`);
  console.log(`  Prefix: ${app.remotePrefix}`);
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function printApps(): void {
  const apps = listApps();
  if (apps.length === 0) {
    console.log(`No apps configured in ${configPath()}.`);
    return;
  }
  console.log(`${apps.length} app(s) in ${configPath()}:\n`);
  const width = Math.max(...apps.map((a) => a.name.length));
  for (const app of apps) {
    const mark = app.error ? "x" : app.sourceExists ? " " : "!";
    console.log(`${mark} ${app.name.padEnd(width)}  ${app.sourceDir}`);
    console.log(`  ${" ".repeat(width)}  → ${app.remotePrefix}/`);
    if (app.error) {
      console.log(`  ${" ".repeat(width)}  x ${app.error}`);
    }
  }
  const missing = apps.filter((a) => !a.sourceExists && !a.error);
  if (missing.length > 0) {
    console.log(`\n! source directory not found: ${missing.map((a) => a.name).join(", ")}`);
  }
  const broken = apps.filter((a) => a.error);
  if (broken.length > 0) {
    console.log(`\nx unusable: ${broken.map((a) => a.name).join(", ")}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { command, flags } = parseArgs(argv);

  if (flags.has("help") || command === undefined || command === "help") {
    console.log(USAGE);
    return;
  }

  const log = (message: string) => console.log(message);

  switch (command) {
    case "apps":
    case "list": {
      printApps();
      return;
    }

    case "upload": {
      const app = resolveTarget(argv, flags);
      describeTarget(app, flags.has("source"));
      await uploadApp(app, { log, dryRun: flags.get("dry-run") === true });
      return;
    }

    case "download": {
      const app = resolveTarget(argv, flags);
      describeTarget(app, flags.has("source"));
      console.log(`  Target: ${app.downloadDir ?? "(not configured)"}`);
      if (!app.downloadDir) {
        throw new Error(
          `No download target for "${app.name}" — pass --to <dir> or set downloadDir in apps.json`
        );
      }
      if (flags.get("yes") !== true) {
        const ok = await confirm(
          `\nThis resets ${app.downloadDir}. Anything excluded from the upload is kept (node_modules, build output, assistant/editor state), plus .git/info/exclude. Continue?`
        );
        if (!ok) {
          console.log(
            process.stdin.isTTY
              ? "Aborted."
              : "Aborted: not a terminal, so nothing was confirmed. Re-run with --yes."
          );
          process.exitCode = 1;
          return;
        }
      }
      await downloadApp(app, { log });
      return;
    }

    case "verify": {
      const app = resolveTarget(argv, flags);
      await listRemoteZips(app, { log });
      return;
    }

    default:
      throw new Error(
        `Unknown command "${command}". Expected: upload, download, verify, apps.`
      );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
