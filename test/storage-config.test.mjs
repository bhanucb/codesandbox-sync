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
    defaults: { r2: { bucket: "project-zips", accountId: "acct123", accessKeyId: "k", secretAccessKey: "s" } },
    apps: { demo: {}, custom: { remotePrefix: "archive/custom" } },
  });
  assert.equal(mod.resolveApp({ appName: "demo" }).remotePrefix, "demo");
  assert.equal(mod.resolveApp({ appName: "custom" }).remotePrefix, "archive/custom");
});

test("the endpoint is derived from the account id unless overridden", async () => {
  clearR2Env();
  setR2Credentials();
  const { mod } = await withRegistry({
    defaults: { r2: { bucket: "project-zips", accountId: "acct123", accessKeyId: "k", secretAccessKey: "s" } },
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
    defaults: {
      r2: {
        bucket: "from-file",
        accountId: "acct-file",
        accessKeyId: "k",
        secretAccessKey: "s",
      },
    },
    apps: { demo: {} },
  });
  assert.equal(mod.resolveApp({ appName: "demo" }).r2.bucket, "from-file");

  process.env.R2_BUCKET = "from-env";
  process.env.R2_ACCOUNT_ID = "acct-env";
  const app = mod.resolveApp({ appName: "demo" });
  assert.equal(app.r2.bucket, "from-env");
  assert.equal(app.r2.accountId, "acct-env");
});

test("missing R2 settings are reported together, naming the registry", async () => {
  clearR2Env();
  const { mod } = await withRegistry({ defaults: {}, apps: { demo: {} } });

  // Resolving succeeds — only touching the bucket needs the keys, so the
  // offline commands (--dry-run, --file, --url, apps) work with none configured.
  const app = mod.resolveApp({ appName: "demo" });
  assert.equal(app.name, "demo");
  assert.ok(!Object.keys(app).includes("r2"), "credentials stay out of listings");

  assert.throws(() => app.r2, (error) => {
    assert.match(error.message, /defaults\.r2\.bucket/);
    assert.match(error.message, /defaults\.r2\.accountId/);
    assert.match(error.message, /defaults\.r2\.accessKeyId/);
    assert.match(error.message, /defaults\.r2\.secretAccessKey/);
    assert.match(error.message, /apps\.json/);
    return true;
  });
});

test("apps.json is a complete config: credentials included", async () => {
  clearR2Env();
  const { mod } = await withRegistry({
    defaults: {
      r2: {
        bucket: "project-zips",
        accountId: "acct123",
        accessKeyId: "key-from-file",
        secretAccessKey: "secret-from-file",
      },
    },
    apps: { demo: {} },
  });
  const app = mod.resolveApp({ appName: "demo" });
  assert.equal(app.r2.accessKeyId, "key-from-file");
  assert.equal(app.r2.secretAccessKey, "secret-from-file");
});

test("a real environment variable still overrides the registry", async () => {
  clearR2Env();
  const { mod } = await withRegistry({
    defaults: {
      r2: {
        bucket: "project-zips",
        accountId: "acct123",
        accessKeyId: "key-from-file",
        secretAccessKey: "secret-from-file",
      },
    },
    apps: { demo: {} },
  });
  // Keeps CI and one-off overrides working without a second config file.
  process.env.R2_ACCESS_KEY_ID = "key-from-env";
  assert.equal(mod.resolveApp({ appName: "demo" }).r2.accessKeyId, "key-from-env");
  clearR2Env();
});

test("a key prefix cannot escape its bucket namespace", async () => {
  clearR2Env();
  setR2Credentials();
  await assert.rejects(
    withRegistry({
      defaults: { r2: { bucket: "b", accountId: "a", accessKeyId: "k", secretAccessKey: "s" } },
      apps: { demo: { remotePrefix: "../other-bucket" } },
    }).then(({ mod }) => mod.loadConfig()),
    /\.\./
  );
});

