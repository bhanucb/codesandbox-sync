import test from "node:test";
import assert from "node:assert/strict";
import { dashboardUrl } from "../dist/storage/r2.js";
import {
  DashboardStorage,
  findChrome,
  launchHint,
  parseFolderListing,
  parseUploadProgress,
  parseModified,
  parseSize,
  timestampFromName,
  transferTimeout,
} from "../dist/storage/dashboard.js";

test("the dashboard URL lands on the bucket, or on a folder when given a prefix", () => {
  assert.equal(
    dashboardUrl("acct", "project-zips"),
    "https://dash.cloudflare.com/acct/r2/default/buckets/project-zips"
  );
  assert.equal(
    dashboardUrl("acct", "project-zips", "ipa"),
    "https://dash.cloudflare.com/acct/r2/default/buckets/project-zips?prefix=ipa%2F"
  );
});

test("a nested or slash-wrapped prefix becomes one clean folder key", () => {
  assert.equal(
    dashboardUrl("acct", "b", "/team/ipa/"),
    "https://dash.cloudflare.com/acct/r2/default/buckets/b?prefix=team%2Fipa%2F"
  );
});

test("sizes are read the way the dashboard prints them: decimal units", () => {
  assert.equal(parseSize("34.37 MB"), 34_370_000);
  assert.equal(parseSize("application/zip Standard 812 KB 12 Sep 2026"), 812_000);
  assert.equal(parseSize("1.5 GB"), 1_500_000_000);
  assert.equal(parseSize("no size here"), undefined);
});

test("modified times parse with or without a zone; the name's stamp is the fallback", () => {
  const withZone = parseModified("ipa_1.zip application/zip 34.37 MB 12 Sep 2026 21:02:22 EDT");
  const bare = parseModified("12 Sep 2026 21:02:22");
  assert.ok(withZone && bare, "both forms parse");
  assert.equal(new Date(withZone).getUTCDate(), 13, "EDT is four hours behind UTC");
  assert.equal(parseModified("yesterday"), undefined);
  assert.equal(timestampFromName("ipa_1789261337722.zip"), 1789261337722);
  assert.equal(timestampFromName("notes.zip"), undefined);
});

test("the folder listing keeps ZIPs only, keyed under the prefix, newest first", () => {
  const rows = [
    { name: "ipa_1789190867448.zip", text: "ipa_1789190867448.zip\tapplication/zip\tStandard\t34.37 MB\t12 Sep 2026 01:27:51 EDT" },
    { name: "README.md", text: "README.md\ttext/markdown\tStandard\t2 KB\t12 Sep 2026 01:27:51 EDT" },
    { name: "ipa_1789261337722.zip", text: "ipa_1789261337722.zip\tapplication/zip\tStandard\t34.37 MB\t12 Sep 2026 21:02:22 EDT" },
    { name: "ipa_1789255609780.zip", text: "ipa_1789255609780.zip\tapplication/zip\tStandard\t34.37 MB" },
  ];
  const zips = parseFolderListing(rows, "ipa");
  assert.deepEqual(
    zips.map((z) => z.name),
    ["ipa_1789261337722.zip", "ipa_1789255609780.zip", "ipa_1789190867448.zip"]
  );
  assert.equal(zips[0].path, "ipa/ipa_1789261337722.zip");
  assert.equal(zips[0].size, 34_370_000);
  // No modified column: the name's own stamp still orders it correctly.
  assert.equal(zips[1].mtime, 1789255609780);
});

test("the storage attaches lazily, so building it never needs a browser", async () => {
  const storage = new DashboardStorage(
    { bucket: "project-zips", accountId: "acct" },
    "ipa",
    { cdpUrl: "http://localhost:1", profileDir: "/tmp/psync-chrome", hidden: true }
  );
  assert.equal(storage.location, "dashboard:project-zips/ipa/");
  assert.equal(
    storage.browseUrl,
    "https://dash.cloudflare.com/acct/r2/default/buckets/project-zips?prefix=ipa%2F"
  );
  await storage.close(() => {});
});

test("a Chrome that will not start is explained with the manual launch command", () => {
  const hint = launchHint({ cdpUrl: "http://localhost:9333", profileDir: "C:\\p\\chrome" });
  assert.match(hint, /--remote-debugging-port=9333/);
  assert.ok(hint.includes('--user-data-dir="C:\\p\\chrome"'), "names the profile to reuse");
  assert.match(hint, /dash\.cloudflare\.com/);
  assert.match(hint, /R2 keys/);
});

test("an explicit Chrome binary wins, but only when it exists", () => {
  const found = findChrome();
  assert.ok(found === undefined || found.length > 0, "either a path or nothing");
  assert.equal(findChrome("/definitely/not/here/chrome"), found, "a missing override is ignored");
  assert.equal(findChrome(process.execPath), process.execPath, "an existing override is taken as-is");
});

test("the transfer allowance scales with size, in milliseconds", () => {
  // A rate is per second, so it has to be scaled up: without that every size
  // collapses onto the floor and a big upload is cut off early.
  assert.equal(transferTimeout(1_000), 300_000, "a small file still gets the floor");
  assert.equal(transferTimeout(50_000_000), 1_000_000, "50 MB at 50 KB/s is 1000s");
  assert.ok(
    transferTimeout(2_000_000_000) > 300_000,
    "a multi-gigabyte upload is not capped at the floor"
  );
});

test("upload progress is read from the dashboard's panel, or reported absent", () => {
  assert.deepEqual(parseUploadProgress("0/1 files uploaded Cancel"), { done: 0, total: 1 });
  assert.deepEqual(parseUploadProgress("3 / 3 files uploaded"), { done: 3, total: 3 });
  // The panel dismisses itself when it finishes, which must not read as failure.
  assert.equal(parseUploadProgress("Drag and drop to start uploading"), undefined);
});
