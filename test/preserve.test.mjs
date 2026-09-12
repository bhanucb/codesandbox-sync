import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPreservePatterns, prepareDownloadDir } from "../dist/preserve.js";
import { LLM_EXCLUDE_PATTERNS } from "../dist/config.js";

const EXCLUDES = ["node_modules", ".next", ...LLM_EXCLUDE_PATTERNS, "dist"];

function fixture(dirs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "psync-preserve-"));
  for (const d of dirs) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, d, "marker"), "x");
  }
  return root;
}

test("preserves everything the upload excludes, naming no specific tool", () => {
  const root = fixture([
    ".claude", ".cursor", ".windsurf", ".continue", ".aider.tags.cache",
    "node_modules", "pkg/node_modules", "dist", "stale",
  ]);
  prepareDownloadDir(root, { log: () => {}, preservePatterns: EXCLUDES });

  for (const kept of [".claude", ".cursor", ".windsurf", ".continue", ".aider.tags.cache", "node_modules", "pkg/node_modules", "dist"]) {
    assert.ok(fs.existsSync(path.join(root, kept)), `${kept} should survive`);
  }
  assert.ok(!fs.existsSync(path.join(root, "stale")), "stale content should be removed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("removes what the upload does ship, so the ZIP is the source of truth", () => {
  const root = fixture([".vscode", ".idea", "src"]);
  prepareDownloadDir(root, { log: () => {}, preservePatterns: EXCLUDES });
  for (const gone of [".vscode", ".idea", "src"]) {
    assert.ok(!fs.existsSync(path.join(root, gone)), `${gone} comes back from the ZIP`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("keeps local git metadata that is never uploaded", () => {
  const root = fixture([".git/info"]);
  fs.writeFileSync(path.join(root, ".git/info/exclude"), "x");
  prepareDownloadDir(root, { log: () => {}, preservePatterns: EXCLUDES });
  assert.ok(fs.existsSync(path.join(root, ".git/info/exclude")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("preserveNodeModules=false drops node_modules at every depth", () => {
  const root = fixture(["node_modules", "pkg/node_modules", ".claude"]);
  prepareDownloadDir(root, { log: () => {}, preservePatterns: EXCLUDES, preserveNodeModules: false });
  assert.ok(!fs.existsSync(path.join(root, "node_modules")));
  assert.ok(!fs.existsSync(path.join(root, "pkg/node_modules")));
  assert.ok(fs.existsSync(path.join(root, ".claude")), "other exclusions still survive");
  fs.rmSync(root, { recursive: true, force: true });
});

test("buildPreservePatterns always adds local git metadata", () => {
  assert.ok(buildPreservePatterns([]).includes(".git/info/exclude"));
  assert.ok(buildPreservePatterns(["node_modules"], false).every((p) => p !== "node_modules"));
});

test("creates the directory when it does not exist", () => {
  const root = path.join(os.tmpdir(), `psync-preserve-new-${Date.now()}`);
  assert.deepEqual(prepareDownloadDir(root, { log: () => {} }), []);
  assert.ok(fs.existsSync(root));
  fs.rmSync(root, { recursive: true, force: true });
});
