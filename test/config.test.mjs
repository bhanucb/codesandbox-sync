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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psync-test-"));
  const outer = path.join(root, "outer");
  const inner = path.join(outer, "packages", "inner");
  fs.mkdirSync(inner, { recursive: true });

  const registry = path.join(root, "apps.json");
  fs.writeFileSync(registry, JSON.stringify({
    defaults: { r2: { bucket: "project-zips", accountId: "acct123" } },
    apps: {
      outer: { sourceDir: outer },
      inner: { sourceDir: inner },
    },
  }));

  process.env.SYNC_CONFIG = registry;
  process.env.R2_ACCESS_KEY_ID = "AKIA_TEST";
  process.env.R2_SECRET_ACCESS_KEY = "secret_test";
  const { resolveApp } = await import(`../dist/config.js?t=${Date.now()}`);

  assert.equal(resolveApp({ path: path.join(inner, "src") }).name, "inner");
  assert.equal(resolveApp({ path: path.join(outer, "src") }).name, "outer");
  assert.equal(resolveApp({ appName: "outer" }).remotePrefix, "outer");
  assert.throws(() => resolveApp({ appName: "nope" }), /Unknown app/);
  assert.throws(() => resolveApp({ path: os.tmpdir() }), /No configured app matches/);

  delete process.env.SYNC_CONFIG;
  fs.rmSync(root, { recursive: true, force: true });
});

