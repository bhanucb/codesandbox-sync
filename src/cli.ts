import path from "path";
import {
  loadConfig,
  resolveApp,
  sanitizeAppName,
  toResolvedApp,
  type ResolvedApp,
} from "./config.js";
import { loadEnv } from "./paths.js";

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index !== -1 && argv[index + 1]) {
    return argv[index + 1];
  }
  const prefixed = argv.find((a) => a.startsWith(`${flag}=`));
  return prefixed ? prefixed.slice(flag.length + 1) : undefined;
}

/** Pre-apps.json behavior: a single app described by .env.local variables. */
function legacyEnvApp(): ResolvedApp | null {
  const name = process.env.APP_NAME;
  const sourceDir = process.env.SOURCE_DIR;
  const remoteDir = process.env.REMOTE_DIR;
  if (!name || !sourceDir || !remoteDir) {
    return null;
  }
  const config = loadConfig();
  return toResolvedApp(
    sanitizeAppName(name),
    {
      sourceDir: path.resolve(sourceDir),
      remoteDir,
      downloadDir: process.env.DOWNLOAD_DIR
        ? path.resolve(process.env.DOWNLOAD_DIR)
        : undefined,
    },
    config
  );
}

/**
 * Resolves the app for a CLI run: `--app <name>`, then APP_NAME from
 * .env.local (config entry first, legacy env block second), then cwd.
 */
export function resolveCliApp(argv: string[] = process.argv.slice(2)): ResolvedApp {
  loadEnv();
  const config = loadConfig();

  const explicit = flagValue(argv, "--app");
  if (explicit) {
    return resolveApp({ appName: explicit, config });
  }

  const envName = process.env.APP_NAME
    ? sanitizeAppName(process.env.APP_NAME)
    : undefined;
  if (envName) {
    if (config.apps[envName]) {
      return resolveApp({ appName: envName, config });
    }
    const legacy = legacyEnvApp();
    if (legacy) {
      console.log(
        `⚠️  "${envName}" is not in apps.json — using SOURCE_DIR/REMOTE_DIR from .env.local`
      );
      return legacy;
    }
  }

  return resolveApp({ config });
}
