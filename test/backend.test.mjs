import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const R2_ENV = [
  "R2_BUCKET",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_ENDPOINT",
  "SYNC_BACKEND",
  "DEVBOX_ID",
];

function clearR2Env() {
  for (const key of R2_ENV) {
    delete process.env[key];
  }
}

function setR2Credentials() {
  process.env.R2_ACCESS_KEY_ID = "AKIA_TEST";
  process.env.R2_SECRET_ACCESS_KEY = "secret_test";
}

/** Writes a registry and returns a freshly-imported config module for it. */
async function withRegistry(contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csb-backend-test-"));
  const source = path.join(root, "app");
  fs.mkdirSync(source, { recursive: true });

  const registry = path.join(root, "apps.json");
  const json = JSON.parse(JSON.stringify(contents));
  for (const entry of Object.values(json.apps)) {
    entry.sourceDir = entry.sourceDir ?? source;
  }
  fs.writeFileSync(registry, JSON.stringify(json));
  process.env.CSB_SYNC_CONFIG = registry;
  const mod = await import(`../dist/config.js?t=${Date.now()}-${Math.random()}`);
  return { mod, source, root };
}

test("apps default to the codesandbox backend", async () => {
  clearR2Env();
  const { mod } = await withRegistry({
    defaults: { devboxId: "dev1" },
    apps: { demo: { remoteDir: "/project/sandbox/apps/demo" } },
  });
  const app = mod.resolveApp({ appName: "demo" });
  assert.equal(app.backend, "codesandbox");
  assert.equal(app.devboxId, "dev1");
  assert.equal(app.r2, undefined);
});

test("the r2 backend needs no devbox id and defaults its prefix to the app name", async () => {
  clearR2Env();
  setR2Credentials();
  const { mod } = await withRegistry({
    defaults: { backend: "r2", r2: { bucket: "project-zips", accountId: "acct123" } },
    apps: { demo: {} },
  });
  const app = mod.resolveApp({ appName: "demo" });
  assert.equal(app.backend, "r2");
  assert.equal(app.devboxId, undefined);
  assert.equal(app.remoteDir, "demo");
  assert.equal(app.r2.bucket, "project-zips");
  assert.equal(app.r2.endpoint, "https://acct123.r2.cloudflarestorage.com");
});

test("backend precedence: override > app entry > defaults > environment", async () => {
  clearR2Env();
  setR2Credentials();
  process.env.R2_BUCKET = "project-zips";
  process.env.R2_ACCOUNT_ID = "acct123";

  const { mod } = await withRegistry({
    defaults: { devboxId: "dev1", backend: "codesandbox" },
    apps: {
      inherits: { remoteDir: "/project/sandbox/apps/inherits" },
      pinned: { remoteDir: "/project/sandbox/apps/pinned", backend: "r2" },
    },
  });

  assert.equal(mod.resolveApp({ appName: "inherits" }).backend, "codesandbox");
  assert.equal(mod.resolveApp({ appName: "pinned" }).backend, "r2");
  // An explicit override wins over everything, so a cutover can be tried per run.
  assert.equal(
    mod.resolveApp({ appName: "inherits", backend: "r2" }).backend,
    "r2"
  );
  assert.equal(
    mod.resolveApp({ appName: "pinned", backend: "codesandbox" }).backend,
    "codesandbox"
  );
});

test("SYNC_BACKEND applies only when nothing else sets the backend", async () => {
  clearR2Env();
  setR2Credentials();
  process.env.R2_BUCKET = "project-zips";
  process.env.R2_ACCOUNT_ID = "acct123";
  process.env.SYNC_BACKEND = "r2";

  const { mod } = await withRegistry({
    defaults: { devboxId: "dev1" },
    apps: {
      loose: { remoteDir: "/project/sandbox/apps/loose" },
      pinned: { remoteDir: "/project/sandbox/apps/pinned", backend: "codesandbox" },
    },
  });
  assert.equal(mod.resolveApp({ appName: "loose" }).backend, "r2");
  assert.equal(mod.resolveApp({ appName: "pinned" }).backend, "codesandbox");

  process.env.SYNC_BACKEND = "nonsense";
  assert.throws(() => mod.resolveApp({ appName: "loose" }), /SYNC_BACKEND/);
  delete process.env.SYNC_BACKEND;
});

test("missing R2 settings are reported together, and secrets are never defaulted", async () => {
  clearR2Env();
  const { mod } = await withRegistry({
    defaults: { backend: "r2" },
    apps: { demo: {} },
  });

  assert.throws(() => mod.resolveApp({ appName: "demo" }), (error) => {
    assert.match(error.message, /R2_BUCKET/);
    assert.match(error.message, /R2_ACCOUNT_ID/);
    assert.match(error.message, /R2_ACCESS_KEY_ID/);
    assert.match(error.message, /R2_SECRET_ACCESS_KEY/);
    return true;
  });
});

test("a codesandbox app without a remoteDir is rejected, not guessed", async () => {
  clearR2Env();
  const { mod } = await withRegistry({
    defaults: { devboxId: "dev1" },
    apps: { demo: {} },
  });
  assert.throws(() => mod.resolveApp({ appName: "demo" }), /no remoteDir/);
});

test("an unknown backend in apps.json is rejected at load", async () => {
  clearR2Env();
  await assert.rejects(
    withRegistry({ defaults: {}, apps: { demo: { backend: "dropbox" } } }).then(
      ({ mod }) => mod.loadConfig()
    ),
    /codesandbox, r2/
  );
});
