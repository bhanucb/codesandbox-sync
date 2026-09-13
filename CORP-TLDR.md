# Corp PC — TL;DR (S3 endpoint blocked, dashboard allowed)

1. Once: `start chrome --remote-debugging-port=9222 --user-data-dir=%LOCALAPPDATA%\psync-chrome https://dash.cloudflare.com`, sign in, keep that window open. `apps.json` needs only `defaults.r2.bucket` + `accountId` and the app's `sourceDir`/`downloadDir` — no keys.
2. Then just `psync download --app ipa --yes` and `psync upload --app ipa` — with no keys they go through that browser automatically (`--browser` forces it; `psync open` jumps to the folder if you ever need to do it by hand).
