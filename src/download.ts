import { resolveCliApp } from "./cli.js";
import { downloadApp } from "./sync.js";

async function main(): Promise<void> {
  const app = resolveCliApp();
  console.log(`App: ${app.name}`);
  console.log(`  Prefix: ${app.remotePrefix}`);
  console.log(`  Target: ${app.downloadDir ?? "(not configured)"}`);
  await downloadApp(app, { log: (m) => console.log(m) });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
