# codesandbox-sync

Zips a local project, uploads it to a [CodeSandbox](https://codesandbox.io)
devbox, and downloads it back. Works as a CLI (`csb-sync`) and as an MCP server.

Agent setting this up? Follow [SETUP.md](SETUP.md).

## Install

Requires Node 20+.

```bash
git clone https://github.com/bhanucb/codesandbox-sync.git && cd codesandbox-sync
npm install && npm run build && npm link
```

## Configure

**Credentials** — environment variables, or an optional `.env.local`
(`cp .env.example .env.local`). Real env vars win.

```env
CSB_API_KEY=csb_v1_...   # required — get one at https://codesandbox.io/t/api
DEVBOX_ID=abc123         # fallback devbox for apps that don't set their own
```

**Projects** — `apps.json` (`cp apps.example.json apps.json`):

```json
{
  "defaults": { "devboxId": "abc123" },
  "apps": {
    "my-app": {
      "sourceDir": "/absolute/path/to/my-app",
      "remoteDir": "/project/sandbox/apps/my-app",
      "downloadDir": "/absolute/path/to/my-app"
    }
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `sourceDir` | yes | Directory to zip and upload |
| `remoteDir` | yes | Devbox directory the ZIPs land in |
| `devboxId` | yes* | Which devbox to use |
| `downloadDir` | for `download` | Directory that `download` **resets** and extracts into |
| `exclude` | no | Extra paths kept out of the ZIP |

\* A devbox id is mandatory and never defaulted. It comes from the app's
`devboxId`, `defaults.devboxId`, `DEVBOX_ID`, or `--devbox`. The id is the last
part of the devbox URL: `https://codesandbox.io/p/devbox/<devbox-id>`.

`defaults` also accepts `remoteRoot`, `exclude`, and `preserveNodeModules`.
`CSB_SYNC_CONFIG` points at a different registry file.

## CLI

```bash
cd ~/code/my-app && csb-sync upload   # app inferred from the directory
csb-sync upload --app my-app --dry-run
csb-sync download --app my-app        # prompts first
csb-sync verify --app my-app
csb-sync apps
```

Target order: `--source`, `--app`, current directory, then `APP_NAME`.
Overrides for one run: `--remote`, `--to`, `--devbox`.

Ad-hoc, nothing registered:

```bash
csb-sync upload --source . --remote /project/sandbox/apps/scratch --devbox abc123
```

From inside this repo, without `npm link`: `npm run upload -- --app my-app`
(also `download`, `verify`). These check `APP_NAME` before the current
directory.

## MCP server

Any stdio MCP client. The path must be absolute.

```json
{
  "mcpServers": {
    "codesandbox-sync": {
      "command": "node",
      "args": ["/absolute/path/to/codesandbox-sync/dist/mcp.js"]
    }
  }
}
```

| Tool | Arguments |
| --- | --- |
| `list_apps` | — |
| `get_app` | `app_name?`, `path?` |
| `add_app` | `name`, `source_dir`, `remote_dir?`, `download_dir?`, `devbox_id?`, `exclude?` |
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

**Uploads keep 3 ZIPs on the devbox and 2 locally**, and are verified by size
with retries.

## Development

```bash
npm run build
npm test
```

`src/sync.ts` holds upload/download/list; `bin.ts` (CLI) and `mcp.ts` (MCP
server) are thin wrappers over it. The CLI imports nothing from the MCP SDK.

## License

MIT
