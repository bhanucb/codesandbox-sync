#!/usr/bin/env node
import fs from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  addApp,
  listApps,
  loadConfig,
  removeApp,
  resolveApp,
  updateApp,
  type ResolvedApp,
} from "./config.js";
import { configPath, loadEnv } from "./paths.js";
import { downloadApp, listRemoteZips, mtimeToDate, uploadApp } from "./sync.js";
import type { Logger } from "./zip.js";

// stdout carries JSON-RPC frames; anything that slips through console.log
// (ours or the CodeSandbox SDK's) must go to stderr instead.
console.log = console.error;

loadEnv();

const MAX_LOG_LINES = 120;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function collectLogs(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (message: string) => {
      for (const line of String(message).split("\n")) {
        lines.push(line);
      }
      console.error(message);
    },
  };
}

function renderLogs(lines: string[]): string {
  if (lines.length === 0) {
    return "";
  }
  const shown =
    lines.length > MAX_LOG_LINES
      ? [
          `… ${lines.length - MAX_LOG_LINES} earlier log line(s) omitted`,
          ...lines.slice(-MAX_LOG_LINES),
        ]
      : lines;
  return `\n\n<log>\n${shown.join("\n")}\n</log>`;
}

function ok(summary: string, data?: unknown, logLines: string[] = []): ToolResult {
  const payload = data === undefined ? "" : `\n\n${JSON.stringify(data, null, 2)}`;
  return {
    content: [{ type: "text", text: `${summary}${payload}${renderLogs(logLines)}` }],
  };
}

function fail(error: unknown, logLines: string[] = []): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `❌ ${message}${renderLogs(logLines)}` }],
    isError: true,
  };
}

function describe(app: ResolvedApp): Record<string, unknown> {
  return {
    name: app.name,
    sourceDir: app.sourceDir,
    backend: app.backend,
    remoteDir: app.remoteDir,
    downloadDir: app.downloadDir ?? null,
    devboxId: app.devboxId ?? null,
    exclude: app.exclude,
    sourceExists: fs.existsSync(app.sourceDir),
  };
}

const server = new McpServer({
  name: "codesandbox-sync",
  version: "1.0.0",
});

const appSelector = {
  app_name: z
    .string()
    .optional()
    .describe("Configured app name. Omit to auto-detect from `path`/cwd."),
  path: z
    .string()
    .optional()
    .describe(
      "Absolute path inside the app's source directory; used to auto-detect the app when app_name is omitted."
    ),
};

