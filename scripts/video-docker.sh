#!/usr/bin/env bash
# Runs a command in video/ inside a pinned Debian bookworm container (glibc 2.36), because the
# development host's glibc is too old for Remotion's browser. The repository is copied in so the
# host's node_modules stays untouched; tmp/video is mounted at /out for the results.
#   scripts/video-docker.sh 'pnpm exec remotion still src/index.ts BlinkIntro /out/poster.png --frame=60'
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: $0 <command to run in video/>" >&2; exit 2; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$root/tmp/video"
exec docker run --rm \
  -v "$root:/src:ro" \
  -v "$root/tmp/video:/out" \
  -v blink-video-pnpm-store:/pnpm-store \
  node:22.23.1-bookworm-slim bash -c '
set -euo pipefail
apt-get update -qq && apt-get install -y -qq --no-install-recommends ca-certificates libgbm1 libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libasound2 libxkbcommon0 libgtk-3-0 libdrm2 libxfixes3 libpango-1.0-0 libcairo2 libcups2
mkdir /work && cd /src && tar --exclude=./node_modules --exclude="./*/node_modules" --exclude=./tmp --exclude=./.git -cf - . | tar -xf - -C /work
cd /work && corepack enable
export npm_config_store_dir=/pnpm-store
pnpm install --frozen-lockfile
cd video && bash -c "$0"' "$*"
