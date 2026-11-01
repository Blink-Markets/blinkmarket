# Introduction video workspace

This independent Remotion workspace renders the product introduction: a one-minute animation of minimalist role characters on a beat grid, with music and sound effects. The website and services do not depend on it. The Remotion Free License applies to an individual or a for-profit organisation with up to 3 employees (user decision 2026-10-29): https://github.com/remotion-dev/remotion/blob/main/LICENSE.md (checked 2026-10-29).

Every on-screen string lives in `src/script.ts`; scenes take their text from it. The shot timing is on a 120 BPM grid (`src/time.ts`).

Run `pnpm video:studio` from the root to preview. Render with `scripts/video-docker.sh`, which runs a command in `video/` inside a container and writes to `tmp/video/` (mounted at `/out`):

```sh
scripts/video-docker.sh 'pnpm exec remotion still src/index.ts BlinkIntro /out/frame.png --frame=60'
scripts/video-docker.sh 'pnpm exec remotion render src/index.ts BlinkIntro /out/blink-intro.mp4'
```

The development host (glibc 2.28) cannot run Remotion's browser, which needs glibc 2.31 and libgbm, so the script uses a pinned Debian bookworm (glibc 2.36) container (`node:22.23.1-bookworm-slim`). It copies the repository in rather than installing into the mounted tree, so the host's `node_modules` stays untouched. A named volume, `blink-video-pnpm-store`, holds the pnpm store, so repeat runs reuse downloads. Renders need the network: they fetch the Geist font from fonts.gstatic.com, and Chrome Headless Shell downloads on every run because the container is removed after each run. The files in `tmp/video/` are written by the container, so they are root-owned in a user-owned directory; `rm` still works.

Remotion 4.0.536's renderer sends a usage event only when a license key is set (`@remotion/renderer/dist/render-media.js`); this workspace sets none. Stills and renders make no update check. The interactive `pnpm video:studio` asks registry.npmjs.org for the latest Remotion version (`@remotion/studio-server/dist/get-latest-remotion-version.js`) and fetches known bugs; 4.0.536 has no setting to turn this off, so do not run the Studio where that request is unwanted.

The render settings are H.264 at CRF 30, with AAC audio. The target is 8 MB, with 15 MB as the hard cap.

## Progress

The video has its score and sound effects.

## Music

- Track: "Low and High Percussion Loop Groove with Kalimba at 120bpm" by bassimat, https://freesound.org/people/bassimat/sounds/854314/
- Licence: CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/ (read on the sound's page, checked 2026-11-01). Attribution is not required; it is credited here anyway.
- File: `public/music/bassimat-854314-kalimba-groove.mp3`, committed under CC0. It is Freesound's HQ preview MP3 (64.0 s, 1.5 MB), because the original WAV needs a Freesound login and the preview is good enough for an AAC bed. SHA-256: `ccb5ad5848bbd3a9abb676d96614475c288c4cf1aacc919a7d8537ac26c4864c`.
- Timing: `bpm: 120`, `firstBeatSeconds: 0.53`, `speed: 1.1`. The music plays at 1.1x (`playbackRate`, ffmpeg `atempo`, pitch kept), so the cut runs at 132 BPM (`CUT_BPM` in `src/time.ts`): 1595 frames, about 53.2 s. `startFrom` stays in source frames: the renderer trims after `atempo` at `startFrom / fps / playbackRate` (`@remotion/renderer` `seamless-aac-trim.js`), which is source time 0.53 s, so the track's first beat lands on frame 0. A librosa beat fit (start_bpm 120) gave 119.998 BPM, grid phase 0.529 s, residual sd 6.9 ms, so the timeline is not scaled. From 0.53 s the track has 63.5 s left, more than the video's 58.5 s.
- Level: `gain: 0.30`, under the volume envelope in `src/sound.ts`, with the effects at volume 1. The two were raised together by about 5 dB (from 0.17 and 0.56, the animatic's browser-preview attenuation) so the web mix is not too quiet, keeping their ratio.
