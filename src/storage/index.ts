import type { ResolvedApp } from "../config.js";
import type { Logger } from "../zip.js";
import { browserAvailable, browserHint, DashboardStorage } from "./dashboard.js";
import { NotS3ResponseError, R2Storage } from "./r2.js";
import type { Storage } from "./types.js";

export type { RemoteZip, Storage } from "./types.js";

/** Builds the storage an app syncs through, over the given transport. */
export function createStorage(app: ResolvedApp, transport: "api" | "browser" = "api"): Storage {
  if (transport === "browser") {
    return new DashboardStorage(app.r2Location, app.remotePrefix, app.browser);
  }
  return new R2Storage(app.r2, app.remotePrefix);
}

async function runWith<T>(
  storage: Storage,
  log: Logger,
  run: (storage: Storage) => Promise<T>
): Promise<T> {
  try {
    return await run(storage);
  } finally {
    storage.close(log);
  }
}

/**
 * Runs `run` against the app's storage, choosing the transport:
 *
 * - "api": the S3 endpoint, and nothing else.
 * - "browser": the dashboard, in a browser the human has signed in to.
 * - "auto" (default): the S3 endpoint; but when it is blocked, or no keys
 *   are configured, and a debuggable browser is up, the dashboard instead.
 *
 * The fallback re-runs `run` from the start against the second transport.
 * Every caller's first storage call is a list or a put, so nothing local has
 * changed by the time the S3 endpoint turns out to be blocked.
 */
export async function withStorage<T>(
  app: ResolvedApp,
  log: Logger,
  run: (storage: Storage) => Promise<T>
): Promise<T> {
  const transport = app.transport;
  if (transport === "browser") {
    return runWith(createStorage(app, "browser"), log, run);
  }

  let r2: Storage;
  try {
    r2 = createStorage(app, "api");
  } catch (error) {
    // No keys. On the machine the browser route exists for, that is expected.
    if (transport === "auto" && (await browserAvailable(app.browser.cdpUrl))) {
      log(`\nNo R2 keys configured — using the dashboard in the browser at ${app.browser.cdpUrl}.`);
      return runWith(createStorage(app, "browser"), log, run);
    }
    throw error;
  }

  try {
    return await runWith(r2, log, run);
  } catch (error) {
    if (transport !== "auto" || !(error instanceof NotS3ResponseError)) {
      throw error;
    }
    if (!(await browserAvailable(app.browser.cdpUrl))) {
      throw new Error(
        `${error.message}\n  4. Or go through the dashboard in your browser (psync --browser).\n     ${browserHint(app.browser.cdpUrl).split("\n").join("\n     ")}`
      );
    }
    log(`\n⚠️  The S3 endpoint is blocked here — switching to the dashboard in the browser at ${app.browser.cdpUrl}.`);
    return runWith(createStorage(app, "browser"), log, run);
  }
}
