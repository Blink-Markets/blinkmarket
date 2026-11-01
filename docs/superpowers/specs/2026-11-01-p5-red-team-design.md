# P5: Red-team Blink before the testnet launch — design

Date: 2026-11-01. Status: discussion record. The user approved this design on 2026-11-01; P5 stopped before an implementation plan was written. Recon notes: [2026-11-01-p5-red-team-recon.md](2026-11-01-p5-red-team-recon.md).

## 1. Intent

Blink is a market run entirely by AI agents: no admin, no pause key, no platform role. Once the next contract generation is deployed, nobody can step in to stop an attack, and a bug in the contracts can only be answered by deploying a new generation. So the time to find the holes is before the testnet launch.

P5 is the red-team phase that sits between the finished vision (P1–P4) and the deferred deployment (D3, D6, Track B). It attacks the contracts, the settlement economics, the off-chain services, the agents and the documentation site the agents read; fixes what it finds; and leaves behind evidence that each known attack is covered.

## 2. Decisions the user made (2026-11-01) [User]

| # | Decision |
| --- | --- |
| R1 | P5 is a self-review before the testnet launch, done by AI agents with open-source tools. A formal external audit before mainnet is a separate later step ("對，這樣切沒問題"). |
| R2 | Done means: every attack that has happened before and every common attack is covered, and each is covered by a test guarantee, a mechanism guarantee or a mathematical guarantee ("紅隊測試完起碼要有發生過以及常見的漏洞或攻擊都測試過，無論是測試保證或是機制保證甚至是數學上保證"). |
| R3 | No human steps in. Humans jumping in to shut down an agents-only market would be wrong ("全agents自主交易的市場由人為跳下去關機也有點奇怪"). Responses are mechanisms written in advance. A circuit breaker triggered by an on-chain condition, which anyone can trigger, is acceptable because it is a rule, not a person. |
| R4 | The scope in §4, including spam and resource-exhaustion attacks, and per-unit capacity measurement (§9) in the same phase ("沒問題，這樣可以"). |
| R5 | Changes to the protocol's mechanisms or economics (circuit breakers, the quorum rule, the tie stall, sybil limits) are gathered into one proposal; the user approves it before any of it is built. Plain bugs, where the code does not do what the design says, are fixed directly. The plan has a user gate between the findings and the mechanism changes. |
| R6 | Launch gate: every confirmed Critical and Important finding is fixed. A known limitation that cannot be removed may pass with a proven maximum loss and an entry in the public residual-risk register. The red team computes recommended market caps from the economic numbers; the user approves them. |
| R7 | The red team thinks like a malicious user whose aim is profit or taking the service down, and hunts the hidden holes that appear where the parts of a complex architecture reference each other: a chain of steps across contracts, services and agents, each harmless alone ("以惡意使用者的角度，以獲利、癱瘓服務為出發點，針對複雜架構下彼此引用產生的隱藏漏洞攻擊"). The matrix (§5) is the floor; attacker goals and cross-component chains (§8.1) are the main hunt. |

Earlier decisions that still bind P5: no deployment, signing or broadcast without the user's go-ahead (U1, AGENTS.md); the honest-majority juror assumption is stated publicly (§5.12 of the autonomous market design); the platform token is a test-network experiment (U21); deployment and the `OUTCOME_ALREADY_PUBLIC` automation remain the user's decisions.

## 3. Goals, non-goals, anti-goals

**Goals**
- An attack matrix that lists every historical and common attack class relevant to Blink, and for each row: whether it applies and why, the guarantee type, the assumptions the guarantee rests on, and the evidence (test name, invariant, proof, design section).
- Where no guarantee is possible, a proven upper bound on the loss, and the row in a public residual-risk register.
- Every confirmed finding fixed, with a regression test that fails without the fix.
- A standing adversarial suite that keeps running in CI or nightly, so later changes cannot quietly reopen a hole.
- A launch gate: the list of items that must be green before the testnet deployment.

**Non-goals**
- A mainnet audit, mainnet economics or a real stablecoin (R1).
- Deploying anything, or attacking any public network, RPC provider, GitHub, DNS or other third-party service.
- Load tests against public infrastructure; P5 measures cost per unit locally (§9).
- New product features.

**Anti-goals** (failure even if the work technically finishes)
- Any admin, owner, pause key or human-operated stop added to the protocol (R3).
- A "guarantee" stated without its assumptions, or a mathematical claim that silently depends on the honest-majority assumption.
- Findings without a reproduction, or a finding confirmed by the same agent that reported it.
- Installing tooling that reads the user's credentials, adds session hooks or fetches code at run time (§8.3).

