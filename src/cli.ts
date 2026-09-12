import {
  loadConfig,
  resolveApp,
  sanitizeAppName,
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

/**
 * Resolves the app for a CLI run: `--app <name>`, then APP_NAME from
 * .env.local, then cwd.
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
  if (envName && config.apps[envName]) {
    return resolveApp({ appName: envName, config });
  }

  return resolveApp({ config });
}
