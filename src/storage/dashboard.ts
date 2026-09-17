import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { BrowserSettings, R2Location } from "../config.js";
import { OUTPUT_DIR } from "../paths.js";
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

/**
 * Generous: assume as little as 50 KB/s on a throttled corporate link, and
 * never less than five minutes. In milliseconds — the rate is per second, so
 * it has to be scaled, or every size collapses onto the floor.
 */
export function transferTimeout(bytes: number): number {
  return Math.max(300_000, Math.ceil(bytes / 50_000) * 1000);
}

/** The dashboard's upload panel counts files, e.g. "0/1 files uploaded". */
export function parseUploadProgress(
  text: string
): { done: number; total: number } | undefined {
  const match = text.match(/(\d+)\s*\/\s*(\d+)\s*files uploaded/i);
  return match ? { done: Number(match[1]), total: Number(match[2]) } : undefined;
}

function mainText(page: Page): Promise<string> {
  return page.evaluate(
    () => (document.querySelector("main") ?? document.body).innerText
  );
}

/** "unknown" is a page psync does not recognise — a person has to look. */
type PageState = "ready" | "sign-in" | "challenge" | "missing" | "unknown";

const NEEDS_A_PERSON: ReadonlySet<PageState> = new Set(["sign-in", "challenge", "unknown"]);

