import {
  loadConfig,
  resolveApp,
  sanitizeAppName,
  type ResolvedApp,
} from "./config.js";
import { loadEnv } from "./paths.js";

/** Flags the `npm run …` entry points understand. */
const VALUE_FLAGS = new Set(["app"]);
const BOOLEAN_FLAGS = new Set(["dry-run", "yes", "help"]);

/**
 * Rejects anything this entry point would otherwise ignore.
 *
 * `npm run upload --app foo` does not do what it looks like: npm claims --app
 * as its own config flag and forwards the bare word "foo". Silently dropping it
 * and falling back to APP_NAME meant uploading a completely different project,
 * so an unrecognized argument is now a hard error.
 */
function assertRecognizedArgs(argv: readonly string[]): void {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      throw new Error(
        `Unexpected argument "${arg}". If you ran \`npm run <script> --app ${arg}\`, npm consumed the --app flag itself — use \`npm run <script> -- --app ${arg}\` (note the extra --), or run \`psync upload --app ${arg}\` directly.`
      );
    }
    const name = arg.replace(/^-+/, "").split("=")[0];
    if (VALUE_FLAGS.has(name)) {
      if (!arg.includes("=")) i++;
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      continue;
    }
    throw new Error(
      `Unknown option "${arg}". Supported here: --app <name>, --dry-run.`
    );
  }
}

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
export function resolveCliApp(
  argv: string[] = process.argv.slice(2),
  options: { validate?: boolean } = {}
): ResolvedApp {
  loadEnv();
  // psync has its own parser and a richer flag set; only the `npm run …`
  // entry points, whose whole vocabulary is --app and --dry-run, validate here.
  if (options.validate ?? true) {
    assertRecognizedArgs(argv);
  }
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
