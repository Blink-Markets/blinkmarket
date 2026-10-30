# Introduction video workspace

This directory holds the independent introduction video workspace and its captured drill data. The website and services do not depend on it. Task 5 will add the Remotion package and rendering setup.

The Remotion Free License applies to an individual or a for-profit organisation with up to 3 employees: https://github.com/remotion-dev/remotion/blob/main/LICENSE.md (checked 2026-10-29).

To capture a completed local drill, run `pnpm video:capture` from the repository root. It reads `tmp/alpha-autonomous/` and writes `video/data/drill-run.json`; capture before changing the commit from the one on which the drill ran.

Rendering is not available yet; Task 5 will supply the render command and workspace.