server.registerTool(
  "list_apps",
  {
    title: "List configured apps",
    description:
      "List every app configured for syncing, with its storage backend, local source directory, remote directory or key prefix, and download target.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const apps = listApps();
      if (apps.length === 0) {
        return ok(`No apps configured in ${configPath()}. Add one with add_app.`);
      }
      const broken = apps.filter((app) => app.error);
      const summary =
        broken.length === 0
          ? `${apps.length} app(s) configured in ${configPath()}:`
          : `${apps.length} app(s) configured in ${configPath()}; ${broken.length} cannot be used:`;
      return ok(summary, apps);
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "get_app",
  {
    title: "Get app config",
    description:
      "Show the full resolved configuration for one app, including its backend, effective ZIP exclude patterns and devbox id.",
    inputSchema: appSelector,
    annotations: { readOnlyHint: true },
  },
  async ({ app_name, path: pathHint }) => {
    try {
      const app = resolveApp({ appName: app_name, path: pathHint });
      return ok(`App "${app.name}":`, describe(app));
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "add_app",
  {
    title: "Add app",
    description:
      "Register a new app for syncing. On the codesandbox backend, remote_dir is required unless defaults.remoteRoot is set in apps.json, and a devbox id must come from devbox_id, defaults.devboxId or DEVBOX_ID. On the r2 backend, remote_dir is the object key prefix and defaults to the app name.",
    inputSchema: {
      name: z.string().describe("App name (letters, numbers, hyphens, underscores)"),
      source_dir: z.string().describe("Absolute path to the local project directory"),
      remote_dir: z
        .string()
        .optional()
        .describe("Devbox directory for uploaded ZIPs, or the R2 key prefix"),
      backend: z
        .enum(["codesandbox", "r2"])
        .optional()
        .describe("Storage backend for this app (default: defaults.backend, else codesandbox)"),
      download_dir: z
        .string()
        .optional()
        .describe("Local directory that download_app resets and extracts into"),
      devbox_id: z.string().optional().describe("Per-app devbox id override (codesandbox backend only)"),
      exclude: z
        .array(z.string())
        .optional()
        .describe("Extra paths to exclude from the ZIP (node_modules and .next always are)"),
    },
  },
  async (args) => {
    try {
      const app = addApp(args.name, {
        sourceDir: args.source_dir,
        remoteDir: args.remote_dir,
        downloadDir: args.download_dir,
        devboxId: args.devbox_id,
        backend: args.backend,
        exclude: args.exclude,
      });
      return ok(`✅ Added app "${app.name}" to ${configPath()}:`, describe(app));
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "update_app",
  {
    title: "Update app",
    description:
      "Modify an existing app's configuration. Only the fields you pass change; pass null to clear an optional field.",
    inputSchema: {
      app_name: z.string().describe("Name of the configured app to update"),
      source_dir: z.string().optional(),
      remote_dir: z.string().optional(),
      download_dir: z.string().nullable().optional(),
      devbox_id: z.string().nullable().optional(),
      backend: z.enum(["codesandbox", "r2"]).nullable().optional(),
      exclude: z.array(z.string()).nullable().optional(),
    },
  },
  async (args) => {
    try {
      const app = updateApp(args.app_name, {
        sourceDir: args.source_dir,
        remoteDir: args.remote_dir,
        downloadDir: args.download_dir,
        devboxId: args.devbox_id,
        backend: args.backend,
        exclude: args.exclude,
      });
      return ok(`✅ Updated app "${app.name}":`, describe(app));
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "remove_app",
  {
    title: "Remove app",
    description:
      "Remove an app from the sync config. Only the config entry is deleted — no local or remote files are touched.",
    inputSchema: { app_name: z.string() },
  },
  async ({ app_name }) => {
    try {
      removeApp(app_name);
      const remaining = Object.keys(loadConfig().apps).sort();
      return ok(
        `✅ Removed "${app_name}" from ${configPath()}. Remaining: ${
          remaining.join(", ") || "(none)"
        }`
      );
    } catch (error) {
      return fail(error);
    }
  }
);

server.registerTool(
  "upload_app",
  {
    title: "Upload app to remote",
    description:
      "ZIP an app's source directory (excluding node_modules, .next and configured excludes) and upload it to its configured backend (a CodeSandbox devbox or a Cloudflare R2 bucket), verifying the transfer and pruning old remote ZIPs. Use this when work on a project is finished and should be pushed to the remote.",
    inputSchema: {
      ...appSelector,
      dry_run: z
        .boolean()
        .optional()
        .describe("Create the ZIP and report its size without connecting to the remote"),
    },
  },
  async ({ app_name, path: pathHint, dry_run }) => {
    const { log, lines } = collectLogs();
    let app: ResolvedApp;
    try {
      app = resolveApp({ appName: app_name, path: pathHint });
    } catch (error) {
      return fail(error);
    }
    try {
      const result = await uploadApp(app, { log, dryRun: dry_run });
      const summary = result.dryRun
        ? `✅ Dry run for "${result.app}": ${result.zipFileName} (${result.sizeMb} MB), not uploaded.`
        : `✅ Uploaded "${result.app}" to ${result.remotePath} (${result.sizeMb} MB).`;
      return ok(summary, result, lines);
    } catch (error) {
      return fail(error, lines);
    }
  }
);

server.registerTool(
  "download_app",
  {
    title: "Download app from remote",
    description:
      "Download the newest ZIP from an app's configured backend and extract it into the app's download_dir. DESTRUCTIVE: download_dir is wiped first. Anything the upload excludes is preserved (node_modules, build output, assistant/editor state), plus .git/info/exclude. Requires confirm: true.",
    inputSchema: {
      ...appSelector,
      confirm: z
        .boolean()
        .describe("Must be true — acknowledges that download_dir will be reset"),
    },
  },
  async ({ app_name, path: pathHint, confirm }) => {
    const { log, lines } = collectLogs();
    let app: ResolvedApp;
    try {
      app = resolveApp({ appName: app_name, path: pathHint });
    } catch (error) {
      return fail(error);
    }
    if (!confirm) {
      return fail(
        `Refusing to download: this resets ${
          app.downloadDir ?? "the app's download_dir"
        } (everything the upload excludes is preserved). Re-run with confirm: true to proceed.`
      );
    }
    try {
      const result = await downloadApp(app, { log });
      return ok(
        `✅ Downloaded "${result.app}" (${result.zipFileName}, ${result.sizeMb} MB) into ${result.extractedTo}.`,
        result,
        lines
      );
    } catch (error) {
      return fail(error, lines);
    }
  }
);

server.registerTool(
  "list_remote_zips",
  {
    title: "List remote ZIPs",
    description:
      "List the ZIP files currently present in an app's configured backend, newest first.",
    inputSchema: appSelector,
    annotations: { readOnlyHint: true },
  },
  async ({ app_name, path: pathHint }) => {
    const { log, lines } = collectLogs();
    let app: ResolvedApp;
    try {
      app = resolveApp({ appName: app_name, path: pathHint });
    } catch (error) {
      return fail(error);
    }
    try {
      const zips = await listRemoteZips(app, { log });
      return ok(
        `${zips.length} ZIP(s) for "${app.name}" (${app.backend}):`,
        zips.map((z) => ({
          name: z.name,
          sizeMb: (z.size / (1024 * 1024)).toFixed(2),
          modified: mtimeToDate(z.mtime).toISOString(),
        })),
        lines
      );
    } catch (error) {
      return fail(error, lines);
    }
  }
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error(`codesandbox-sync MCP server ready (config: ${configPath()})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
