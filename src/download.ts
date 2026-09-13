import { resolveCliApp } from "./cli.js";
import { downloadApp, downloadFromUrl, importZipFile } from "./sync.js";

function flag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("-")) {
    return argv[i + 1];
  }
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
  const file = flag("file");
  const url = flag("url");
  const app = resolveCliApp();
  console.log(`App: ${app.name}`);
  console.log(`  Target: ${app.downloadDir ?? "(not configured)"}`);
  const log = (m: string) => console.log(m);
  if (file) {
    await importZipFile(app, file, { log });
  } else if (url) {
    await downloadFromUrl(app, url, { log });
  } else {
    console.log(`  Prefix: ${app.remotePrefix}`);
    await downloadApp(app, { log });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
