import { resolveCliApp } from "./cli.js";
import { uploadApp } from "./sync.js";

async function main(): Promise<void> {
  const app = resolveCliApp();
  console.log(`App: ${app.name} (${app.backend})`);
  console.log(`  Source: ${app.sourceDir}`);
  console.log(`  Remote: ${app.remoteDir}`);
  const dryRun = process.argv.slice(2).includes("--dry-run");
  await uploadApp(app, { log: (m) => console.log(m), dryRun });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
