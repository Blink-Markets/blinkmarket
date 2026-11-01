# P5 red-team recon notes

Discussion record of 2026-11-01, kept with [the P5 design](2026-11-01-p5-red-team-design.md). P5 stopped before an implementation plan was written; these notes and the design describe the scope for a later external review.

User decisions so far: P5 = pre-testnet self-review by AI agents + open-source tools; mainnet external audit is separate. Done = every historical/common attack has a test, mechanism or math guarantee; anything unguaranteed has a proven loss bound. No human kill switch (agents-only market); responses are pre-written mechanisms: caps, condition-triggered auto circuit breaker (accepted), generation change, agent self-defence. Scope: 5 areas (contracts+economics; settlement+price source; off-chain API/indexer/DB incl. resource exhaustion; agent layer: prompt injection, malicious agents, SDK supply chain; docs site + deploy credentials). Per-unit capacity profiling folded in. Deliverables: attack matrix, attack-surface map, findings + regression tests, standing adversarial suite, economic security numbers, residual-risk register, launch gate, agent safety guide. Not: third-party infra, public load tests, mainnet audit.

## Cloudflare security-audit-skill (MIT)
- 6 phases; artifacts architecture.md, coverage-ledger.json, findings.json (report-schema.json: confirmed / needs_validation / rejected; confirmed needs root_cause, trace, evidence, execution, remediation, severity, confidence), REPORT.md etc. Validators validate-findings.cjs, validate-coverage-ledger.cjs (fs/path only).
- Default output ~/security-audit-skill/<repo>/run-N (outside target). Hunters = general subagents; no model selection. Requires OS sandbox to execute target code; no installs; no network.
- Classes: injection, access control, resources/files, crypto/secrets, business logic, feature abuse/leakage, chained trust, AI-AND-LLM.md, client-side, supply chain/CI, cloud, protocols/RPC/queues, resource exhaustion, data isolation, desktop/IPC, memory safety. NO Solidity/EVM/oracle/MEV.
- Use: method + schema + validators + AI-AND-LLM / business-logic / data-isolation / resource-exhaustion / supply-chain checklists for off-chain + agents. Not install as-is (writes to ~/, generic subagents).

## Trail of Bits skills (CC BY-SA 4.0, marketplace "trailofbits", per-plugin install)
- Fit (contracts): entry-point-analyzer, property-based-testing (Echidna/Medusa), building-secure-contracts (secure-workflow-guide, token-integration-analyzer, guidelines-advisor), audit-context-building, differential-review. Foundry adaptation is ours.
- Fit (TS/PG): semgrep (use --metrics=off), sharp-edges, insecure-defaults, supply-chain-risk-auditor (npm; but reads `gh auth token`, calls npm/PyPI/deps.dev/osv.dev).
- Relevant extra: agentic-actions-auditor (prompt injection into agents in CI).
- Avoid: gh-cli (SessionStart shims + PreToolUse hooks), codeql (no Solidity), zeroize-audit (uvx git MCP server). semgrep run-scans.sh git-clones rulesets at scan time.

## Existing coverage (Haiku inventory)
- Contracts: ProtocolAdversarial (whitewashing, 51% bribe bound, tie stall, committed whale quorum, snapshot time, sybil self-dispute credit, position shedding, reentrant token drain + 5 callback paths), ProtocolInvariant (solvency, security bound, no INVALID before hardDeadline), ProtocolFinalReview, Lifecycle, ResolutionDispute (honest majority overturns lie, stake after snapshot, conflicted jurors, commit-reveal replay, gas DoS with 60 committers), ResolutionBasic, MarketsTrading (quote replay/epoch, named taker, signature/domain, caps, fuzz complete sets/fees), MarketsCreation (spec-hash front-run, global security bound, replay switch), MarketsSettlement (wash trading no credit, fee conservation), Jurors (slash dodging, JIT staker), Registry, Governor, Faucet, ContractWalletMaker (ERC-1271), ForecastMerkle, Anchor.
- P1 known limitations: honest-majority assumption; off-chain bribery/sybil; FixedPriceSource; faucet not sybil-resistant; ERC-1271 revocable at fill; undistributedSlashed no recovery; R17 crossed by slash; ~50% cartel tie stall to INVALID; quorum counts unrevealed weight; sybil self-dispute credit farming; caller-chosen snapshot time; previousRegistry trusted at deploy.
- Off-chain: trusted proxy, idempotency, rate limits, SSRF allowlist fetcher, identity signature + fail closed, platform key rejection, sealed forecasts/votes, RFQ quote visibility, verify-quote client, ERC-1271/6492, operator key scope, suggestion limits, tx-tracking hints, webhook HTTPS, PG runtime roles, no owner/admin/pause/upgrade in contracts.
- Agents: llm-agent tools (fetch_doc same-origin, chain_write deployment-only + 50 tx cap, chain id, transcript redaction). NO prompt-injection handling anywhere.
- Gaps: price-source manipulation; prompt injection; SDK/supply chain; docs-site tampering; bond griefing/spam; vote/reveal front-running; indexer false state (partial); faucet abuse; settlement manipulation beyond 51% bound and tie stall; no Slither/Echidna/Medusa/Halmos runs.

## Tools (controller smoke, 2026-11-01)
- trailofbits/eth-security-toolbox:latest (1.01 GB, 7 months old): slither 0.11.5, echidna 2.3.1, medusa 1.5.0, forge 1.5.1; python 3.10. `pip install halmos` → Halmos 0.1.13.
- forge build of contracts in the container: ok, 14 s (copy repo + dereferenced @openzeppelin/contracts into /work).
- Slither 0.11.5 runs once `@openzeppelin/contracts` is copied inside the Foundry project (with `libs` and `remappings` pointing there), followed by `forge build --build-info --out out` and `slither . --ignore-compile`. With OpenZeppelin outside the project root it fails with `Contract IERC1155Receiver not found`.
- Echidna/Medusa/Halmos not yet run against our tests (Foundry invariant handlers exist: ProtocolInvariant).
