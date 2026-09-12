import type { Logger } from "../zip.js";

export type RemoteZip = {
  name: string;
  /** Object key in the bucket. */
  path: string;
  size: number;
  /** Milliseconds since the epoch. */
  mtime: number;
};

/**
 * The whole of what syncing needs from a remote: list the ZIPs, put one, get
 * one back, drop the stale ones. Everything transport-specific lives behind
 * this, so sync.ts never learns what it is talking to.
 */
export interface Storage {
  /** Human-readable target, for logs and results. */
  readonly location: string;
  /** A URL a human can open to see the stored files. */
  readonly browseUrl?: string;

  /** ZIPs only, newest first. Returns [] when the target is empty. */
  list(log: Logger): Promise<RemoteZip[]>;
  /** Uploads and verifies; resolves to the stored object's key. */
  put(name: string, data: Buffer, log: Logger): Promise<string>;
  get(zip: RemoteZip, log: Logger): Promise<Buffer>;
  remove(zip: RemoteZip, log: Logger): Promise<void>;
  /** Releases any connection. Must not throw. */
  close(log: Logger): void;
}
