# Handoff: pull an R2-hosted project onto this Windows machine

> Paste this whole file as your first message to a fresh Claude Code session
> **running on the Windows machine**. It is self-contained — you should not need
> the original conversation.

---

## Context (read first)

`project-sync` (CLI `psync`, also an MCP server) zips a local project, uploads
it to a **Cloudflare R2** bucket, and downloads + extracts it back. It exists to
move source between two machines that share no network.

- **Repo:** `bhanucb/codesandbox-sync` on GitHub. **Work branch:** `r2-storage-backend`
  (already pushed to `origin`). The package/CLI was renamed from `codesandbox-sync`
  to `project-sync`; the GitHub repo still carries the old name.
- **Two machines:**
  - A **Mac**, where the R2 S3 API works fully (uploads/downloads verified).
  - **This corporate Windows machine**, where the R2 API is **blocked** (details below).
- **R2 account id:** `9a407f3de26fca4e66bd1a515d87bb41` · **bucket:** `project-zips`
- **Bucket in the dashboard:**
  `https://dash.cloudflare.com/9a407f3de26fca4e66bd1a515d87bb41/r2/default/buckets/project-zips`
- Objects are keyed `<app>/<app>_<timestamp>.zip` (e.g. `ipa/ipa_1789255609780.zip`).
  Example app: **`ipa`**.

---

## Requirement

On this Windows machine, get the **latest zip for an app from R2 and extract it**
into that app's local `downloadDir`, even though the R2 API endpoint is blocked
here. The dashboard download path *is* reachable, so the intended flow is:

1. Claude (this session) drives the browser to the R2 bucket and downloads the
   latest `<app>_<timestamp>.zip`, **or** the human clicks download.
2. `psync` extracts that zip into the app's `downloadDir` with the correct
   preserve rules.

---

## What was done so far (on the `r2-storage-backend` branch)

- Added a Cloudflare **R2 backend** behind a small `Storage` interface
  (`src/storage/`), then **removed the old CodeSandbox backend entirely** and
  renamed everything to `project-sync` / `psync`.
- **`apps.json` is the only config file** (gitignored — machine-specific). It holds
  the R2 connection in `defaults.r2` (`bucket`, `accountId`, `accessKeyId`,
  `secretAccessKey`) plus the apps. Real env vars (`R2_BUCKET`, `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`) override. `dotenv`,
  `.env.local` and `.env.example` were removed. `SYNC_CONFIG` env var can point at
  an alternate registry.
- `remotePrefix` per app (default: app name); `include` list overrides exclusions
  (e.g. to ship `node_modules`).
- **`download --file <zip>` and `download --url <link>`**: extract a zip fetched
  out-of-band (dashboard, USB, approved transfer) using the *same* reset/preserve
  logic as a normal download. Also works as `npm run download -- --app <name> --file <zip>`.
- Corporate-network support: `HTTPS_PROXY` is wired into the S3 client; a non-S3
  (HTML) response now yields a clear diagnostic instead of an opaque
  `XML parse error: expected >`.
- **Verified on the Mac:** upload → download → checksum round trip for `ipa` works.

### Diagnosed state of this Windows machine

- `*.r2.cloudflarestorage.com` is **blocked by a Blue Coat / Symantec ProxySG**
  web gateway: `HTTP 503`, `<TITLE>URL Blocked</TITLE>`, header `P3P: CP="CAO PSA OUR"`.
- **TLS is intercepted** here (curl reported `CRYPT_E_NO_REVOCATION_CHECK` via schannel).
- **`dash.cloudflare.com` is reachable**, and downloading a file through the R2
  dashboard UI **works**. So: API path blocked, dashboard path allowed.

---

## What needs to be done (here, on Windows)

### 1. Set up the tool

```bash
git clone <repo-url> project-sync && cd project-sync
git checkout r2-storage-backend
npm install && npm run build
```

### 2. Create `apps.json` (not in the repo — it holds live credentials)

Copy `apps.example.json` to `apps.json` and fill in:
- `defaults.r2` with the real bucket / accountId / **accessKeyId / secretAccessKey**
  (the human has these; they live only in this gitignored file — never commit it).
