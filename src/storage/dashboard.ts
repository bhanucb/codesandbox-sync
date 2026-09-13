import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { BrowserSettings, R2Location } from "../config.js";
import type { Logger } from "../zip.js";
import { dashboardUrl, toKeyPrefix } from "./r2.js";
import type { RemoteZip, Storage } from "./types.js";

/** How long a human gets to sign in (2FA included) or tick a bot check. */
const HUMAN_MINUTES = 10;
/** Cloudflare's managed challenge clears itself for a normal browser in seconds. */
const CHALLENGE_GRACE_MS = 30_000;

/** Where Google Chrome usually is; PSYNC_CHROME or defaults.browser.executable wins. */
export function findChrome(executable?: string): string | undefined {
  const candidates =
    process.platform === "win32"
      ? [
          process.env.ProgramFiles,
          process.env["ProgramFiles(x86)"],
          process.env.LOCALAPPDATA,
        ]
          .filter((base): base is string => Boolean(base))
          .map((base) => path.join(base, "Google", "Chrome", "Application", "chrome.exe"))
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const candidate of [executable, ...candidates]) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function portOf(cdpUrl: string): string {
  try {
    return new URL(cdpUrl).port || "9222";
  } catch {
    return "9222";
  }
}

/** What to do when Chrome cannot be started. */
export function launchHint(settings: Pick<BrowserSettings, "cdpUrl" | "profileDir">): string {
  return [
    "Could not start Google Chrome. Install it (or point PSYNC_CHROME / defaults.browser.executable at it),",
    "or start it yourself and psync will attach to it:",
    `  chrome --remote-debugging-port=${portOf(settings.cdpUrl)} --user-data-dir="${settings.profileDir}" https://dash.cloudflare.com`,
    "(or add R2 keys to apps.json to use the S3 endpoint instead).",
  ].join("\n");
}

/** True when a Chrome debugging endpoint answers at the URL. */
export async function browserAvailable(cdpUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl.replace(/\/+$/, "")}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const UNIT_BYTES: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/** The dashboard prints decimal units: 34372797 bytes shows as "34.37 MB". */
export function parseSize(text: string): number | undefined {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)\b/);
  if (!match) {
    return undefined;
  }
  return Math.round(parseFloat(match[1]) * UNIT_BYTES[match[2]]);
}

/** "12 Sep 2026 21:02:22 EDT" as shown in the object table, else undefined. */
export function parseModified(text: string): number | undefined {
  const match = text.match(/(\d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2})(?:\s+([A-Z]{2,5}))?/);
  if (!match) {
    return undefined;
  }
  const withZone = match[2] ? Date.parse(`${match[1]} ${match[2]}`) : NaN;
  const parsed = Number.isNaN(withZone) ? Date.parse(match[1]) : withZone;
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** The upload stamps its ZIP name with Date.now(); that survives any display. */
export function timestampFromName(name: string): number | undefined {
  const match = name.match(/_(\d{10,})\.zip$/);
  return match ? Number(match[1]) : undefined;
}

export type FolderRow = {
  /** The link text: the object's name within the folder. */
  name: string;
  /** The whole row's text, where size and modified time live. */
  text: string;
};

/** Turns the object table into what sync needs: ZIPs, newest first. */
export function parseFolderListing(rows: readonly FolderRow[], prefix: string): RemoteZip[] {
  const keyPrefix = toKeyPrefix(prefix);
  const zips = rows
    .filter((row) => row.name.endsWith(".zip"))
    .map((row) => ({
      name: row.name,
      path: `${keyPrefix}${row.name}`,
      size: parseSize(row.text) ?? 0,
      mtime: parseModified(row.text) ?? timestampFromName(row.name) ?? 0,
    }));
  zips.sort(
    (a, b) =>
      b.mtime - a.mtime ||
      (timestampFromName(b.name) ?? 0) - (timestampFromName(a.name) ?? 0)
  );
  return zips;
}

/** Generous: assume at least 100 KB/s, never less than three minutes. */
function transferTimeout(bytes: number): number {
  return Math.max(180_000, Math.ceil(bytes / 100_000));
}

function mainText(page: Page): Promise<string> {
  return page.evaluate(
    () => (document.querySelector("main") ?? document.body).innerText
  );
}

