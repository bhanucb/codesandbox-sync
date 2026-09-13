# Setup

Instructions for an agent setting this up. Do the steps in order; stop at the
first failure and report it.

## Before you start

Ask the user for these — do not invent or guess them, and do not reuse values
from example files:

- **An R2 bucket**, which must already exist; this tool does not create one
- **R2 API token credentials** — access key id and secret, from the Cloudflare
  dashboard under R2 → API → Manage API tokens, scoped to that bucket with
  Object Read & Write. Ask the user to create the token and paste the values
  themselves; do not go and fetch them.
- **Cloudflare account id** — the hex string in their dashboard URL
- **Which directories to sync**, and for each, where downloads should land

Check `node --version` is 20+. If not, stop and tell the user.

## 1. Build

```bash
npm install
npm run build
npm test
```

All tests must pass.

## 2. Configuration

There is one configuration file. Copy the template:

```bash
cp apps.example.json apps.json
```

Everything lives here — the R2 connection and the projects. Section 3 fills in
the projects; fill in `defaults.r2` now with the values the user gave you:

```json
{
  "defaults": {
    "r2": {
      "bucket": "<their bucket>",
      "accountId": "<their account id>",
      "accessKeyId": "<their R2 access key id>",
      "secretAccessKey": "<their R2 secret>"
    }
  }
}
```

`apps.json` and `apps.json.*` are gitignored and must stay that way: the file
holds live credentials, so anyone who can read it can read and write the
bucket. Never print, commit, or transmit it.

If the machine sits behind a corporate proxy, set `HTTPS_PROXY` in the real
environment, and `NODE_EXTRA_CA_CERTS` when that proxy intercepts TLS. Those
two stay environment variables because they are machine-wide, not per-project.

## 3. Register projects

```bash
cp apps.example.json apps.json
```

Replace the examples with the user's projects:

```json
{
  "defaults": {
    "r2": { "bucket": "<their bucket>", "accountId": "<their account id>" }
  },
  "apps": {
    "<name>": {
      "sourceDir": "<absolute local path>",
      "downloadDir": "<absolute local path>"
    }
  }
}
```

Objects are keyed by `remotePrefix`, which defaults to the app name — leave it
out unless the user wants a particular layout in the bucket.

Verify:

```bash
node dist/bin.js apps
```

`!` means the source directory is missing. `x` means the entry is unusable
(normally missing R2 credentials).

## 4. Install the CLI

```bash
npm link
cd /tmp && psync --help
```

If `npm link` fails on permissions, report it. Do not use `sudo`.

## 5. Check it reaches the remote

```bash
node dist/bin.js upload --app <name> --dry-run   # zips only, no network
node dist/bin.js verify --app <name>             # lists remote ZIPs, changes nothing
```

`verify` is the first call that touches the network, so it is where a blocked
endpoint, a missing proxy setting, or an intercepted certificate will surface.
`SignatureDoesNotMatch` usually means a truncated secret; `NoSuchBucket` means
the bucket name or account id is wrong. Do **not** run a real upload or download
as part of setup — uploads write to a shared bucket, downloads reset a local
directory.

## 6. Register the MCP server

Ask which MCP client the user has. Most take JSON; use an **absolute** path:

```json
{
  "mcpServers": {
    "project-sync": {
      "command": "node",
      "args": ["/absolute/path/to/project-sync/dist/mcp.js"]
    }
  }
}
```

Claude Code has a command instead:

```bash
claude mcp add project-sync -- node /absolute/path/to/dist/mcp.js
```

The server reads `apps.json` from its own directory.

Smoke-test — this must print tool names, and nothing else on stdout:

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"setup","version":"1"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
 | node dist/mcp.js 2>/dev/null
```

Restart the client afterwards.

## 7. Permissions (optional)

If the client gates tool calls, the **user** allows them — you cannot edit their
settings. For Claude Code, `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__project-sync__list_apps",
      "mcp__project-sync__get_app",
      "mcp__project-sync__list_remote_zips",
      "mcp__project-sync__upload_app"
    ]
  }
}
```

Leave `download_app` and `remove_app` off: one resets a local directory, the
other edits the registry.

## Report back

- the registered apps and their source → remote mappings
- that `psync upload` works from inside any registered directory
- that `download` resets its target first, keeping anything the upload excluded
- anything you could not finish, and why

## Errors

| Message | Cause |
| --- | --- |
| `cannot reach R2 — missing: …` | Named keys absent from `defaults.r2` in apps.json |
| `SignatureDoesNotMatch` | Secret truncated on paste |
| `NoSuchBucket` | Wrong `R2_BUCKET` or `R2_ACCOUNT_ID` |
| Request fails with a certificate error | Proxy intercepts TLS — set `NODE_EXTRA_CA_CERTS` |
| Request hangs or times out | Egress needs a proxy — set `HTTPS_PROXY` |
| `did not return an S3 response` | A proxy or gateway answered instead of R2; the message shows what came back |
| `No configured app matches path …` | Run from inside a registered `sourceDir`, or pass `--app` |
| `Unknown app "x"` | Not registered — `psync apps` lists valid names |
| Client shows no tools | Path not absolute, or client not restarted |
| A file did not upload | It matched an exclude rule — see README.md |
