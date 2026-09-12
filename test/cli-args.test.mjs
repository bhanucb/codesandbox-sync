import test from "node:test";
import assert from "node:assert/strict";
import { resolveCliApp } from "../dist/cli.js";

test("a bare argument is rejected, not silently ignored", () => {
  // `npm run upload --app foo` forwards only "foo": npm claims --app itself.
  // Ignoring it used to fall through to defaults.app and upload another project.
  assert.throws(() => resolveCliApp(["project-sync"]), (error) => {
    assert.match(error.message, /Unexpected argument "project-sync"/);
    assert.match(error.message, /-- --app project-sync/);
    return true;
  });
});

test("an unknown option is rejected", () => {
  assert.throws(() => resolveCliApp(["--ap", "demo"]), /Unknown option "--ap"/);
});

test("supported flags pass the check", () => {
  // Resolution itself may still fail on config; the arg check must not.
  for (const argv of [["--dry-run"], ["--app=demo"], ["--app", "demo"]]) {
    try {
      resolveCliApp(argv);
    } catch (error) {
      assert.doesNotMatch(error.message, /Unexpected argument|Unknown option/);
    }
  }
});

test("psync's own richer flags are not validated here", () => {
  try {
    resolveCliApp(["upload", "--prefix", "x"], { validate: false });
  } catch (error) {
    assert.doesNotMatch(error.message, /Unexpected argument|Unknown option/);
  }
});
