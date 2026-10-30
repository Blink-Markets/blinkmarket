# Introduction video workspace

This independent Remotion workspace renders the introduction from the local drill record. The website and services do not depend on it. The Remotion Free License applies to an individual or a for-profit organisation with up to 3 employees (user decision 2026-10-29): https://github.com/remotion-dev/remotion/blob/main/LICENSE.md (checked 2026-10-29).

To capture a completed local drill, run `pnpm video:capture` from the repository root. It reads `tmp/alpha-autonomous/` and writes `video/data/drill-run.json`; capture before changing the commit from the one on which the drill ran.

Run `pnpm video:studio`, `pnpm video:still`, or `pnpm video:render` from the root. The still and video are written to `tmp/video/`.

Remotion 4.0.536's renderer sends a usage event only when a license key is set (`@remotion/renderer/dist/render-media.js`); this workspace sets none. `pnpm video:still` and `pnpm video:render` make no update check. The interactive `pnpm video:studio` asks registry.npmjs.org for the latest Remotion version (`@remotion/studio-server/dist/get-latest-remotion-version.js`) and fetches known bugs; 4.0.536 has no setting to turn this off, so do not run the Studio where that request is unwanted.

The render settings are H.264 at CRF 30. The 150-second video rendered on 2026-10-30 is about 1.5 MB, well under the 25 MB limit.

The development host (glibc 2.28) cannot run Remotion's browser, which needs glibc 2.31 and libgbm. Render in a pinned Debian bookworm (glibc 2.36) container. Copy the repository into the container rather than installing into the mounted tree, so the host's `node_modules` stays untouched, and copy the output back:

```sh
mkdir -p tmp/video
docker run --rm -v "$PWD:/src:ro" -v "$PWD/tmp/video:/out" node:22.23.1-bookworm-slim bash -c '
  apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates libgbm1 libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libasound2 libxkbcommon0 libgtk-3-0 libdrm2 libxfixes3 libpango-1.0-0 libcairo2 libcups2 &&
  mkdir /work && cd /src && tar --exclude=./node_modules --exclude="./*/node_modules" --exclude=./tmp --exclude=./.git -cf - . | tar -xf - -C /work &&
  cd /work && corepack enable && pnpm install --frozen-lockfile &&
  cd video && pnpm exec remotion still src/index.ts BlinkIntro /out/blink-intro-poster.png &&
  pnpm exec remotion render src/index.ts BlinkIntro /out/blink-intro.mp4'
```
