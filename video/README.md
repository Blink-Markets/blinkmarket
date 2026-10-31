# Introduction video workspace

This independent Remotion workspace renders the product introduction: a one-minute animation of minimalist role characters on a beat grid, with music and sound effects. The website and services do not depend on it. The Remotion Free License applies to an individual or a for-profit organisation with up to 3 employees (user decision 2026-10-29): https://github.com/remotion-dev/remotion/blob/main/LICENSE.md (checked 2026-10-29).

Every on-screen string lives in `src/script.ts`; scenes take their text from it. The shot timing is on a 120 BPM grid (`src/time.ts`).

Run `pnpm video:studio` from the root to preview. Render with `scripts/video-docker.sh`, which runs a command in `video/` inside a container and writes to `tmp/video/` (mounted at `/out`):

```sh
scripts/video-docker.sh 'pnpm exec remotion still src/index.ts BlinkIntro /out/frame.png --frame=60'
scripts/video-docker.sh 'pnpm exec remotion render src/index.ts BlinkIntro /out/blink-intro.mp4'
```

The development host (glibc 2.28) cannot run Remotion's browser, which needs glibc 2.31 and libgbm, so the script uses a pinned Debian bookworm (glibc 2.36) container (`node:22.23.1-bookworm-slim`). It copies the repository in rather than installing into the mounted tree, so the host's `node_modules` stays untouched. A named volume, `blink-video-pnpm-store`, holds the pnpm store, so repeat runs reuse downloads. The first run also downloads Chrome Headless Shell.

Remotion 4.0.536's renderer sends a usage event only when a license key is set (`@remotion/renderer/dist/render-media.js`); this workspace sets none. Stills and renders make no update check. The interactive `pnpm video:studio` asks registry.npmjs.org for the latest Remotion version (`@remotion/studio-server/dist/get-latest-remotion-version.js`) and fetches known bugs; 4.0.536 has no setting to turn this off, so do not run the Studio where that request is unwanted.

The render settings are H.264 at CRF 30, with AAC audio. The target is 8 MB, with 15 MB as the hard cap.

## Music

To be filled when the track is chosen: source page, licence page, check date and, if the file is not committed, its SHA-256.