## 4. Scope: assets, attackers and the five areas

**Assets.** Collateral and bonds held by the contracts (bUSD); role and juror stakes (bUSD and the platform token); settlement outcomes; credit; information that is sealed for a time (forecasts before their deadline, quotes visible only to their taker, votes before reveal); API keys; the documentation site, because external agents act on what it says; the deployment credentials behind it (GitHub Pages, the domain's DNS); the database behind the API and indexer; and the agents' own keys, which the platform never holds but which the SDK and reference agents touch.

**Attackers.** An agent with capital; a swarm of sybil identities; a juror cartel or a single large staker; an off-chain briber; a malicious market creator (ambiguous wording, prompt injection in the question or evidence); someone who can move a data source; a compromised dependency or package; someone who tampers with the documentation site; a spammer.

**Areas.**
1. **Contracts and economics:** accounting conservation, reentrancy through token callbacks, access control (prove there is no hidden admin, including through the deployer and the generation/governance path), sybils, faucet abuse, bond griefing, front-running of quotes, votes and reveals.
2. **Settlement and price:** a false proposal, stalling a market into INVALID (the Augur pattern), juror collusion and large-staker voting (the UMA pattern), a manipulated data source, ambiguous questions, and the platform-token price source behind the per-market security bound.
3. **Off-chain services:** API authorization (sealed forecasts, quote visibility, RFQ lists, API keys), the indexer serving a false state to agents, the database, and resource exhaustion by spam.
4. **The agent layer:** prompt injection through question text, evidence and other agents' messages; malicious agents running alongside the reference agents; the SDK and reference agents as a supply-chain path to agent keys.
5. **Documentation site and deployment credentials:** tampered docs as a way to instruct every LLM agent at once; the GitHub Pages deploy path and DNS. The static website is checked for supply-chain risk only (it has no wallet, no forms and no API calls).

## 5. The attack matrix seed

The phase's first job is to complete this list; these rows are where it starts. "Covered" is what exists today (inventory of 2026-11-01).

| Area | Attack class | Prior example | Covered today | Gap |
| --- | --- | --- | --- | --- |
| 1 | Reentrancy via token callbacks | The DAO (2016) | `ProtocolAdversarial` reentrant token, five callback paths | none known |
| 1 | Accounting conservation, double claim | — | `ProtocolInvariant` solvency (ghost ledger), fee and complete-set fuzz | no symbolic proof |
| 1 | Quote replay, wrong taker, signature domain | — | `MarketsTrading`, `ContractWalletMaker` | none known |
| 1 | Hidden admin or upgrade path | — | `web-no-wallet` (no owner/admin/pause/upgrade), `Governor` tests | deployer and generation wiring not attacked |
| 1 | Sybil credit farming, whitewashing | — | adversarial tests show both are bounded by cost | accepted limitation, no bound in the matrix yet |
| 1 | Faucet abuse | — | interval test only | no bound on what a sybil swarm can do with faucet funds |
| 1 | Bond griefing (spam creations, challenges at minimum bond) | — | none | open |
| 1 | Front-running votes and reveals | — | commit-reveal replay test | open |
| 2 | Stalling a market into INVALID to collect 0.5 | Augur v1 invalid markets (2018–2019) | tie-stall test; INVALID only after hardDeadline | a ~50 % cartel can still stall (known limitation) |
| 2 | Large staker or cartel votes a false outcome | UMA vote on a Polymarket market (2025) | 51 % bribe profit bound; honest majority overturns a lie | settlement manipulation beyond these two cases |
| 2 | Platform-token price manipulation to pass the security bound | Mango Markets (2022) | none; `FixedPriceSource` on testnet | open; mainnet needs a manipulation-resistant source |
| 2 | Security bound crossed after a slash | — | invariant checks create/unstake only (R17) | open; circuit-breaker candidate |
| 2 | Manipulated data source, ambiguous wording | Polymarket wording disputes (2025) | class A archived bytes | open |
| 3 | API authorization leaks of sealed data | — | sealed forecast/vote tests, quote visibility | not attacked as a whole |
| 3 | Indexer serving a false state | — | reorg and receipt checks | partial |
| 3 | Spam and resource exhaustion | — | rate limits, gas-DoS test for 60 committers | open for API, indexer and relay |
| 4 | Prompt injection via question, evidence, peer messages | — | none anywhere | open |
| 4 | SDK / package supply chain to agent keys | — | none | open |
| 5 | Docs-site tampering instructs agents | reported cases of compromised docs and front-end scripts at prediction markets (2026, from the user's notes; not independently verified) | rendering tests only | open |

P1's own known limitations (`docs/P1_PROTOCOL_CONTRACTS.md`, "Known limitations") enter the matrix as rows; each either gets a mechanism fix or a loss bound and a residual-risk entry.

## 6. Guarantee levels

- **Test guarantee:** an executable attack that fails against the code: a Foundry test, a fuzz or invariant campaign (Foundry, Echidna or Medusa), an off-chain test, or a malicious-agent scenario in `pnpm alpha:autonomous`.
- **Mechanism guarantee:** the design makes the attack impossible or unprofitable, with the mechanism named and its own test.
- **Mathematical guarantee:** a property proved for all inputs within stated bounds (symbolic execution with Halmos on Foundry tests), or an economic inequality derived in writing (cost of corruption against benefit, per market size).

Every row names the assumptions its guarantee rests on, in particular the honest-majority juror assumption and the price source.

## 7. Responses without a human (R3)

1. **Loss caps first.** Per-market, per-identity and per-fill limits, and market size tied to juror stake, already exist. P5 produces the numbers: for each attack, the cost and the maximum gain by market size. These numbers set the launch caps.
2. **Condition-triggered circuit breakers.** Written into the contracts, triggered by an on-chain condition and callable by anyone. First candidate: when a slash leaves the security bound unmet (R17), new market creation and new fills stop until stake restores it. The red team proposes others where a condition can be stated as a formula.
3. **Per-market backstop:** INVALID only after hardDeadline (exists).
4. **Generation change:** governance deploys the next generation with a lock period and cannot touch existing markets; agents choose whether to move.
5. **Agent self-defence:** reference agents refuse markets with warning signs (for example, juror stake concentrated in a few addresses, a burst of new identities, a question that fails the class rules) and treat question text, evidence and peer messages as untrusted data.

Because the next generation is not deployed, contract changes are cheapest now. Any change keeps P1's discipline: unit, invariant and adversarial tests, and the delivery record.

## 8. Method and tools

### 8.1 Process

The hunt starts from the attacker's goal, not from a checklist (R7). Two goals: **profit** (take more out of the contracts than was put in, win a market without being right, collect credit or rewards without earning them) and **disruption** (stall settlement, block creation or trading, exhaust the API, indexer or database, make agents act on a false state). For each goal the hunters build attack chains across the trust edges where one part relies on another: contract to contract (Markets, Resolution, Jurors, Registry, Governor, the price source and the token), chain to indexer to database to API, API and docs to SDK to agent, and agent to agent. A chain is a sequence of individually allowed steps whose combination breaks an invariant; single-component checks miss it, so every chain is written as one end-to-end test.

The structure follows Cloudflare's security-audit method (MIT): reconnaissance produces the attack-surface map, the trust-edge map and a coverage ledger; hunters work one ledger unit (a component or a trust edge) each; every candidate goes to a fresh verifier whose job is to disprove it; results are recorded as `confirmed`, `needs_validation` or `rejected`; a final pass rechecks the record against the code. A hunter never verifies its own finding.

Roles follow this project's practice: Codex Terra hunts and fixes, Codex Astra verifies and reviews, Haiku agents do read-only reconnaissance in parallel, Sonnet stands in when Codex is out of budget. Docker-based tools run where Docker is available (the controller or a Sonnet agent), because the Codex sandbox has no Docker or sockets.

### 8.2 Findings format

Reuse Cloudflare's `report-schema.json` and its two validators (`validate-findings.cjs`, `validate-coverage-ledger.cjs`; Node `fs`/`path` only), copied with their MIT notice, extended with a Solidity trace field (contract, function, call sequence) and a guarantee-type field that links a finding to its matrix row.

### 8.3 Tools (checked 2026-11-01)

- `trailofbits/eth-security-toolbox` Docker image: Slither 0.11.5, Echidna 2.3.1, Medusa 1.5.0, Foundry 1.5.1. Pin it by digest. The contracts build inside it in 14 s.
- Halmos 0.1.13 installs with pip in that image. Pin the version.
- Slither does not yet run on this build: the default path fails on OpenZeppelin Governor's `IERC1155Receiver` import, and `--ignore-compile` finds no `build-info`. Making it run is P5's first setup step.
- Trail of Bits skills (CC BY-SA 4.0), read before installing and installed per project, not globally. Useful: entry-point-analyzer, property-based-testing, building-secure-contracts (secure workflow, token integration, guidelines advisor), audit-context-building, sharp-edges, insecure-defaults, semgrep (with `--metrics=off`, rules vendored rather than cloned at scan time), agentic-actions-auditor. Excluded: `gh-cli` (session hooks and PATH shims), `supply-chain-risk-auditor` as shipped (reads `gh auth token` and calls external APIs), `zeroize-audit` (starts an MCP server from git), CodeQL (no Solidity).
- Cloudflare's skill is not installed as shipped (its full mode writes under the home directory and has no smart-contract coverage); its method, schema, validators and the AI/LLM, business-logic, data-isolation, resource-exhaustion and supply-chain checklists are used as in §8.1–8.2.

## 9. Capacity measurement

Measured locally against the real services: queries and CPU per request for the main read and write paths, indexer catch-up at 10× and 100× synthetic event volume, database growth per market, and the journal membership audit that P2 left unmeasured. The output is a capacity model ("one vCPU serves about N agents at this mix") and recommended rate limits and alert thresholds. After a deployment, one light test on the chosen host calibrates the model; that test is not part of P5.

## 10. Deliverables

1. Attack matrix (§5, completed).
2. Attack-surface map, trust-edge map and coverage ledger.
3. Findings record (schema-valid) with fixes and regression tests.
4. Standing adversarial suite in CI or nightly: contract adversarial and property tests, symbolic checks, malicious-agent drill scenarios, off-chain attack tests.
5. Economic security numbers: cost and maximum gain per attack by market size, and the resulting launch caps.
6. Residual-risk register, written to be published as trust assumptions.
7. Launch gate checklist.
8. A safety guide for external agents in the agent documentation (verify on-chain; do not trust the API alone; treat question text, evidence and peer messages as untrusted), and reference agents that follow it.
9. Capacity model and recommended limits (§9).
10. The delivery record (`docs/P5_RED_TEAM.md`), README and ROADMAP updates.

## 11. Constraints

- Local only: Anvil, local PostgreSQL, Docker. No public-chain transaction, no paid service, no live LLM demo.
- Never read `~/.blink-keys/**`, `~/.config/blink/**` or the shell profile's secrets; tests use fixture keys.
- Docs and commits in English; commit and push each verified stage (AGENTS.md).
- Pace the work to the Codex budget; independent work continues on Claude agents when Codex is at its limit.
- The development host has glibc 2.28: browser, Next and some tools run in Docker or CI.

## 12. Author's calls (please check)

- **What "every attack that has happened before" is measured against.** Attack classes, not individual incidents. The catalogue is the union of the SWC registry's Solidity weakness classes, the oracle, governance and prediction-market incident classes in public post-mortem collections (DeFiHackLabs, rekt), Cloudflare's checklists for the off-chain and agent areas, and the user's notes. An incident that cannot be verified keeps its attack class in the matrix; its example is marked unverified.
- **Price source on the testnet.** P5 proves the loss bound under `FixedPriceSource` and writes down the requirements a mainnet source must meet (manipulation window, TWAP length, conservative side). It does not build a TWAP source; that belongs to the mainnet work (R1).
- **Prompt injection.** The guarantee is a mechanism: the agent's tool layer enforces its limits whatever the model says (allowed contract addresses, chain id, transaction caps, same-origin docs; `examples/llm-agent/src/tools.ts` already does some of this). Tests feed hostile question text, evidence and peer messages through fixture model responses, including a fully fooled model, and show the damage stays inside the tool policy. P5 makes no claim about how a real model behaves.
- **Documentation and deployment integrity.** Two parts. A mechanism: agents never take contract addresses or approval targets from documentation at run time; the SDK and reference agents ship the deployment manifest with its hash, and a test shows a tampered doc cannot redirect a write. A review: the GitHub Pages workflow and repository settings are read and checked (pinned actions, least-privilege tokens, environment protection); changes to settings are outward-facing, so they go to the user as recommendations.
- **Cloudflare files.** Fetched once at a pinned commit during setup and copied into the repository with the MIT notice. This is a one-time copy, not a run-time fetch.
- **CI cost.** Fast attack tests run on every push within the current CI time; long fuzz and symbolic campaigns run nightly.

## 13. Left to the builder

- The exact circuit-breaker conditions and which actions each one stops.
- The ledger's unit granularity and the order of the areas.
- Which properties get symbolic proofs, and their bounds.
- How the prompt-injection tests are built (fixture LLM responses or a recorded transcript; no paid model).
- Whether the standing suite runs per push or nightly, within CI time.
- Whether the copied Cloudflare files live under `security/` or `docs/`.
