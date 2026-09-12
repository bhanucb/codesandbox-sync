import test from "node:test";
import assert from "node:assert/strict";
import { zipEntryMatchesExclude } from "../dist/zip.js";
import { LLM_EXCLUDE_PATTERNS } from "../dist/config.js";

const patterns = ["node_modules", ".next", ...LLM_EXCLUDE_PATTERNS];
const excluded = (p) => zipEntryMatchesExclude(p, patterns);

test("excludes dependency and build directories at any depth", () => {
  assert.ok(excluded("node_modules/react/index.js"));
  assert.ok(excluded("packages/web/node_modules/x"));
  assert.ok(excluded(".next/server/page.js"));
});

test("excludes LLM assistant state", () => {
  for (const p of [
    ".claude",
    ".claude/settings.json",
    "packages/web/.claude/settings.json",
    ".cursor/rules/a.mdc",
    ".cursorrules",
    ".aider.chat.history.md",
    ".windsurfrules",
    ".mcp.json",
    ".specstory/history/x.md",
  ]) {
    assert.ok(excluded(p), `${p} should be excluded`);
  }
});

test("keeps Microsoft Copilot configuration", () => {
  assert.ok(!excluded(".github/copilot-instructions.md"));
  assert.ok(!excluded(".vscode/settings.json"));
  assert.ok(!excluded(".claude-copilot/notes.md"));
});

test("the Copilot exception does not leak files out of an excluded tree", () => {
  assert.ok(excluded(".claude/worktrees/x/.github/copilot-instructions.md"));
});

test("the Copilot exception does not override non-LLM patterns", () => {
  assert.ok(excluded("node_modules/copilot-sdk/index.js"));
});

test("leaves ordinary project files alone", () => {
  for (const p of [".git/config", ".gitignore", "README.md", "src/index.ts", ".env.example"]) {
    assert.ok(!excluded(p), `${p} should be kept`);
  }
});

test("wildcard patterns match a prefix, not a substring", () => {
  assert.ok(!excluded(".claudia/keep.txt"));
  assert.ok(excluded(".claude-plugin/x"));
});

test("slash patterns match a path prefix only", () => {
  assert.ok(zipEntryMatchesExclude("build/cache/x", ["build/cache"]));
  assert.ok(!zipEntryMatchesExclude("src/build/cache", ["build/cache"]));
});

test("include overrides an exclusion, at any depth", () => {
  const ship = (p, inc) => !zipEntryMatchesExclude(p, patterns, inc);

  assert.equal(ship("node_modules/left-pad/index.js", []), false);
  assert.equal(ship("node_modules/left-pad/index.js", ["node_modules"]), true);
  // A narrower include lifts only its own subtree.
  assert.equal(ship("node_modules/left-pad/index.js", ["node_modules/left-pad"]), true);
  assert.equal(ship("node_modules/other/index.js", ["node_modules/left-pad"]), false);
});

test("include overrides the built-in assistant exclusions too", () => {
  const ship = (p, inc) => !zipEntryMatchesExclude(p, patterns, inc);
  assert.equal(ship(".claude/settings.json", []), false);
  assert.equal(ship(".claude/settings.json", [".claude"]), true);
});

test("include does not widen beyond what it names", () => {
  const ship = (p, inc) => !zipEntryMatchesExclude(p, patterns, inc);
  assert.equal(ship(".next/build", ["node_modules"]), false);
});
