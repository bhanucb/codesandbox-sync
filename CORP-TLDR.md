# Corp PC — TL;DR (S3 endpoint blocked, dashboard allowed)

1. Once: `git clone … && npm install && npm run build`; put `defaults.r2.bucket` + `accountId` and the app's `sourceDir`/`downloadDir` in `apps.json` (no keys). Google Chrome must be installed.
2. Then: `npm run download -- --app ipa` and `npm run upload -- --app ipa` (the `--` is required). With no keys they go through the dashboard by themselves: psync starts Chrome off-screen from its own profile, does the clicks, closes it. The very first run opens a Chrome window — sign in to Cloudflare there once; after that it's silent. (`npm link` makes these `psync download --app ipa --yes` / `psync upload --app ipa`.)
