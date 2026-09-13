import fs from "fs";
import { chromium, type Browser, type Page } from "playwright-core";
import type { BrowserSettings, R2Location } from "../config.js";
import type { Logger } from "../zip.js";
import { dashboardUrl, toKeyPrefix } from "./r2.js";
import type { RemoteZip, Storage } from "./types.js";

/**
 * How to start a browser psync can drive. A dedicated --user-data-dir is not
 * optional: Chrome refuses remote debugging on its default profile.
 */
export function browserHint(cdpUrl: string): string {
  let port = "9222";
  try {
    port = new URL(cdpUrl).port || port;
  } catch {
    // keep the default
  }
  const launch =
    process.platform === "win32"
      ? `start chrome --remote-debugging-port=${port} --user-data-dir=%LOCALAPPDATA%\\psync-chrome https://dash.cloudflare.com`
      : process.platform === "darwin"
        ? `open -na "Google Chrome" --args --remote-debugging-port=${port} --user-data-dir="$HOME/.psync-chrome" https://dash.cloudflare.com`
        : `google-chrome --remote-debugging-port=${port} --user-data-dir="$HOME/.psync-chrome" https://dash.cloudflare.com`;
  return [
    `No browser is listening at ${cdpUrl}. Start one, sign in to the dashboard, and keep it open:`,
    `  ${launch}`,
    "The separate --user-data-dir is required: Chrome refuses remote debugging on its default profile.",
    "The sign-in persists in that profile, so this is a one-time step per machine.",
  ].join("\n");
}

/** True when a Chrome debugging endpoint answers at the URL. */
export async function browserAvailable(cdpUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl.replace(/\/+$/, "")}/json/version`, {
      signal: AbortSignal.timeout(2000),
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

/**
 * Cloudflare R2 through the dashboard, driven in a browser the human has
 * already signed in to. This is for networks that block the S3 endpoint but
 * allow the dashboard: the bytes travel the same allowed route a person's
 * clicks would take. The browser is one the human started with remote
 * debugging on; psync attaches, never launches, and never types credentials.
 */
export class DashboardStorage implements Storage {
  readonly location: string;
  readonly browseUrl: string;

  private readonly prefix: string;
  private readonly bucketUrl: string;
  private readonly folderUrl: string;
  private readonly cdpUrl: string;
  private browser?: Browser;
  private page?: Page;

  constructor(
    r2: Pick<R2Location, "bucket" | "accountId">,
    prefix: string,
    settings: BrowserSettings
  ) {
    this.prefix = toKeyPrefix(prefix);
    this.bucketUrl = dashboardUrl(r2.accountId, r2.bucket);
    this.folderUrl = dashboardUrl(r2.accountId, r2.bucket, prefix);
    this.cdpUrl = settings.cdpUrl;
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
    if (!(await browserAvailable(this.cdpUrl))) {
      throw new Error(browserHint(this.cdpUrl));
    }
    log(`  Attaching to the browser at ${this.cdpUrl}…`);
    this.browser = await chromium.connectOverCDP(this.cdpUrl);
    const context = this.browser.contexts()[0] ?? (await this.browser.newContext());
    this.page = await context.newPage();
    return this.page;
  }

  /**
   * Loads a dashboard page and waits until it is either usable or clearly
   * not: the sign-in screen (the human's job) or a missing object.
   */
  private async goto(url: string, log: Logger): Promise<Page> {
    const page = await this.open(log);
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const ready = page.getByRole("button", { name: /^(upload|download)$/i }).first();
    const signIn = page.getByText(/Sign in to Cloudflare/i).first();
    const missing = page.getByText(/Failed to find/i).first();
    await ready.or(signIn).or(missing).first().waitFor({ timeout: 60_000 });

    if (await signIn.isVisible().catch(() => false)) {
      throw new Error(
        `The browser at ${this.cdpUrl} is showing the Cloudflare sign-in page. Sign in there — it stays signed in — then re-run.`
      );
    }
    if (await missing.isVisible().catch(() => false)) {
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

  close(log: Logger): void {
    // Only our own tab and the debugging session go away; the human's
    // browser, and their sign-in, stay exactly as they were.
    const page = this.page;
    const browser = this.browser;
    this.page = undefined;
    this.browser = undefined;
    void page?.close().catch(() => undefined);
    void browser?.close().catch(() => undefined);
  }
}
