import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// Everything in this project must resolve paths relative to the repo root, not
// process.cwd(): the MCP server is launched from whatever directory the client
// happens to be in.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (this file lives in dist/ at runtime, src/ under ts-node). */
export const REPO_ROOT = path.resolve(moduleDir, "..");

export const OUTPUT_DIR = path.join(REPO_ROOT, "output");

let envLoaded = false;

/** Loads .env.local from the repo root exactly once. */
export function loadEnv(): void {
  if (envLoaded) {
    return;
  }
  dotenv.config({ path: path.join(REPO_ROOT, ".env.local") });
  envLoaded = true;
}

/** Path to apps.json; override with CSB_SYNC_CONFIG. */
export function configPath(): string {
  loadEnv();
  const override = process.env.CSB_SYNC_CONFIG;
  return override ? path.resolve(override) : path.join(REPO_ROOT, "apps.json");
}
