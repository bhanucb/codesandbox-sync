# Setup

Instructions for an agent setting this up. Do the steps in order; stop at the
first failure and report it.

## Before you start

Ask the user for these — do not invent or guess them, and do not reuse values
from example files:

- **CodeSandbox API token** — they create it at <https://codesandbox.io/t/api>
- **Devbox id** — the last part of `https://codesandbox.io/p/devbox/<id>`; the
  devbox must already exist, this tool does not create one
- **Which directories to sync**, and for each, where downloads should land

Check `node --version` is 20+. If not, stop and tell the user.

## 1. Build

```bash
npm install
npm run build
npm test
```

All tests must pass.

## 2. Credentials

```bash
cp .env.example .env.local
```

Set `CSB_API_KEY`. Optionally set `DEVBOX_ID` as the default devbox.

Never print, commit, or transmit the token. `.env.local` is gitignored; the file
is optional if the user prefers real environment variables.

## 3. Register projects

```bash
cp apps.example.json apps.json
```

Replace the examples with the user's projects:

```json
{
  "defaults": { "devboxId": "<their devbox id>" },
  "apps": {
    "<name>": {
      "sourceDir": "<absolute local path>",
      "remoteDir": "/project/sandbox/apps/<name>",
      "downloadDir": "<absolute local path>"
    }
  }
}
```

A devbox id is mandatory — per app, or `defaults.devboxId`, or `DEVBOX_ID`.

Verify:

```bash
node dist/bin.js apps
```

`!` means the source directory is missing. `x` means the entry is unusable
(normally no devbox id).

## 4. Install the CLI

```bash
npm link
cd /tmp && csb-sync --help
```

If `npm link` fails on permissions, report it. Do not use `sudo`.

## 5. Check it reaches the devbox

```bash
csb-sync upload --app <name> --dry-run   # zips only, no network
csb-sync verify --app <name>             # lists remote ZIPs, changes nothing
```

An auth error means the token is wrong. Do **not** run a real upload or
download as part of setup — uploads write to a shared devbox, downloads reset a
local directory.

## 6. Register the MCP server

Ask which MCP client the user has. Most take JSON; use an **absolute** path:

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

Claude Code has a command instead:

```bash
claude mcp add codesandbox-sync -- node /absolute/path/to/dist/mcp.js
```

The server reads `.env.local` and `apps.json` from its own directory. If
credentials live in the environment, put them in the client's `env` block.

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
      "mcp__codesandbox-sync__list_apps",
      "mcp__codesandbox-sync__get_app",
      "mcp__codesandbox-sync__list_remote_zips",
      "mcp__codesandbox-sync__upload_app"
    ]
  }
}
```

Leave `download_app` and `remove_app` off: one resets a local directory, the
other edits the registry.

## Report back

- the registered apps and their source → remote mappings
- that `csb-sync upload` works from inside any registered directory
- that `download` resets its target first, keeping anything the upload excluded
- anything you could not finish, and why

## Errors

| Message | Cause |
| --- | --- |
| `No devbox id for "<app>"` | No `devboxId`, `defaults.devboxId`, or `DEVBOX_ID` |
| `Missing CodeSandbox token` | `CSB_API_KEY` not set |
| `No remote directory for "<app>"` | Pass `remoteDir`, or set `defaults.remoteRoot` |
| `No configured app matches path …` | Run from inside a registered `sourceDir`, or pass `--app` |
| `Unknown app "x"` | Not registered — `csb-sync apps` lists valid names |
| Client shows no tools | Path not absolute, or client not restarted |
| A file did not upload | It matched an exclude rule — see README.md |
