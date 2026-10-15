# Task 17 — documentation pass 1

中文摘要：更新 Tasks 1–13 的 README、架構／設計與公開網站文案，區分已實作、尚未部署及後續工作；沒有改版面或後端行為。

This pass documents the backend available at `fb0d345` (Tasks 1–13). It does not mark Task 17, M2, M3 or M5 complete. The controller owns the roadmap; this pass does not change it.

## Delivered scope

- README status and delivery links cover RFQ, restricted signer, reorg-aware indexer, public reads, jobs/budgets, evidence fetch, forecasts, research workers, resolution, evaluation, keeper/faucet and deployment tooling.
- Architecture and design status notes reflect implemented process wiring and migrations 0001–0017, while identifying conceptual schema tables and historical work-package lists.
- Public role guides distinguish implemented backend operations from an undeployed system. Faucet calls require `faucet:claim` as well as a verified, allowlisted wallet. Unsigned quotes return 404; SIGN_UNKNOWN recovery retries the same RFQ POST. Market detail forecast/cost hooks remain unwired; metrics budget totals are platform-wide.
- Home, how-it-works, markets and generated `llms.txt` copy retain the read-only, undeployed status. Fictional samples are not connected to API data. The `llms.txt` route delegates its text to `apps/web/lib/docs/llms.ts`, where the copy was changed.
- The historical creation-poller pending verification note points to the later RFQ delivery's passing real-PostgreSQL suite, without claiming a new CI run.

## Evidence and boundaries

Sources: [RFQ](M2_RFQ.md), [Signer](M2_SIGNER.md), [Indexer](M2_CHAIN_INDEXER.md), [Public reads](M2_PUBLIC_READS.md), [Jobs/budgets](M3_JOBS_BUDGETS.md), [Evidence](M3_EVIDENCE_FETCHER.md), [Forecasts](M3_FORECASTS.md), [Research workers](M3_RESEARCH_WORKERS.md), [Resolution](M3_RESOLUTION.md), [Evaluation](M3_EVALUATION.md), [Keeper/faucet](M3_KEEPER_FAUCET.md), [Deployment tooling](M5_DEPLOYMENT_TOOLING.md).

Claims were checked against application services, API/worker/indexer/signer composition roots, migrations and static sample imports. The per-file claim/evidence inventory is in the untracked task report under `.superpowers/sdd/2026-10-14-remaining-milestones/task-17-pass1-report.md`.

Nothing is deployed to a public network. There is no public API host or trading on the site. Verification uses local REPLAY fixtures, no paid model provider, and LIVE approval remains rejected. Internal trader, expanded SDK/example agent and integrated local Alpha harness with health/metrics readiness remain for Tasks 14–16 and a later documentation pass. Public evaluation metrics already exist; runtime readiness is a separate deferred item. Wallet/trading/admin UI, S3 storage, real source/provider configuration, signer network isolation/encryption and alert delivery remain open.

## Verification

- `pnpm check`: passed with local-server permission; typechecks, contract checks, all 495 tests (no skips), package boundaries. The first sandbox run hit loopback `EPERM` and a public-docs content guard; the reporter wording was corrected and the full suite rerun successfully.
- `pnpm build`: passed with temporary local font fixtures, including prerendering. The ordinary build was blocked by existing Google Fonts downloads in the restricted environment.
- `pnpm build:pages && node scripts/check-pages-export.mjs`: passed with the same fixtures, including a final rebuild after the reporter wording correction. Checked 20 key files and 63 internal URLs from 202 exported files. The earlier export was also checked over local HTTP.
- `pnpm test:browsers` against the local static export: 186 passed, 12 intentional device-specific skips, across Chromium/Firefox/WebKit desktop/mobile. No browsers or system packages installed. This full browser run preceded only removal of the command name from the reporter paragraph; final export and all 7 docs-content tests passed afterward.
- 73 repository-relative Markdown links checked; `git diff --check` passed.

Temporary font fixtures live outside the repository. They substitute bundled Geist WOFF2 for site families and installed Arial TTF for share-card font fetches; these builds verify compilation, exports and browser behavior, not production font downloads or appearance. No source packages, generated API reference, client guide, RFQ delivery or roadmap were edited. No prose TDD applies. Service, Anvil and real-PostgreSQL suites were not required for this copy-only pass.
