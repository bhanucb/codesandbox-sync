import path from "path";
import { fileURLToPath } from "url";

// Everything in this project must resolve paths relative to the repo root, not
// process.cwd(): the MCP server is launched from whatever directory the client
// happens to be in.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (this file lives in dist/ at runtime, src/ under ts-node). */
export const REPO_ROOT = path.resolve(moduleDir, "..");

export const OUTPUT_DIR = path.join(REPO_ROOT, "output");

/**
 * Path to apps.json. SYNC_CONFIG must come from the real environment: it says
 * which registry to read, so it cannot live inside one.
 */
export function configPath(): string {
  const override = process.env.SYNC_CONFIG;
  return override ? path.resolve(override) : path.join(REPO_ROOT, "apps.json");
}
