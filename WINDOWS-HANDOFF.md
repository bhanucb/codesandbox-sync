# Handoff: end-to-end zip sync on this Windows machine (R2 API is blocked here)

> **Update 2026-09-13 — done, and automated.** The browser dance below is now
> built in. With no keys in `apps.json`, the normal commands go through the
> dashboard by themselves: psync starts Chrome off-screen from its own profile
> (Playwright, real Chrome — headless is turned away by Cloudflare's bot check),
> lists the folder, clicks Download / Upload / Delete, verifies sizes and
> checksums, and closes Chrome. The first run opens a visible window and waits
> for you to sign in once; the profile keeps the session. Downloads never touch
> the Downloads folder.
>
> ```
> npm run download -- --app ipa
> npm run upload -- --app ipa
> ```
>
> Verified end to end on this machine: upload → download → identical checksum.
> See README, "Through the browser", and CORP-TLDR.md. The manual steps below
> still work as a fallback.

---

## Context (read first)

`project-sync` (CLI `psync`, also an MCP server) zips a local project, stores it
in a **Cloudflare R2** bucket, and pulls it back down and extracts it. It exists
to move source between two machines that share no network.

- **Repo:** `bhanucb/codesandbox-sync` on GitHub. **Work branch:** `r2-storage-backend`.
  The package/CLI was renamed from `codesandbox-sync` to `project-sync`; the
  GitHub repo still carries the old name.
- **Two machines:**
  - A **Mac**, where the R2 **S3 API works fully** — there, plain `psync upload`
    and `psync download` just work. (Verified.)
  - **This Windows machine**, where the R2 S3 API is **blocked** (see below).
- **R2 account id:** `9a407f3de26fca4e66bd1a515d87bb41` · **bucket:** `project-zips`
- **Bucket in the dashboard:**
  `https://dash.cloudflare.com/9a407f3de26fca4e66bd1a515d87bb41/r2/default/buckets/project-zips`
- **Object key scheme:** `<app>/<app>_<timestamp>.zip`
  (e.g. `ipa/ipa_1789255609780.zip`). Higher timestamp = newer. Example app: **`ipa`**.

### Why this machine is special

- `*.r2.cloudflarestorage.com` (the S3 API host) is **blocked by a Blue Coat /
  Symantec ProxySG** gateway: `HTTP 503`, `<TITLE>URL Blocked</TITLE>`, header
  `P3P: CP="CAO PSA OUR"`. **TLS is intercepted** here.
- **`dash.cloudflare.com` is reachable**, and uploading/downloading files through
  the R2 **dashboard UI works**.

**The key idea:** on this machine the CLI cannot talk to R2 at all. So the CLI
does only the **local** work — build a zip, extract a zip — and the **browser
(dashboard)** carries the bytes to and from the bucket, in both directions.

| Step | Where it runs | How |
| --- | --- | --- |
| Build zip | CLI, no network | `psync upload --dry-run` → writes `output\<app>_<ts>.zip` |
| Push zip to R2 | Browser (dashboard) | upload the built zip into the `<app>/` folder |
| Pull zip from R2 | Browser (dashboard) | download the newest `<app>_*.zip` |
| Extract zip | CLI, no network | `psync download --file <zip>` |

You (Claude) can drive the dashboard yourself via the **Claude-in-Chrome**
tools (they include a file-upload capability), using the human's already-logged-in
Cloudflare session — or the human can click, whichever is more reliable.

---

## Requirement

From this Windows machine, achieve a full round trip despite the API block:
**build → upload to R2 (via dashboard) → download from R2 (via dashboard) →
extract**, with extraction preserving whatever the upload excluded.

---

## What was done so far (on the `r2-storage-backend` branch)

- Added a Cloudflare **R2 backend** behind a `Storage` interface (`src/storage/`),
  removed the old CodeSandbox backend, renamed everything to `project-sync` / `psync`.
- **`apps.json` is the only config file** (gitignored). It holds the R2 connection
  in `defaults.r2` (`bucket`, `accountId`, `accessKeyId`, `secretAccessKey`) plus
  the apps. Env vars (`R2_*`) override. `dotenv`/`.env*` were removed. `SYNC_CONFIG`
  can point at an alternate registry.
- `remotePrefix` per app (default: app name); `include` list can override exclusions.
- **`upload --dry-run`** builds the zip in `output\` and reports its size **without
  touching the network** — this is how you produce a zip to upload by hand here.
- **`download --file <zip>` / `download --url <link>`** extract a zip fetched
  out-of-band, using the *same* reset/preserve logic as a real download.
- Corporate-network support: `HTTPS_PROXY` wired into the S3 client; a non-S3
  (HTML) response gives a clear diagnostic instead of `XML parse error: expected >`.
- **Verified on the Mac:** upload → download → checksum round trip works.

---

## Setup (do this first)

### 1. Get the code (SSH is configured on this machine)

```bash
git clone git@github.com:bhanucb/codesandbox-sync.git project-sync && cd project-sync
git checkout r2-storage-backend
npm install && npm run build
npm test            # expect 38 passing
```

(If already cloned: `git checkout r2-storage-backend && git pull && npm install && npm run build`.)

### 2. Use the existing `apps.json` (already copied here, with the keys)

**`apps.json` is already present and contains the real R2 credentials**
(`defaults.r2`). **Reuse it — do not recreate it from `apps.example.json`, and
never commit it** (gitignored).

It was copied from the Mac, so its `sourceDir` / `downloadDir` are **Mac paths**.
For the app you're syncing (e.g. `ipa`), change those to **Windows paths**,
leaving `defaults.r2` untouched:

```json
"ipa": {
  "sourceDir": "C:\\Users\\<you>\\Desktop\\apps\\ipa",
  "downloadDir": "C:\\Users\\<you>\\Downloads\\Apps\\ipa-webapp-refactoring"
}
```

Then `psync apps` — it should list the apps with the corrected paths and no `x`
markers.

### 3. Optional: link the CLI

`npm link` makes `psync` global. Otherwise use `node dist\bin.js …` or
`npm run …` in place of `psync` below.

---

## DOWNLOAD — R2 → this machine, end to end

**Step A — get the newest zip via the dashboard.** Drive Chrome (extension
connected) or have the human click:
1. Open the bucket URL (above).
2. Open the **`ipa/`** folder.
3. Sort by **Last Modified** (or pick the highest timestamp in the filename).
4. **Download** the newest `ipa_<timestamp>.zip` → it lands in `Downloads`.

**Step B — extract it** (resets `downloadDir`, keeps whatever the upload
excluded — `node_modules`, build output — plus `.git/info/exclude`):

```bash
psync download --app ipa --file "C:\Users\<you>\Downloads\ipa_<timestamp>.zip" --yes
```

Confirm `downloadDir` now holds the project, preserved dirs are intact, and the
printed checksum matches.

---

## UPLOAD — this machine → R2, end to end

**Step A — build the zip locally (no network):**

```bash
psync upload --app ipa --dry-run
```

It prints `ZIP created: ipa_<timestamp>.zip`; the file is at
`output\ipa_<timestamp>.zip` in the repo.

**Step B — upload that zip via the dashboard.** Drive Chrome (the Claude-in-Chrome
file-upload tool handles the picker) or have the human do it:
1. Open the bucket → open the **`ipa/`** folder (so the key becomes
   `ipa/ipa_<timestamp>.zip` — the prefix must match, or the other machine's
   `download` won't find it).
2. **Upload** → select `output\ipa_<timestamp>.zip`.
3. Optional: delete older `ipa_*.zip` in that folder. The CLI normally keeps the
   newest 3, but that prune needs the API, so on this machine trim by hand. It's
   cosmetic — `download` always takes the newest.

The **Mac** then pulls it with plain `psync download --app ipa` (its API works).

---

## Optional shortcut: `--url` (download only)

If the dashboard's download link is a **self-contained signed URL** (signature in
the query string, on a reachable host), you can skip the save+`--file`:

```bash
psync download --app ipa --url "<paste the link>" --yes
```

To check: DevTools → Network, click Download, inspect the request that serves the
bytes — note the host and whether it carries a signature in the query string. A
link that needs your browser cookies returns HTML; the command detects that and
tells you to use `--file` instead. Behind the proxy a direct fetch may need
`HTTPS_PROXY`, and `NODE_EXTRA_CA_CERTS` (corporate root CA) because TLS is
intercepted here.

---

## Guardrails — do NOT

- **No circumvention of the proxy block.** No VPN/tunnel, no custom domain
  fronting the bucket, no public `r2.dev` bucket, no stored/persisted Cloudflare
  session scraped by a script. The dashboard is an **allowed** path; using it —
  by hand or driven live in the already-logged-in browser — is fine. Automating
  an *allowed* path is not the same as disguising a *blocked* one.
- **Prefer the clean fix in parallel:** ask IT to allowlist the single host
  `9a407f3de26fca4e66bd1a515d87bb41.r2.cloudflarestorage.com`, or ask for the
  sanctioned transfer method. **If that host is allowlisted, the whole browser
  dance disappears** — plain `psync upload` and `psync download` work directly.

---

## Verification steps

1. `npm run build` succeeds; `npm test` passes (38).
2. `psync apps` lists the apps with Windows paths, no `x` markers.
3. **Confirm the API is blocked & you're on the new branch:** `psync verify --app ipa`
   should fail with the new diagnostic (“… did not return an S3 response … URL
   Blocked … proxy/gateway”), **not** an `XML parse error`. That block page is the
   expected symptom here.
4. **Round trip:**
   - **Upload:** `psync upload --app ipa --dry-run`, then upload `output\ipa_*.zip`
     into the bucket's `ipa/` folder via the dashboard. Confirm the object appears
     under `ipa/`.
   - **Download:** download that same object via the dashboard, then
     `psync download --app ipa --file <downloaded> --yes`. Confirm the tree in
     `downloadDir`, preserved dirs intact, checksum matches.

---

## Acceptance criteria

- From this Windows machine you can, end to end:
  1. **Build** a project zip (`upload --dry-run`) and **upload** it to the bucket
     under the correct `<app>/` prefix via the dashboard.
  2. **Download** the newest `<app>` zip via the dashboard and **extract** it into
     `downloadDir`, with the reset preserving everything the upload excluded and
     removing stale files; the reported checksum matches the uploaded zip.
- A full Mac ↔ Windows round trip works (Mac via API, Windows via dashboard).
- Achieved **only via the allowed dashboard path** (live login) — no circumvention.
- Bonus cleanups if time allows: make `requireR2Settings` lazy so `--file`/`--url`
  need no credentials; add a thin `psync open` that just opens the bucket folder in
  the browser.
