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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psync-test-"));
  const source = path.join(root, "app");
  fs.mkdirSync(source, { recursive: true });

  const registry = path.join(root, "apps.json");
  const json = JSON.parse(JSON.stringify(contents));
  for (const entry of Object.values(json.apps)) {
    entry.sourceDir = entry.sourceDir ?? source;
  }
  fs.writeFileSync(registry, JSON.stringify(json));
  process.env.SYNC_CONFIG = registry;
  const mod = await import(`../dist/config.js?t=${Date.now()}-${Math.random()}`);
  return { mod, source, root };
}

test("an app's object prefix defaults to its name", async () => {
  clearR2Env();
  setR2Credentials();
  const { mod } = await withRegistry({
    defaults: { r2: { bucket: "project-zips", accountId: "acct123" } },
    apps: { demo: {}, custom: { remotePrefix: "archive/custom" } },
  });
  assert.equal(mod.resolveApp({ appName: "demo" }).remotePrefix, "demo");
  assert.equal(mod.resolveApp({ appName: "custom" }).remotePrefix, "archive/custom");
});

test("the endpoint is derived from the account id unless overridden", async () => {
  clearR2Env();
  setR2Credentials();
  const { mod } = await withRegistry({
    defaults: { r2: { bucket: "project-zips", accountId: "acct123" } },
    apps: { demo: {} },
  });
  assert.equal(
    mod.resolveApp({ appName: "demo" }).r2.endpoint,
    "https://acct123.r2.cloudflarestorage.com"
  );

  process.env.R2_ENDPOINT = "https://custom.example";
  assert.equal(mod.resolveApp({ appName: "demo" }).r2.endpoint, "https://custom.example");
  delete process.env.R2_ENDPOINT;
});

test("environment settings win over apps.json for bucket and account", async () => {
  clearR2Env();
  setR2Credentials();
  const { mod } = await withRegistry({
    defaults: { r2: { bucket: "from-file", accountId: "acct-file" } },
    apps: { demo: {} },
  });
  assert.equal(mod.resolveApp({ appName: "demo" }).r2.bucket, "from-file");

  process.env.R2_BUCKET = "from-env";
  process.env.R2_ACCOUNT_ID = "acct-env";
  const app = mod.resolveApp({ appName: "demo" });
  assert.equal(app.r2.bucket, "from-env");
  assert.equal(app.r2.accountId, "acct-env");
});

test("missing R2 settings are reported together", async () => {
  clearR2Env();
  const { mod } = await withRegistry({ defaults: {}, apps: { demo: {} } });

  assert.throws(() => mod.resolveApp({ appName: "demo" }), (error) => {
    assert.match(error.message, /R2_BUCKET/);
    assert.match(error.message, /R2_ACCOUNT_ID/);
    assert.match(error.message, /R2_ACCESS_KEY_ID/);
    assert.match(error.message, /R2_SECRET_ACCESS_KEY/);
    return true;
  });
});

test("credentials are never read from apps.json", async () => {
  clearR2Env();
  // A registry that tries to supply the key pair must not satisfy the check:
  // apps.json is committed, and secrets in it would leak.
  const { mod } = await withRegistry({
    defaults: {
      r2: {
        bucket: "project-zips",
        accountId: "acct123",
        accessKeyId: "leaked",
        secretAccessKey: "leaked",
      },
    },
    apps: { demo: {} },
  });
  assert.throws(() => mod.resolveApp({ appName: "demo" }), /R2_ACCESS_KEY_ID/);
});

test("a key prefix cannot escape its bucket namespace", async () => {
  clearR2Env();
  setR2Credentials();
  await assert.rejects(
    withRegistry({
      defaults: { r2: { bucket: "b", accountId: "a" } },
      apps: { demo: { remotePrefix: "../other-bucket" } },
    }).then(({ mod }) => mod.loadConfig()),
    /\.\./
  );
});

test("a leading or trailing slash in a prefix is normalized away", async () => {
  clearR2Env();
  setR2Credentials();
  const { mod } = await withRegistry({
    defaults: { r2: { bucket: "project-zips", accountId: "acct123" } },
    apps: { demo: { remotePrefix: "/archive/demo/" } },
  });
  assert.equal(mod.resolveApp({ appName: "demo" }).remotePrefix, "archive/demo");
});