type PageState = "ready" | "sign-in" | "challenge" | "missing";

/**
 * Cloudflare R2 through the dashboard, driven in Google Chrome. This is for
 * networks that block the S3 endpoint but allow the dashboard: the bytes
 * travel the same allowed route a person's clicks would take.
 *
 * psync starts Chrome itself — plainly, the way a person would from a
 * shortcut, with remote debugging on and a profile of its own — keeps the
 * window off-screen, attaches over the debugging port, and closes Chrome when
 * done. The first run on a machine finds no session in that profile: a visible
 * window opens and the human signs in; psync never types credentials, and
 * never answers a bot check either — if Cloudflare asks for a human, it shows
 * the window and waits for one. The profile keeps the session afterwards.
 * If a Chrome with remote debugging is already up, psync attaches to that one
 * instead and leaves it running.
 */
export class DashboardStorage implements Storage {
  readonly location: string;
  readonly browseUrl: string;

  private readonly prefix: string;
  private readonly bucketUrl: string;
  private readonly folderUrl: string;
  private readonly settings: BrowserSettings;
  private browser?: Browser;
  private page?: Page;
  /** True when psync started this Chrome, and so closes it. */
  private launched = false;
  private visible = false;

  constructor(
    r2: Pick<R2Location, "bucket" | "accountId">,
    prefix: string,
    settings: BrowserSettings
  ) {
    this.prefix = toKeyPrefix(prefix);
    this.bucketUrl = dashboardUrl(r2.accountId, r2.bucket);
    this.folderUrl = dashboardUrl(r2.accountId, r2.bucket, prefix);
    this.settings = settings;
    this.location = `dashboard:${r2.bucket}/${this.prefix}`;
    this.browseUrl = this.folderUrl;
  }

  private detailsUrl(key: string): string {
    return `${this.bucketUrl}/objects/${encodeURIComponent(key)}/details?prefix=${encodeURIComponent(this.prefix)}`;
  }

  private async open(log: Logger): Promise<Page> {
    if (this.page) {
      return this.page;
    }
    if (await browserAvailable(this.settings.cdpUrl)) {
      log(`  Attaching to the browser at ${this.settings.cdpUrl}…`);
      this.launched = false;
      this.visible = true;
      return this.attach();
    }
    await this.launch(!this.settings.hidden, log);
    return this.attach();
  }

  private async attach(): Promise<Page> {
    this.browser = await chromium.connectOverCDP(this.settings.cdpUrl);
    const context = this.browser.contexts()[0] ?? (await this.browser.newContext());
    const blank = context.pages().find((p) => p.url() === "about:blank");
    this.page = blank ?? (await context.newPage());
    return this.page;
  }

  /**
   * Starts Chrome as a person would, so it looks like what it is: a normal
   * browser. Not headless (Cloudflare's bot check turns HeadlessChrome away)
   * and not minimized (a minimized page gets throttled): "hidden" is a real
   * window placed off-screen, where the page runs exactly as on screen.
   */
  private async launch(visible: boolean, log: Logger): Promise<void> {
    const { profileDir, cdpUrl } = this.settings;
    const executable = findChrome(this.settings.executable);
    if (!executable) {
      throw new Error(launchHint(this.settings));
    }
    log(`  Starting Chrome ${visible ? "" : "off-screen "}with profile ${profileDir}…`);
    fs.mkdirSync(profileDir, { recursive: true });
    const args = [
      `--remote-debugging-port=${portOf(cdpUrl)}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1200,900",
      visible ? "--window-position=80,60" : "--window-position=-32000,-32000",
      "about:blank",
    ];
    try {
      const child = spawn(executable, args, { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${launchHint(this.settings)}\n  ${message}`);
    }

