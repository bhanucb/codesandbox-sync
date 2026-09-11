import type { ResolvedApp } from "../config.js";
import { CodeSandboxStorage } from "./codesandbox.js";
import { R2Storage } from "./r2.js";
import type { Storage } from "./types.js";

export type { BackendKind, RemoteZip, Storage } from "./types.js";

/** Builds the backend an app is configured for. */
export function createStorage(app: ResolvedApp): Storage {
  if (app.backend === "r2") {
    if (!app.r2) {
      throw new Error(`App "${app.name}" resolved to the r2 backend without settings`);
    }
    return new R2Storage(app.r2, app.remoteDir);
  }
  if (!app.devboxId) {
    throw new Error(`App "${app.name}" resolved to the codesandbox backend without a devbox id`);
  }
  return new CodeSandboxStorage(app.devboxId, app.remoteDir);
}
