# project-sync

Zips a local project, uploads it to a [Cloudflare R2](https://developers.cloudflare.com/r2/)
bucket, and downloads it back. Works as a CLI (`psync`) and as an MCP server.

Useful for moving a working tree between two machines that have no shared
network — the bucket is plain object storage under your own Cloudflare account,
reachable over ordinary HTTPS.

Agent setting this up? Follow [SETUP.md](SETUP.md).

## Install

Requires Node 20+.

```bash
git clone <this-repo> && cd project-sync
npm install && npm run build && npm link
```

## Configure

**Credentials** — environment variables, or an optional `.env.local`
(`cp .env.example .env.local`). Real env vars win.

```env
R2_ACCESS_KEY_ID=...     # R2 API token, scoped Object Read & Write
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=project-zips   # may live in apps.json instead
R2_ACCOUNT_ID=...        # may live in apps.json instead
```

Credentials are never read from `apps.json` — only the bucket and account id
are, so the registry stays safe to commit. Create the token in the Cloudflare
dashboard under R2 → API → Manage API tokens; scope it to the one bucket.

**Projects** — `apps.json` (`cp apps.example.json apps.json`):

```json
{
  "defaults": {
    "r2": { "bucket": "project-zips", "accountId": "your-account-id" }
  },
  "apps": {
    "my-app": {
      "sourceDir": "/absolute/path/to/my-app",
      "downloadDir": "/absolute/path/to/my-app"
    }
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `sourceDir` | yes | Directory to zip and upload |
| `downloadDir` | for `download` | Directory that `download` **resets** and extracts into |
| `remotePrefix` | no | Object key prefix (default: the app name) |
| `exclude` | no | Extra paths kept out of the ZIP |

Objects land at `<remotePrefix>/<app>_<timestamp>.zip`. A prefix is a key
namespace, not a filesystem path: it is normalized to a relative, slash-
separated form and cannot contain `..`.

`defaults` also accepts `r2`, `exclude`, and `preserveNodeModules`.
`SYNC_CONFIG` points at a different registry file.

## CLI

```bash
cd ~/code/my-app && psync upload   # app inferred from the directory
psync upload --app my-app --dry-run
psync download --app my-app        # prompts first
psync verify --app my-app
psync apps
```

Target order: `--source`, `--app`, current directory, then `APP_NAME`.
Overrides for one run: `--prefix`, `--to`.

Ad-hoc, nothing registered:

```bash
psync upload --source . --prefix scratch
```

From inside this repo, without `npm link`: `npm run upload -- --app my-app`
(also `download`, `verify`). These check `APP_NAME` before the current
directory.

## MCP server

Any stdio MCP client. The path must be absolute.

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

| Tool | Arguments |
| --- | --- |
| `list_apps` | — |
| `get_app` | `app_name?`, `path?` |
| `add_app` | `name`, `source_dir`, `remote_prefix?`, `download_dir?`, `exclude?` |
| `update_app` | `app_name` + any field (`null` clears) |
| `remove_app` | `app_name` |
| `upload_app` | `app_name?`, `path?`, `dry_run?` |
| `download_app` | `app_name?`, `path?`, `confirm` (destructive) |
| `list_remote_zips` | `app_name?`, `path?` |

Omit `app_name` and the app is inferred from `path`, matching each app's
`sourceDir` (deepest wins). Logging goes to stderr; stdout is JSON-RPC only.

## Behavior worth knowing

**Uploads exclude** `node_modules`, `.next`, and assistant/editor state
(`.claude*`, `.cursor*`, `.aider*`, `.windsurf*`, `.cline*`, `.roo*`,
`.continue`, `.codeium*`, `.gemini*`, `.goose*`, `.opencode*`, `.augment*`,
`.tabnine*`, `.specstory`, `.crush*`, `.amazonq*`, `.kiro*`, `.junie*`,
`.qodo*`, `.cody*`, `.devin*`, `.sourcegraph`, `.openai*`, `.llm*`,
`.mcp.json`), plus your own `exclude` entries. Any path segment containing
"copilot" is kept. Patterns match a path segment and may end in `*`; patterns
with `/` match a path prefix.

**`download` resets `downloadDir`** before extracting. Anything the upload
excluded survives, plus `.git/info/exclude` — if it was never in the ZIP,
deleting it would destroy something no download can restore. Everything else is
replaced by the ZIP. `PRESERVE_NODE_MODULES=false` opts out for node_modules.

**Uploads keep 3 ZIPs per prefix and 2 locally.** A successful `PutObject`
means the object is readable, so the upload is verified with a single `HEAD`
on the size. Set a bucket lifecycle rule as well — pruning runs in this process,
so it cannot help if a run dies partway.

**Behind a corporate proxy**, set `HTTPS_PROXY` — the AWS SDK does not read it
the way `curl` and `fetch` do, so the client wires the agent in explicitly. If
the proxy intercepts TLS, also set `NODE_EXTRA_CA_CERTS` to the corporate root
CA, or every request fails certificate validation.

## Development

```bash
npm run build
npm test
```

`src/sync.ts` holds upload/download/list; `bin.ts` (CLI) and `mcp.ts` (MCP
server) are thin wrappers over it. The CLI imports nothing from the MCP SDK.

`src/storage/` is the transport seam: `types.ts` declares the five operations
syncing needs (list, put, get, remove, close) and `r2.ts` implements them.
`sync.ts` knows nothing about S3 — a different store means one new file there
and a line in `createStorage`.

## License

MIT