    const deadline = Date.now() + 30_000;
    while (!(await browserAvailable(cdpUrl))) {
      if (Date.now() > deadline) {
        throw new Error(
          `Chrome started but nothing answered at ${cdpUrl} within 30s. Is another Chrome already using the profile ${profileDir} without remote debugging? Close it and re-run.\n${launchHint(this.settings)}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    this.launched = true;
    this.visible = visible;
  }

  /** Reads which of the known page states is showing, waiting for one. */
  private async settle(page: Page, timeout = 60_000): Promise<PageState> {
    const ready = page.getByRole("button", { name: /^(upload|download)$/i }).first();
    const signIn = page.getByText(/Sign in to Cloudflare/i).first();
    const challenge = page
      .getByText(/Performing security verification|Verify you are human|Just a moment/i)
      .first();
    const missing = page.getByText(/Failed to find/i).first();
    await ready.or(signIn).or(challenge).or(missing).first().waitFor({ timeout });
    if (await signIn.isVisible().catch(() => false)) {
      return "sign-in";
    }
    if (await challenge.isVisible().catch(() => false)) {
      return "challenge";
    }
    if (await missing.isVisible().catch(() => false)) {
      return "missing";
    }
    return "ready";
  }

  /** Like settle, but gives a managed challenge time to clear on its own. */
  private async settleThroughChallenge(page: Page): Promise<PageState> {
    const deadline = Date.now() + CHALLENGE_GRACE_MS;
    let state = await this.settle(page);
    while (state === "challenge" && Date.now() < deadline) {
      await page.waitForTimeout(2000);
      state = await this.settle(page, 15_000).catch(() => "challenge" as const);
    }
    return state;
  }

  /**
   * Loads a dashboard page. A sign-in page or a bot check that wants a
   * person is not an error: the human gets a visible window and up to ten
   * minutes, and the profile remembers the outcome.
   */
  private async goto(url: string, log: Logger): Promise<Page> {
    let page = await this.open(log);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    let state = await this.settleThroughChallenge(page);

    if (state === "sign-in" || state === "challenge") {
      if (!this.visible) {
        log(`  ${state === "sign-in" ? "Not signed in yet" : "Cloudflare wants a human check"} — opening a Chrome window…`);
        await this.close(log);
        await this.launch(true, log);
        page = await this.attach();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        state = await this.settleThroughChallenge(page);
      }
      if (state === "sign-in" || state === "challenge") {
        log(
          state === "sign-in"
            ? `  Sign in to Cloudflare in the Chrome window (waiting up to ${HUMAN_MINUTES} minutes; the profile remembers it)…`
            : `  Tick "Verify you are human" in the Chrome window (waiting up to ${HUMAN_MINUTES} minutes)…`
        );
        const ready = page.getByRole("button", { name: /^(upload|download)$/i }).first();
        try {
          await ready.waitFor({ timeout: HUMAN_MINUTES * 60_000 });
        } catch {
          throw new Error(
            `Timed out after ${HUMAN_MINUTES} minutes waiting for you in the Chrome window. Re-run when ready.`
          );
        }
        log("  ✓ Thanks — carrying on");
        if (!page.url().startsWith(url.split("?")[0])) {
          await page.goto(url, { waitUntil: "domcontentloaded" });
          state = await this.settleThroughChallenge(page);
        } else {
          state = "ready";
        }
      }
    }

    if (state === "sign-in" || state === "challenge") {
      throw new Error("Cloudflare is still asking for you; re-run once the page shows the bucket.");
    }
    if (state === "missing") {
      throw new Error(`The dashboard has no such object: ${url}`);
    }
    return page;
  }

  async list(log: Logger): Promise<RemoteZip[]> {
    log(`  Reading ${this.prefix || "/"} in the dashboard…`);
    const page = await this.goto(this.folderUrl, log);
    // An empty folder never shows a ZIP link; give a populated one a moment to render.
    await page
      .locator("a", { hasText: /\.zip$/ })
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined);
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a"))
        .filter((a) => /\.zip$/.test((a.textContent ?? "").trim()))
        .map((a) => {
          const row = a.closest("tr,[role=row]") ?? a.parentElement;
          return {
            name: (a.textContent ?? "").trim(),
            text: (row as HTMLElement | null)?.innerText ?? "",
          };
        })
    );
    return parseFolderListing(rows, this.prefix);
  }

  async put(name: string, data: Buffer, log: Logger, localPath?: string): Promise<string> {
    const key = `${this.prefix}${name}`;
    const page = await this.goto(this.folderUrl, log);

    // The Upload button reveals two hidden file inputs: files, and a folder.
    await page.getByRole("button", { name: /^upload$/i }).first().click();
    const input = page.locator("input[type=file]:not([webkitdirectory])").first();
    await input.waitFor({ state: "attached", timeout: 10_000 });

    const timeout = transferTimeout(data.length);
    log(`  Handing ${name} to the browser (${(data.length / 1e6).toFixed(2)} MB)…`);
    if (localPath) {
      await input.setInputFiles(localPath, { timeout });
    } else {
      await input.setInputFiles({ name, mimeType: "application/zip", buffer: data }, { timeout });
    }

    log(`  Uploading through the dashboard…`);
    const deadline = Date.now() + timeout;
    let complete = false;
    while (Date.now() < deadline) {
      const text = await mainText(page);
      const progress = text.match(/(\d+)\/(\d+) files uploaded/);
      if (progress && progress[1] === progress[2]) {
        complete = true;
        break;
      }
      await page.waitForTimeout(2000);
    }
    if (!complete) {
      throw new Error(`The dashboard did not finish uploading ${name} within ${Math.round(timeout / 1000)}s`);
    }
    log(`  Upload completed`);

    log("Verifying upload…");
    const details = await this.goto(this.detailsUrl(key), log);
    const shown = (await mainText(details))
      .split("\n")
      .map((line) => parseSize(line))
      .filter((size): size is number => size !== undefined);
    // Sizes are shown to two decimals, so allow a rounding margin.
    const tolerance = Math.max(10_000, data.length * 0.001);
    if (!shown.some((size) => Math.abs(size - data.length) <= tolerance)) {
      throw new Error(
        `Size mismatch! Expected ${data.length} bytes for ${key}; the dashboard shows ${shown.join(", ") || "no size"}`
      );
    }
    log(`  ✓ Size matches!`);
    return key;
  }

  /**
   * The bytes go to Playwright's own temporary location, never the browser's
   * Downloads folder, and that temporary file is removed once read.
   */
  async get(zip: RemoteZip, log: Logger): Promise<Buffer> {
    const page = await this.goto(this.detailsUrl(zip.path), log);
    log(`  Downloading ${zip.name} through the dashboard…`);
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: transferTimeout(zip.size) }),
      page.getByRole("button", { name: /^download$/i }).first().click(),
    ]);
    const failure = await download.failure();
    if (failure) {
      throw new Error(`Download of ${zip.path} failed: ${failure}`);
    }
    const saved = await download.path();
    const buffer = fs.readFileSync(saved);
    fs.rmSync(saved, { force: true });
    return buffer;
  }

  async remove(zip: RemoteZip, log: Logger): Promise<void> {
    const page = await this.goto(this.detailsUrl(zip.path), log);
    // Belt and braces: the URL named the object, the page must agree before
    // anything destructive happens.
    const heading = await mainText(page);
    if (!heading.includes(zip.path)) {
      throw new Error(`Refusing to delete: the details page does not name ${zip.path}`);
    }
    await page.getByRole("button", { name: /^delete$/i }).first().click();

    const dialog = page.getByRole("dialog").or(page.getByRole("alertdialog")).first();
    await dialog.waitFor({ timeout: 10_000 });
    const text = await dialog.innerText();
    if (!text.includes(zip.path)) {
      await page.keyboard.press("Escape");
      throw new Error(`Refusing to confirm: the delete dialog does not name ${zip.path}: "${text}"`);
    }
    await dialog.getByRole("button", { name: /^delete$/i }).click();
    await dialog.waitFor({ state: "hidden", timeout: 30_000 });
  }

  /**
   * A Chrome psync started is closed outright. One it merely attached to
   * keeps running: only psync's own tab and debugging session go away.
   */
  async close(log: Logger): Promise<void> {
    const { page, browser, launched } = this;
    this.page = undefined;
    this.browser = undefined;
    this.launched = false;
    if (!browser) {
      return;
    }
    try {
      if (launched) {
        const session = await browser.newBrowserCDPSession();
        await session.send("Browser.close");
        log("  ✓ Closed Chrome");
      } else {
        await page?.close();
      }
    } catch {
      // Teardown only; the work is done.
    }
    await browser.close().catch(() => undefined);
  }
}
