# Corp PC — TL;DR (S3 endpoint blocked, dashboard allowed)

1. Once: `git clone … && npm install && npm run build`; put `defaults.r2.bucket` + `accountId` and the app's `sourceDir`/`downloadDir` in `apps.json` (no keys); start `chrome --remote-debugging-port=9222 --user-data-dir=%LOCALAPPDATA%\psync-chrome https://dash.cloudflare.com`, sign in, keep that window open.
2. Then: `npm run download -- --app ipa` and `npm run upload -- --app ipa` (the `--` is required) — with no keys they go through that browser automatically; add `--browser` to force it. (`npm link` makes these `psync download --app ipa --yes` / `psync upload --app ipa`.)
