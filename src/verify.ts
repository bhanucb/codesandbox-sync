import { resolveCliApp } from "./cli.js";
import { listRemoteZips } from "./sync.js";

async function main(): Promise<void> {
  const app = resolveCliApp();
  console.log(`App: ${app.name}`);
  await listRemoteZips(app, { log: (m) => console.log(m) });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