/** Has this profile ever been used? A fresh one has no Default profile yet. */
export function isFreshProfile(profileDir: string): boolean {
  return !fs.existsSync(path.join(profileDir, "Default"));
}

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
      try {
        return await this.attach();
      } catch {
        // The port answered but the browser is going away — one that is
        // shutting down still serves /json/version for a moment. Wait for it
        // to let go, then start a fresh one below.
        log("  That browser was closing — starting a fresh one…");
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && (await browserAvailable(this.settings.cdpUrl))) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
    // A profile that has never been used cannot be signed in: start on screen
    // straight away rather than off-screen and back.
    let visible = !this.settings.hidden;
    if (!visible && isFreshProfile(this.settings.profileDir)) {
      log("  First run with this profile — Chrome will stay on screen so you can sign in.");
      visible = true;
    }
    await this.launch(visible, log);
    return this.attach();
  }

  /** One line saying what the page shows, for logs and errors. */
  private async describe(page: Page): Promise<string> {
    const title = await page.title().catch(() => "(no title)");
    const text = (await mainText(page).catch(() => ""))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);
    return `"${title}" at ${page.url()}${text ? ` — ${text}` : ""}`;
  }

  /** Saves what the page looks like, so the human can see what psync saw. */
  private async snapshot(page: Page): Promise<string | undefined> {
    try {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
      const file = path.join(OUTPUT_DIR, `dashboard-${Date.now()}.png`);
      await page.screenshot({ path: file });
      return file;
    } catch {
      return undefined;
    }
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

  /**
   * The folder page is ready when its Upload button shows — or, for a folder
   * with nothing in it yet, the drop zone the dashboard shows instead. The
   * object page is ready when its Download button shows.
   */
  private readyLocator(page: Page) {
    return page
      .getByRole("button", { name: /^(upload|download|add folder)$/i })
      .first()
      .or(page.getByText(/Drag and drop|No objects/i).first());
  }

  /** Reads which of the known page states is showing, waiting for one. */
  private async settle(page: Page, timeout = 60_000): Promise<PageState> {
    const ready = this.readyLocator(page);
    const signIn = page.getByText(/Sign in to Cloudflare|Log in to Cloudflare/i).first();
    const challenge = page
      .getByText(/Performing security verification|Verify you are human|Just a moment/i)
      .first();
    const missing = page.getByText(/Failed to find/i).first();
    try {
      await ready.or(signIn).or(challenge).or(missing).first().waitFor({ timeout });
    } catch {
      return /\/login\b/.test(page.url()) ? "sign-in" : "unknown";
    }
    if (/\/login\b/.test(page.url()) || (await signIn.isVisible().catch(() => false))) {
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
      state = await this.settle(page, 15_000);
    }
    return state;
  }

  private async whyAPerson(page: Page, state: PageState): Promise<string> {
    switch (state) {
      case "sign-in":
        return "Not signed in yet";
      case "challenge":
        return "Cloudflare wants a human check";
      default:
        return `Unexpected page: ${await this.describe(page)}`;
    }
  }

  /**
   * Loads a dashboard page. A sign-in page, a bot check, or a page psync
   * does not recognise is not an error yet: the human gets a visible window
   * and up to ten minutes to get it to the bucket, and the profile remembers
   * the outcome.
   */
  private async goto(url: string, log: Logger): Promise<Page> {
    let page = await this.open(log);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    let state = await this.settleThroughChallenge(page);

    if (NEEDS_A_PERSON.has(state)) {
      if (!this.visible) {
        log(`  ${await this.whyAPerson(page, state)} — opening a Chrome window…`);
        await this.close(log);
        await this.launch(true, log);
        page = await this.attach();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        state = await this.settleThroughChallenge(page);
      }
      if (NEEDS_A_PERSON.has(state)) {
        if (state === "unknown") {
          const shot = await this.snapshot(page);
          log(`  This is not a page psync recognises: ${await this.describe(page)}`);
          if (shot) {
            log(`  Screenshot: ${shot}`);
          }
        }
        log(
          state === "sign-in"
            ? `  Sign in to Cloudflare in the Chrome window (waiting up to ${HUMAN_MINUTES} minutes; the profile remembers it)…`
            : state === "challenge"
              ? `  Tick "Verify you are human" in the Chrome window (waiting up to ${HUMAN_MINUTES} minutes)…`
              : `  In the Chrome window, get to the bucket page — sign in, accept any prompt (waiting up to ${HUMAN_MINUTES} minutes)…`
        );
        try {
          await this.readyLocator(page).waitFor({ timeout: HUMAN_MINUTES * 60_000 });
        } catch {
          throw new Error(
            `Timed out after ${HUMAN_MINUTES} minutes waiting for you in the Chrome window. It showed: ${await this.describe(page)}. Re-run when ready.`
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

    if (NEEDS_A_PERSON.has(state)) {
      throw new Error(
        `Cloudflare is still asking for you; re-run once the page shows the bucket. It showed: ${await this.describe(page)}`
      );
    }
    if (state === "missing") {
      throw new Error(`The dashboard has no such object: ${url}`);
    }
    return page;
  }

  async list(log: Logger): Promise<RemoteZip[]> {
    log(`  Reading ${this.prefix || "/"} in the dashboard…`);
    const page = await this.goto(this.folderUrl, log);
    // An empty folder never shows a ZIP link; give a populated one a moment to
    // render, then settle, since the rows arrive after the page is "ready".
    await page
      .locator("a", { hasText: /\.zip$/ })
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined);
    await page.waitForTimeout(1500);
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

    // The folder view resolves after the bucket page itself does, and the
    // upload lands in whatever folder is showing when the file is handed
    // over. Handing it over too early stored nothing at all, so settle first.
    await page.waitForTimeout(3000);

    // The Upload button reveals two hidden file inputs: files, and a folder.
    // A folder with nothing in it yet shows that drop zone already, with no
    // button to click — the first upload into a new prefix lands here.
    const uploadButton = page.getByRole("button", { name: /^upload$/i }).first();
    if (await uploadButton.isVisible().catch(() => false)) {
      await uploadButton.click();
    }
    const input = page.locator("input[type=file]:not([webkitdirectory])").first();
    try {
      await input.waitFor({ state: "attached", timeout: 10_000 });
    } catch {
      const shot = await this.snapshot(page);
      throw new Error(
        `Could not find the upload control on ${await this.describe(page)}${shot ? ` (screenshot: ${shot})` : ""}`
      );
    }

    const timeout = transferTimeout(data.length);
    log(`  Handing ${name} to the browser (${(data.length / 1e6).toFixed(2)} MB)…`);
    if (localPath) {
      await input.setInputFiles(localPath, { timeout });
    } else {
      await input.setInputFiles({ name, mimeType: "application/zip", buffer: data }, { timeout });
    }

    log(`  Uploading through the dashboard…`);
    const panel = await this.watchUploadPanel(page, timeout, log);
    log(
      panel === "timeout"
        ? `  The panel never reported finishing within ${Math.round(timeout / 1000)}s — asking the bucket instead…`
        : `  Upload finished`
    );

    log("Verifying upload…");
    await this.confirmStored(name, data.length, panel, log);
    return key;
  }

  /**
   * Follows the dashboard's upload panel. The panel is a hint about *when*
   * the transfer settled, never the verdict: it dismisses itself once done,
   * and a dismissed panel looks exactly like one that never appeared. So
   * every outcome here — "timeout" included — is handed to confirmStored,
   * which asks the bucket. Treating the panel as the verdict is what made a
   * finished upload report failure.
   */
  private async watchUploadPanel(
    page: Page,
    timeout: number,
    log: Logger
  ): Promise<"done" | "dismissed" | "timeout"> {
    const started = Date.now();
    const deadline = started + timeout;
    let seen = false;
    let lastLogged = 0;

    while (Date.now() < deadline) {
      const progress = parseUploadProgress(await mainText(page).catch(() => ""));
      if (progress) {
        seen = true;
        if (progress.total > 0 && progress.done === progress.total) {
          return "done";
        }
        const elapsed = Date.now() - started;
        if (elapsed - lastLogged >= 30_000) {
          lastLogged = elapsed;
          log(
            `    still uploading: ${progress.done}/${progress.total} after ${Math.round(elapsed / 1000)}s`
          );
        }
      } else if (seen) {
        return "dismissed";
      }
      await page.waitForTimeout(2000);
    }
    return "timeout";
  }

  /**
   * The bucket is the arbiter: the folder listing either holds the object at
   * the right size or it does not. Deliberately the listing and not the
   * object's own page — that page is unreliable for longer keys, while the
   * listing is the same view `list` already reads for every transfer.
   * Retried briefly, since a large upload can take a moment to appear.
   */
  private async confirmStored(
    name: string,
    expected: number,
    panel: "done" | "dismissed" | "timeout",
    log: Logger
  ): Promise<void> {
    // Sizes are shown to two decimals, so allow a rounding margin.
    const tolerance = Math.max(10_000, expected * 0.001);
    const quiet: Logger = () => {};
    let reason = `it is not in ${this.prefix || "the bucket"}`;

    for (let attempt = 1; attempt <= 3; attempt++) {
      // Read the folder afresh, from the bucket page inwards. Listing the
      // same page that just uploaded can show the dashboard's own optimistic
      // view of what it is still writing, which is how a stored-nothing
      // upload once passed verification.
      const page = await this.open(quiet);
      await page.goto(this.bucketUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      await page.waitForTimeout(2000);

      const stored = await this.list(attempt === 1 ? log : quiet).catch(() => []);
      const found = stored.find((zip) => zip.name === name);
      if (found) {
        if (Math.abs(found.size - expected) <= tolerance) {
          log(`  ✓ Size matches!`);
          return;
        }
        reason = `it is there at about ${found.size} bytes, not ${expected}`;
      }
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }

    throw new Error(
      `The bucket does not have ${this.prefix}${name} at the expected size — ${reason}.${
        panel === "timeout" ? " The upload was still running when the wait ran out." : ""
      }`
    );
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
