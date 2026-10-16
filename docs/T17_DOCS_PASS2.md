# Task 17 documentation — pass 2

中文摘要：同步 Tasks 14–16 的文件、雙語 README 與網站文案，清楚區分已實作的本機工具與尚未完成的公開 Alpha 部署。

This pass updates copy for the delivered [internal trader](M3_INTERNAL_TRADER.md),
[client SDK](M5_CLIENT_SDK.md), [example agent](../examples/agent/README.md),
[health and execution metrics](M5_HEALTH_METRICS.md), and
[local Alpha harness](M5_LOCAL_ALPHA.md). It updates architecture/design status,
the migration inventory through 0019, older delivery cross-references, the
[acceptance matrix](ACCEPTANCE_MATRIX.md), both READMEs, public role/agent docs,
marketing copy and llms.txt. It does not complete every milestone or public Alpha.

The trader supports one trader per deployment and requires an edge strictly above
the mandate threshold (default 500 bps); the worker enforces mandate caps. The
private SDK supplies typed responses, validation and verification; the example
requires loopback RPC. The local Alpha command exercises three REPLAY settlement
paths and projection recovery. Readiness is deployment availability, not a promise
that an individual market or taker can trade. The linked delivery records and their
cited implementations are the evidence for these statements.

The public site remains read-only with fictional REPLAY samples. No API host or
Base Sepolia deployment is available. Paid models, LIVE approval, alert delivery,
external acceptance, a demo video, operational web UI and hosted restore drills
remain outside this delivery. No layout, style, component behavior, backend code,
controller roadmap or parallel-owned local Alpha record changes are included.

Verification on 2026-10-16:

- `pnpm check`: passed; 594 tests, no failures/skips, both typechecks, contract compilation and package boundaries. Loopback tests required local sandbox permissions.
- `pnpm build`: passed with temporary offline font fixtures; the ordinary build could not reach Google Fonts.
- `pnpm build:pages && node scripts/check-pages-export.mjs`: passed with those fixtures; 20 key files, 63 internal URLs, 202 exported files. The export check also passed over local HTTP.
- `pnpm test:browsers` against the local fixture export: passed, 186 tests with 12 intentional device-specific skips; no browser or system installs.
- Final docs-content guards: 7 tests passed. Markdown links, 27 acceptance cases and referenced test files, migrations 0001–0019, bilingual delivery-link parity, text-only source structure and diff hygiene passed.

Offline fixtures use installed font bytes and do not verify production font downloads or appearance. The controller must rerun the ordinary build with Google Fonts access. Backend/Anvil/PostgreSQL/Alpha execution results linked above are prior delivery evidence, not newly rerun in this copy-only pass. The detailed per-file claim report stays untracked at `.superpowers/sdd/2026-10-14-remaining-milestones/task-17-pass2-report.md`. Source-control checkpoint: local commit only, no push or merge, per dispatch.
