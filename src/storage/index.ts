import type { ResolvedApp } from "../config.js";
import { R2Storage } from "./r2.js";
import type { Storage } from "./types.js";

export type { RemoteZip, Storage } from "./types.js";

/** Builds the storage an app syncs through. */
export function createStorage(app: ResolvedApp): Storage {
  return new R2Storage(app.r2, app.remotePrefix);
}