- The app(s) you need, with **Windows** paths, e.g.:

```json
{
  "defaults": {
    "r2": {
      "bucket": "project-zips",
      "accountId": "9a407f3de26fca4e66bd1a515d87bb41",
      "accessKeyId": "<ask the human>",
      "secretAccessKey": "<ask the human>"
    }
  },
  "apps": {
    "ipa": {
      "sourceDir": "C:\\Users\\<you>\\Desktop\\apps\\ipa",
      "downloadDir": "C:\\Users\\<you>\\Downloads\\Apps\\ipa-webapp-refactoring"
    }
  }
}
```

> Known papercut: even `download --file` currently resolves R2 settings, so the
> `defaults.r2` block must be present (real values, since you have them) for the
> extract to run. If you want, make `requireR2Settings` lazy so `--file`/`--url`
> work with no credentials — optional, not required.

### 3. Get the zip and extract it

**The intended way — Claude drives the browser (this session, on Windows):**
- Ensure the **Chrome extension is connected** so this session can drive your real
  Chrome (the one already logged into Cloudflare — uses your live session, nothing
  stored).
- Open the bucket, download the newest `ipa_*.zip`, then extract:

```bash
psync download --app ipa --file "C:\Users\<you>\Downloads\ipa_<timestamp>.zip" --yes
```

(`--yes` skips the prompt; `download` **resets** `downloadDir` before extracting,
keeping whatever the upload excluded — node_modules, build output — plus
`.git/info/exclude`.)

**If `--url` turns out viable** (see verification), you can instead:
```bash
psync download --app ipa --url "<self-contained signed link>" --yes
```
Behind the proxy this direct fetch may need `HTTPS_PROXY`, and
`NODE_EXTRA_CA_CERTS` (corporate root CA) because TLS is intercepted here.

### Guardrails — do NOT

- **No circumvention of the proxy block.** No VPN/tunnel, no custom domain
  fronting the bucket, no public `r2.dev` bucket, no stored/persisted Cloudflare
  session scraped by a script. The dashboard is an *allowed* path; using it — by
  hand or driven live in the already-logged-in browser — is fine. Automating an
  *allowed* path is not the same as disguising a *blocked* one.
- **In parallel, prefer the clean fix:** ask IT to allowlist the single host
  `9a407f3de26fca4e66bd1a515d87bb41.r2.cloudflarestorage.com`, or ask for the
  sanctioned transfer method. If that host is allowlisted, plain
  `psync download --app ipa` works and none of the browser steps are needed.

---

## Verification steps

1. `npm run build` succeeds; `npm test` passes (38 tests).
2. `psync apps` lists the configured apps with no `x` (unusable) markers.
3. **Confirm the API really is blocked & you're on the new branch:** run
   `psync verify --app ipa`. It should fail with the new diagnostic
   (“… did not return an S3 response … URL Blocked … proxy/gateway”), not an
   `XML parse error`. That HTML block page is the expected symptom here.
4. **Is `--url` even possible?** In the browser: DevTools → Network, click Download
   on a small object, inspect the request that serves the bytes. Note the **host**
   and whether the URL carries a **signature/token in the query string**.
   - Self-contained signed URL on a reachable host → `--url` is viable.
   - Cookie/session-authenticated dashboard endpoint → `--url` won't work; use `--file`.
5. Do the download + `psync download --app ipa --file <zip>` and inspect
   `downloadDir` afterward.

---

## Acceptance criteria

- The **latest `ipa` zip from R2** is on this Windows machine and extracted into
  the app's `downloadDir`.
- Extraction **preserved** everything the upload excludes (e.g. `node_modules`,
  build output) and **removed** stale files, so the tree matches the Mac source.
  The reported checksum matches the uploaded zip.
- Achieved **only via the allowed dashboard path** (live login) — no circumvention
  technique used.
- Repeatable with low friction: one browser download + one `download --file`
  command (or Claude-driven during a session). Bonus: `requireR2Settings` made lazy
  so `--file` needs no credentials.
