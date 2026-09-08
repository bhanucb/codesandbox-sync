import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeAppName, assertSafeExcludePattern } from "../dist/config.js";

test("sanitizeAppName produces a safe file prefix", () => {
  assert.equal(sanitizeAppName("my-app"), "my-app");
  assert.equal(sanitizeAppName("  scratch demo "), "scratch-demo");
  assert.equal(sanitizeAppName("a/b\\c"), "a-b-c");
  assert.equal(sanitizeAppName("--weird--name--"), "weird-name");
  assert.throws(() => sanitizeAppName("///"), /non-empty/);
});

test("exclude patterns cannot escape the source directory", () => {
  assert.throws(() => assertSafeExcludePattern("../etc"), /\.\./);
  assert.throws(() => assertSafeExcludePattern("a/../../b"), /\.\./);
  assert.doesNotThrow(() => assertSafeExcludePattern("build/cache"));
});

test("app resolution matches the deepest sourceDir containing a path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-sync-test-"));
  const outer = path.join(root, "outer");
  const inner = path.join(outer, "packages", "inner");
  fs.mkdirSync(inner, { recursive: true });

  const registry = path.join(root, "apps.json");
  fs.writeFileSync(registry, JSON.stringify({
    defaults: { devboxId: "dev1" },
    apps: {
      outer: { sourceDir: outer, remoteDir: "/project/sandbox/apps/outer" },
      inner: { sourceDir: inner, remoteDir: "/project/sandbox/apps/inner" },
    },
  }));

  process.env.CSB_SYNC_CONFIG = registry;
  const { resolveApp } = await import(`../dist/config.js?t=${Date.now()}`);

  assert.equal(resolveApp({ path: path.join(inner, "src") }).name, "inner");
  assert.equal(resolveApp({ path: path.join(outer, "src") }).name, "outer");
  assert.equal(resolveApp({ appName: "outer" }).devboxId, "dev1");
  assert.throws(() => resolveApp({ appName: "nope" }), /Unknown app/);
  assert.throws(() => resolveApp({ path: os.tmpdir() }), /No configured app matches/);

  delete process.env.CSB_SYNC_CONFIG;
  fs.rmSync(root, { recursive: true, force: true });
});

test("a devbox id is mandatory and never defaulted in code", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-sync-devbox-"));
  const src = path.join(root, "app");
  fs.mkdirSync(src, { recursive: true });

  const registry = path.join(root, "apps.json");
  fs.writeFileSync(registry, JSON.stringify({
    defaults: {},
    apps: { bare: { sourceDir: src, remoteDir: "/r/bare" } },
  }));

  process.env.CSB_SYNC_CONFIG = registry;
  const previous = process.env.DEVBOX_ID;
  delete process.env.DEVBOX_ID;
  const { resolveApp, listApps, defaultRemoteDir } = await import(`../dist/config.js?t=${Date.now()}`);

  assert.throws(() => resolveApp({ appName: "bare" }), /No devbox id/);

  // an explicit override resolves it
  assert.equal(resolveApp({ appName: "bare", devboxId: "box-9" }).devboxId, "box-9");

  // listing stays usable so the problem can be diagnosed
  const [listing] = listApps();
  assert.equal(listing.name, "bare");
  assert.match(listing.error, /No devbox id/);
  assert.equal(listing.devboxId, undefined);

  // no built-in remote path either
  assert.throws(() => defaultRemoteDir("bare", { defaults: {}, apps: {} }), /No remote directory/);
  assert.equal(
    defaultRemoteDir("bare", { defaults: { remoteRoot: "/project/sandbox/apps" }, apps: {} }),
    "/project/sandbox/apps/bare"
  );

  if (previous !== undefined) process.env.DEVBOX_ID = previous;
  delete process.env.CSB_SYNC_CONFIG;
  fs.rmSync(root, { recursive: true, force: true });
});

test("devbox id precedence: app entry > defaults > environment", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-sync-prec-"));
  const src = path.join(root, "app");
  fs.mkdirSync(src, { recursive: true });
  const registry = path.join(root, "apps.json");
  fs.writeFileSync(registry, JSON.stringify({
    defaults: { devboxId: "from-defaults" },
    apps: {
      own: { sourceDir: src, remoteDir: "/r/own", devboxId: "from-app" },
      inherited: { sourceDir: src, remoteDir: "/r/inherited" },
    },
  }));

  process.env.CSB_SYNC_CONFIG = registry;
  process.env.DEVBOX_ID = "from-env";
  const { resolveApp } = await import(`../dist/config.js?t=${Date.now()}`);

  assert.equal(resolveApp({ appName: "own" }).devboxId, "from-app");
  assert.equal(resolveApp({ appName: "inherited" }).devboxId, "from-defaults");

  delete process.env.CSB_SYNC_CONFIG;
  delete process.env.DEVBOX_ID;
  fs.rmSync(root, { recursive: true, force: true });
});
