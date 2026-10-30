# Introduction video workspace

This independent Remotion workspace renders the introduction from the local drill record. The website and services do not depend on it. The Remotion Free License applies to an individual or a for-profit organisation with up to 3 employees (user decision 2026-10-29): https://github.com/remotion-dev/remotion/blob/main/LICENSE.md (checked 2026-10-29).

To capture a completed local drill, run `pnpm video:capture` from the repository root. It reads `tmp/alpha-autonomous/` and writes `video/data/drill-run.json`; capture before changing the commit from the one on which the drill ran.

Run `pnpm video:studio`, `pnpm video:still`, or `pnpm video:render` from the root. The still and video are written to `tmp/video/`. The render uses H.264 and CRF 30; the final MP4 size and legibility must be checked after rendering (target at most 25 MB).

Remotion 4.0.536's renderer only sends a usage event when a license key is set (`@remotion/renderer/dist/render-media.js`); this workspace leaves it unset. The Studio source (`@remotion/studio/dist/components/UpdateStatusContext.js`) checks for updates and known bugs when connected. No disable setting was found in the 4.0.536 config API; do not use Studio offline expecting those requests to be disabled.

The development host lacks the browser libraries and glibc required to render. On a Docker host, use a pinned Node 22 image with Debian bookworm (glibc 2.36), mounting the repository:

```sh
docker run --rm -v "$PWD:/work" -w /work node:22.23.1-bookworm bash -lc 'apt-get update && apt-get install -y libgbm1 libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libasound2 libxkbcommon0 libgtk-3-0 && corepack enable && pnpm install --frozen-lockfile && pnpm video:still'
```