test("a leading or trailing slash in a prefix is normalized away", async () => {
  clearR2Env();
  setR2Credentials();
  const { mod } = await withRegistry({
    defaults: { r2: { bucket: "project-zips", accountId: "acct123", accessKeyId: "k", secretAccessKey: "s" } },
    apps: { demo: { remotePrefix: "/archive/demo/" } },
  });
  assert.equal(mod.resolveApp({ appName: "demo" }).remotePrefix, "archive/demo");
});

test("without keys an app is still listed as usable offline, with the gap named", async () => {
  clearR2Env();
  const { mod } = await withRegistry({
    defaults: { r2: { bucket: "project-zips", accountId: "acct123" } },
    apps: { demo: {} },
  });
  const [listing] = mod.listApps();
  assert.equal(listing.error, undefined);
  assert.match(listing.r2Error, /accessKeyId/);
  assert.match(listing.r2Error, /secretAccessKey/);
  assert.deepEqual(listing.exclude.slice(0, 2), ["node_modules", ".next"]);

  // The bucket's location needs no keys: that is what `psync open` runs on.
  const location = mod.requireR2Location("demo", mod.loadConfig());
  assert.equal(location.bucket, "project-zips");
  assert.equal(location.endpoint, "https://acct123.r2.cloudflarestorage.com");
  assert.throws(
    () => mod.requireR2Location("demo", { defaults: {}, apps: {} }),
    /defaults\.r2\.bucket.*defaults\.r2\.accountId/
  );
});

test("transport and browser settings come from apps.json, with the environment on top", async () => {
  clearR2Env();
  delete process.env.PSYNC_TRANSPORT;
  delete process.env.PSYNC_CDP_URL;
  const { mod } = await withRegistry({
    defaults: { r2: { bucket: "b", accountId: "a" } },
    apps: { demo: {} },
  });
  const plain = mod.resolveApp({ appName: "demo" });
  assert.equal(plain.transport, "auto");
  assert.equal(plain.browser.cdpUrl, "http://localhost:9222");
  assert.equal(plain.browser.hidden, true);
  assert.match(plain.browser.profileDir, /psync-chrome$/);
  assert.equal(plain.browser.executable, undefined);

  const { mod: configured } = await withRegistry({
    defaults: {
      r2: { bucket: "b", accountId: "a" },
      transport: "browser",
      browser: { cdpUrl: "http://127.0.0.1:9333/", profileDir: "chrome-profile", hidden: false },
    },
    apps: { demo: {} },
  });
  const app = configured.resolveApp({ appName: "demo" });
  assert.equal(app.transport, "browser");
  assert.equal(app.browser.cdpUrl, "http://127.0.0.1:9333", "trailing slash dropped");
  assert.equal(app.browser.hidden, false);
  assert.ok(path.isAbsolute(app.browser.profileDir), "profile dir is resolved");
  assert.equal(app.r2Location.bucket, "b", "the browser route needs no keys");

  process.env.PSYNC_TRANSPORT = "api";
  process.env.PSYNC_CDP_URL = "http://localhost:9444";
  process.env.PSYNC_BROWSER_HIDDEN = "true";
  process.env.PSYNC_BROWSER_PROFILE = "env-profile";
  process.env.PSYNC_CHROME = "tools/chrome.exe";
  try {
    const overridden = configured.resolveApp({ appName: "demo" });
    assert.equal(overridden.transport, "api");
    assert.equal(overridden.browser.cdpUrl, "http://localhost:9444");
    assert.equal(overridden.browser.hidden, true);
    assert.equal(path.basename(overridden.browser.profileDir), "env-profile");
    assert.equal(path.basename(overridden.browser.executable), "chrome.exe");
  } finally {
    delete process.env.PSYNC_CHROME;
    delete process.env.PSYNC_TRANSPORT;
    delete process.env.PSYNC_CDP_URL;
    delete process.env.PSYNC_BROWSER_HIDDEN;
    delete process.env.PSYNC_BROWSER_PROFILE;
  }

  await assert.rejects(
    withRegistry({ defaults: { transport: "carrier-pigeon" }, apps: {} }).then(({ mod: m }) => m.loadConfig()),
    /defaults\.transport/
  );
});
