import type { Logger } from "../zip.js";

export type BackendKind = "codesandbox" | "r2";

export type RemoteZip = {
  name: string;
  /** Backend-native locator: a devbox path, or an object key in R2. */
  path: string;
  size: number;
  /** Seconds or milliseconds since the epoch; see mtimeToDate. */
  mtime: number;
};

/**
 * The whole of what syncing needs from a remote: list the ZIPs, put one, get
 * one back, drop the stale ones. Everything backend-specific (devbox
 * connections, S3 signing) lives behind this.
 */
export interface Storage {
  readonly kind: BackendKind;
  /** Human-readable target, for logs and results. */
  readonly location: string;
  /** A URL a human can open to see the stored files, when one exists. */
  readonly browseUrl?: string;

  /** ZIPs only, newest first. Returns [] when the target does not exist yet. */
  list(log: Logger): Promise<RemoteZip[]>;
  /** Uploads and verifies; resolves to the stored object's path. */
  put(name: string, data: Buffer, log: Logger): Promise<string>;
  get(zip: RemoteZip, log: Logger): Promise<Buffer>;
  remove(zip: RemoteZip, log: Logger): Promise<void>;
  /** Releases any connection. Must not throw. */
  close(log: Logger): void;
}
