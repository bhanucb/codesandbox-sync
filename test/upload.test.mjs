import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A registry whose S3 endpoint is a closed local port: every upload fails fast. */
async function withUnreachableR2(setup) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psync-upload-"));
  const src = path.join(root, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "app.txt"), "hello");
  fs.writeFileSync(
    path.join(root, "apps.json"),
    JSON.stringify({
      defaults: {
        transport: "api",
        r2: { bucket: "b", accountId: "a", endpoint: "http://127.0.0.1:1", accessKeyId: "k", secretAccessKey: "s" },
      },
      apps: { app: { sourceDir: src } },
    })
  );
  process.env.SYNC_CONFIG = path.join(root, "apps.json");
  process.env.AWS_MAX_ATTEMPTS = "1";
  const { uploadApp } = await import(`../dist/sync.js?t=${Date.now()}-${Math.random()}`);
  const { resolveApp } = await import(`../dist/config.js?t=${Date.now()}-${Math.random()}`);
  try {
    await setup({ uploadApp, app: resolveApp({ appName: "app" }) });
  } finally {
    delete process.env.SYNC_CONFIG;
    delete process.env.AWS_MAX_ATTEMPTS;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a dry run keeps the ZIP and says where it is", async () => {
  await withUnreachableR2(async ({ uploadApp, app }) => {
    const lines = [];
    const result = await uploadApp(app, { dryRun: true, log: (m) => lines.push(m) });
    assert.ok(result.localZipPath && fs.existsSync(result.localZipPath), "ZIP kept");
    assert.ok(lines.some((l) => l.includes(result.localZipPath)), "path is logged");
    fs.rmSync(result.localZipPath, { force: true });
  });
});

test("a failed upload keeps the ZIP and tells you where to find it", async () => {
  await withUnreachableR2(async ({ uploadApp, app }) => {
    let kept;
    await assert.rejects(
      uploadApp(app, { log: () => {} }),
      (error) => {
        const match = error.message.match(/The ZIP is ready at (.+?) — upload it by hand into app\//);
        assert.ok(match, `message names the ZIP: ${error.message}`);
        kept = match[1];
        assert.match(error.message, /psync open --app app/);
        return true;
      }
    );
    assert.ok(fs.existsSync(kept), "ZIP still on disk after the failure");
    fs.rmSync(kept, { force: true });
  });
});
