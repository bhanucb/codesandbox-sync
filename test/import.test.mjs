import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

async function withApp(setup) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psync-import-"));
  const src = path.join(root, "src");
  const dl = path.join(root, "dl");
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dl, { recursive: true });
  fs.writeFileSync(
    path.join(root, "apps.json"),
    JSON.stringify({
      defaults: { r2: { bucket: "b", accountId: "a", accessKeyId: "k", secretAccessKey: "s" } },
      apps: { app: { sourceDir: src, downloadDir: dl } },
    })
  );
  process.env.SYNC_CONFIG = path.join(root, "apps.json");
  const { importZipFile } = await import(`../dist/sync.js?t=${Date.now()}-${Math.random()}`);
  const { resolveApp } = await import(`../dist/config.js?t=${Date.now()}-${Math.random()}`);
  try {
    await setup({ root, src, dl, importZipFile, resolveApp });
  } finally {
    delete process.env.SYNC_CONFIG;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeZip(root, files) {
  const stage = fs.mkdtempSync(path.join(root, "stage-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(stage, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  const zip = path.join(root, "app_123.zip");
  execFileSync("zip", ["-qr", zip, "."], { cwd: stage });
  return zip;
}

test("import extracts a local ZIP with the same preserve rules as a download", async () => {
  await withApp(async ({ root, dl, importZipFile, resolveApp }) => {
    fs.mkdirSync(path.join(dl, "node_modules/keep"), { recursive: true });
    fs.writeFileSync(path.join(dl, "node_modules/keep/i.js"), "cached");
    fs.writeFileSync(path.join(dl, "stale.txt"), "gone");

    const zip = makeZip(root, { "app.txt": "hello" });
    const result = await importZipFile(resolveApp({ appName: "app" }), zip, {});

    assert.equal(result.extracted, true);
    assert.equal(fs.readFileSync(path.join(dl, "app.txt"), "utf8"), "hello");
    assert.ok(fs.existsSync(path.join(dl, "node_modules/keep/i.js")), "node_modules preserved");
    assert.ok(!fs.existsSync(path.join(dl, "stale.txt")), "stale file wiped");
    assert.ok(!fs.existsSync(path.join(dl, "app_123.zip")), "zip removed after extract");
  });
});

test("import rejects a missing file and a non-zip", async () => {
  await withApp(async ({ root, importZipFile, resolveApp }) => {
    const app = resolveApp({ appName: "app" });
    await assert.rejects(importZipFile(app, path.join(root, "nope.zip"), {}), /not found/i);
    const txt = path.join(root, "notazip.txt");
    fs.writeFileSync(txt, "x");
    await assert.rejects(importZipFile(app, txt, {}), /Not a \.zip/);
  });
});
