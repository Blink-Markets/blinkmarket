# Q13 Attack Simulation of Mechanism R: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide, before any contract code exists, whether Mechanism R (the sponsor-funded forecast bounty) can be exploited for profit beyond its published costs. The simulation runs one scripted strategy for every attack in the spec's attack table that only a simulation can check, plus LLM participants that search for strategies the table does not list. It also proposes the parameters the spec leaves to "set by simulation", recomputes what a sponsor expects to pay under burning, and measures seven open questions. The user decides, from the result, whether Mechanism R enters the next contract generation.

**Architecture:**
- One new pure TypeScript package, `@blink/mechanism-model` (`packages/mechanism-model`): an executable model of Mechanism R with exact rational arithmetic and the contracts' integer rules side by side, an invariant checker, and the stylised neighbours the attacks need (the security bound, makers, the resolution rounds, the credit read model). It has no dependency, performs no I/O and is not imported by any app or service.
- One harness directory, `scripts/q13/`: the pass criteria file, the random scenario generator, the scripted strategies, the parameter sweeps, the report writers, and the LLM runner (the only code that touches the network, and only after the user approves its cost).
- Tests live in `tests/` because `pnpm test` runs only `tests/*.test.ts` (`package.json:13`).
- Results: small tables and the written report are committed; transcripts and per-seed outputs stay in `tmp/q13/`, which git ignores (`.gitignore:6`).

**Tech Stack:**
- Node 22 and pnpm as pinned by `.nvmrc` (22.23.1) and `packageManager` (`package.json:6`), `tsx`, `node:test`, `BigInt`
- `@anthropic-ai/sdk` 1.3.0 (the version `examples/llm-agent/package.json:10` pins), for the LLM stage only
- No Foundry, no Anvil, no database, no Python in the plan's own code; the review scripts stay Python and supply the first vectors once

**Decision record:** [the long-horizon discussion](../specs/2026-11-16-long-horizon-forecasting-discussion.md), section 8 (Q13, with the note of 2026-11-23) and 12.5 to 12.13. **Design:** [the next-generation spec](../specs/2026-11-23-next-generation-design.md), cited here as "the spec", especially section 9.7 (the binding requirements of this simulation), 9.4 (the reference model), 8.2 (the attack table), 6 (the parameters), 7 (the invariants) and 10 (the open questions, "OQ-n"). **Method for findings:** [the P5 design](../specs/2026-11-01-p5-red-team-design.md), section 14.

**Where work lands:** `main`, the established branch (`AGENTS.md`: stage checkpoints push to the project's remote and branch). Each implementer works in its own git worktree on a throwaway branch; after a task passes its checks and its review, the controller merges it and pushes (the checkpoint procedure of the [direction-1 plan](2026-11-23-direction-1-event-driven-forecasting.md), section 5, applies unchanged). Edits to this plan alone touch only `docs/superpowers/**`, which CI skips (`.github/workflows/ci.yml:9`, `:11`).

**Prerequisite:** the spec's open questions are decided (2026-11-26) and the roadmap puts this simulation before the implementation plan ([roadmap](../../ROADMAP.md), "Next steps"). The user answers the questions in section 10 before Task 1 starts; SQ1 (the LLM budget) is needed only before Task 10.

## Global Constraints

- **Language.** Internal docs, comments, commit messages and test names are English. Quoted user words stay in their language with an English gloss. This applies to every brief the controller writes.
- **No machine details in tracked files.** No host paths, OS or library versions of a development host, container names or tool setups. Verification limits are recorded as facts ("not run locally; CI ran it").
- **Offline until approved.** Tasks 1 to 9 make no network call and spend no money. No LLM API call, and no other paid service, happens before the user answers SQ1 with a budget (Task 10 checks the approval file before it starts).
- **Defensive method.** A profitable strategy is a finding, written as a minimal failing test after the implementation exists (spec 9.7; P5 section 14). The plan builds no tool that attacks a deployed contract, and no code here can talk to a chain.
- **Test first.** Every task starts with failing tests (red), then the code (green), then cleanup. A task is not done on green alone: it needs the review of the Definition of Done in `AGENTS.md`.
- **Pass criteria are fixed first.** Task 5 commits `criteria.json` before any strategy runs. A change after the first result needs a dated amendment entry (section 1.5).
- **Secrets.** The Anthropic key comes only from the environment, is never written to a file, a log, a transcript or a result, and every log line passes through a redaction function.
- **One model, many readers.** The model is written for this simulation and reused by the implementation plan's differential tests (spec 9.4). It never imports `viem`, `ethers` or any network module; a test enforces this.
- **Controller discipline.** The controller does not edit project code or tests; it dispatches implementers and reviewers per `AGENTS.md`, integrates, verifies, commits and pushes, and records each stage in `docs/Q13_SIMULATION_PROGRESS.md`.

## Review Focus

A reviewer reads each task's diff against these questions:

- Does the integer engine use the rounding direction of spec 4.0 and 4.2 in every formula, and is each `mulDiv` call explicit about Floor or Ceil?
- Does the invariant checker run after every action, and is each of I-1 to I-25 asserted rather than only listed?
- Does a strategy measure total net profit over all identities and channels it controls, with every published cost charged, and compare it with the right benchmark (section 1.2)?
- Is a verdict computed by the pre-registered function from `criteria.json`, with no threshold written into a strategy file?
- Does the LLM runner enforce the spend cap before each request, compute spend from the response's `usage`, and stop when the cap would be exceeded?
- Is anything in a committed file machine-specific, secret, or a working attack tool?

## 0. Terms

Each term is defined once here and used with this meaning throughout.

- **Mechanism R** (spec 4.2): a sponsor escrows an amount **X** of vault shares for a question. Over a fixed list of **windows** t = 1..T, forecasters **commit** (a hash of a report) and later **reveal** it. A window closes and moves the **baseline** b (the published running probability) toward the reveals. A forecaster is paid per unit of exposure the difference between the baseline's loss and its own report's loss, **L(p, y) = (p − y)²**, with y = 1 if YES and 0 if NO. Net losses are burned, so the sponsor never gets back more than X (I-1).
- **Allowance B_t**: the most exposure window t can fill. The list B_1 > B_2 > ... > B_T > 0 strictly decreases (I-2).
- **Request x, band δ, report p**: a commit asks for exposure x ≤ B_t with a declared maximum distance δ from the baseline; the reveal gives the report p, clamped into [b − δ, b + δ].
- **Fill**: if the revealed total R exceeds B_t, each request is scaled by B_t ÷ R. The filled exposure is **e**.
- **Deposit, lock, forfeit**: a commit posts a deposit sized on the worst loss inside its band; at reveal the part beyond the **lock** (the most it can lose on its filled part) comes back; a commit never revealed **forfeits** its deposit on the part that would have filled.
- **W** = 10^18, the fixed-point scale of every WAD value (1.0 = W). A **share** is one whole vault share and a **base unit** is 10^-18 of it; "shares" in tables means whole shares.
- **Strategy**: a list of actions by one actor, which may control several **identities** (registered addresses).
- **Exact value**: the rational value of a formula with no rounding. **Integer value**: the same formula with the contracts' rounding rules (spec 4.0).
- **Net profit** of an actor: everything its identities receive minus everything they pay, in shares, including channels outside the bounty that the model covers (trades against makers, sponsor refunds, juror payments).

## 1. The question and the pass criteria, fixed before any run

### 1.1 What the simulation decides

The spec's question (9.7, output 1) is "does any strategy profit beyond the published costs (§4.10)?". The gate that lets Mechanism R into the generation has five parts, all required:

- **G1.** Every scripted strategy ends PASS, MARGINAL-EXACT, MATCHES-DISCLOSURE or MEASURED-AND-REPORTED (section 1.3).
- **G2.** No LLM-found strategy ends FAIL or BORDERLINE after it is replayed and minimized (section 4.4).
- **G3.** At least 10^6 random scenarios run with zero invariant violations (section 2.6).
- **G4.** For every parameter "set by simulation" there is a value at which G1 and G2 still hold (section 5).
- **G5.** The sponsor-cost report of section 6 is delivered.

The simulation reports the gate; the user decides what a FAIL means. A FAIL is not automatically a rule change: the user may change a rule, accept and disclose the finding, or drop Mechanism R from the generation. The simulation never changes a rule itself.

### 1.2 What "profits beyond the published costs" means

**Published costs** are every cost a participant can read or compute before it acts. The model charges all of them to the actor:

- the entry fee, ceil(φ·x ÷ W) per commit (rule 8);
- forfeits on missed reveals (rule 9) and the burned net loss (rule 7);
- the registration fee of each identity (10 bUSD today, `packages/schemas/src/protocol-params.ts:85`, in shares from now on, spec A-1); the role stake (100 bUSD, `:86`) is refundable, so it costs only when slashed;
- the trading fee a buyer pays at a maker (1% in the spec's example).

The Q19 numbers of spec 4.10 are the published yardstick, not a separate charge: certainCost = floor((B_t − B_{t+1})·d² ÷ W²) + floor(φ·(B_t + B_{t+1}) ÷ W) for a drag of d, and contestedCost = floor(B_t·d² ÷ W²) + floor(φ·B_t ÷ W). A strategy that follows them (for example, drag and trade at or below the safe depth) must not show excess. The drag's cost is realized through the bounty's own payouts, so charging the Q19 number as well would count it twice.

Capital cost is not charged: collateral is a vault share and interest accrues to the share (spec 4.1), so locking it costs nothing in the simulation. Gas is not charged; each result lists the number of calls per strategy so the implementation plan can price them.

**The actor's net profit** is summed over every identity the strategy controls, including the sponsor's identity if the strategy has one. The model computes it exactly over the outcome y when the other participants are deterministic: it evaluates y = YES and y = NO and weights them by the true probability q. It samples only when a population is random (section 1.4).

**The benchmark** is what the same actor earns by playing honestly with the same information and control. Three worlds, fixed in `criteria.json`:

- **World N (no information).** The true chance of YES is q = b₀ and everyone knows it. Honest play earns 0, so any positive net profit is extraction from the escrow or from other participants.
- **World I (information).** The true chance q differs from b₀ (pairs fixed in `criteria.json`, for example (b₀, q) = (30%, 37.5%), (50%, 55%), (50%, 60%), (30%, 85%)). Some participants know q. The benchmark is the best honest strategy for an actor with that knowledge: reports of q in any subset of the windows, with request sizes chosen per window on the grid, and the same identities and registrations as the strategy.
- **World C (control).** The actor controls the outcome or the data (a sponsor that controls the source, T-13a, T-13b). It chooses y. The benchmark is the best honest strategy of an actor *without the sponsor role* that knows y with certainty (World I with q ∈ {0, 1}), plus what the same sponsor earns without forecasting. Excess therefore measures only what the sponsor role adds. T-15 uses the same rule with World I, so the two rows are consistent.

**Excess** = net profit of the strategy − the benchmark's net profit in the same world and cell.

**The threshold.** τ = max(1% of the strategy's published cost, 10^-5 × B_1), in shares, where "the strategy's published cost" is the sum of the published costs the strategy itself pays, net of any amount the same actor recovers (refunds, and fees returned through the sponsor refund), and B_1 is the first allowance of the cell. Netting stops a strategy from inflating its own cost to raise τ.

Worked: T-6 (pinning) at B = 40,000 shares and φ = 0.02% pays 9·φ·B = 72 per window (spec T-6). τ = max(1% × 72, 10^-5 × 40,000) = max(0.72, 0.40) = 0.72 shares. A pin that nets +0.50 is within τ; one that nets +0.90 is a FAIL; one that nets −72 passes with room.

**Exceptions with fixed rules:**

- **Rounding (T-39) has no tolerance.** Any operation that rounds against the contract's direction (spec 4.0, I-23) is a FAIL, however small. Only the total dust an attacker can gather is compared with its cost: dust below the registration fee of the identities it needs passes.
- **Capacity and counting invariants have no tolerance.** A window counting more than cap_t (I-13), or any invariant violation, is a FAIL.

### 1.3 Verdicts and borderline handling

| Verdict | Condition | Gate effect |
| --- | --- | --- |
| PASS | Exact excess ≤ 0; or sampled, the upper confidence bound of excess ≤ τ | Passes |
| MARGINAL-EXACT | Exact excess in (0, τ], and the excess does not grow when the strategy is repeated k = 1, 10 and 100 times across windows, identities or markets, with each copy's costs charged (registration included). Otherwise FAIL | Passes; listed in the report with its size; kept as a regression test |
| MATCHES-DISCLOSURE | The spec's table gives a disclosed profit figure (T-2 beyond the safe depth, T-13b, T-31, T-42); measured profit ≤ the disclosed number + max(τ, 1% of that number) | Passes; the measured figure goes to the sponsor and maker pages |
| MEASURED-AND-REPORTED | The spec says the outcome is open or labelled but gives no profit figure (T-9, T-10, T-44, T-45; the controller's forecasting gain in T-13a; the today's-rules results of T-29, T-45 and T-46) | Passes; the cost or profit curve goes to the user in the report |
| BORDERLINE | A sampled cell whose confidence interval still contains τ after 10^5 seeds; or a disclosed profit above its number plus the margin above and at most 5% above the number | Treated as FAIL for the gate until resolved (below) |
| FAIL | Exact excess > τ; or sampled, the lower confidence bound of excess > τ; or a disclosed profit more than 5% above its number | Fails the gate; reported to the user with the strategy |

**How a borderline result is resolved.** It is run once more, with 10^6 seeds, or, better, by exact enumeration over a discretized support if the support has at most 10^6 leaves. If the interval still contains τ it stays BORDERLINE, counts as FAIL for the gate, and goes to the user in the report with the interval and the cell. Nobody lowers or raises τ to change a verdict (section 1.5).

### 1.4 Numbers: seeds, runs, confidence

- **Exact cells first.** Most scripted strategies face deterministic opponents (honest reports, makers that follow the published depth rule). Their profit is computed exactly by enumerating y ∈ {YES, NO}, and exact mixture over a small discrete support (for example, an outage that starts in one of 24 hourly slots) where the spec's randomness is discrete. These cells use no seeds and need no confidence level.
- **Sampled cells** are used only when exact enumeration would have more than 10^6 leaves (a continuous or large random population). They use common random numbers (the strategy and its benchmark see the same seed) so the variance of the excess is far below the variance of either profit.
- **Staged seeds.** 10^3, then 10^4, then 10^5 per cell. A cell leaves the ladder when its verdict is PASS or FAIL; it climbs while it is not. A cell that reaches 10^5 and is not resolved is BORDERLINE.
- **Confidence.** One-sided, 99% family-wise. The excess mean is estimated by batch means (50 batches of equal size; the critical value is Student's t with 49 degrees of freedom, from a tested function). K, the number of sampled cells, is fixed in `criteria.json` from the grids before the first run. With 3 stages and the one borderline rerun (section 1.3), the per-cell, per-look level is α = 0.01 ÷ (4K) (Bonferroni, so that sequential looks do not inflate the error).
  - Worked: K = 1,000 cells gives α = 0.01 ÷ 4,000 = 2.5 × 10^-6, which is 99.99975% per looked-at interval.
- **Sampled threshold.** A sampled cell uses τ_s = max(τ, 10^-4 × B_1), because at 10^5 seeds the standard error is the excess standard deviation ÷ 316, and with t about 5.5 at this α and 49 degrees of freedom the interval is narrower than τ only if the excess standard deviation is below about 6 × 10^-4 × B_1 for τ = 10^-5 × B_1, and below about 6 × 10^-3 × B_1 for τ_s. Task 5 measures the excess standard deviation at stage 1; if it makes the interval at 10^5 seeds wider than τ_s, the cell is declared unresolvable at this size and is BORDERLINE by rule, not by surprise.
- **Random scenarios for the invariants (G3):** at least 10^6, from a fixed seed, with a coverage floor (section 2.6). The count is a floor; the run records the count it did.
- **Randomness** is a seeded generator written in the harness (no `Math.random`), and every result records its seeds, so any cell reruns identically.

### 1.5 Pre-registration

- `scripts/q13/criteria.json` holds: the three worlds and their (b₀, q) pairs; τ's rule and constants; the staged seed ladder; the confidence level, batch count and K; the parameter grids and picking rules of section 5; the strategy list with each strategy's expected class (NOT-PROFITABLE, PROFITABLE-AS-DISCLOSED with the disclosed number and its source, or MEASURED-AND-REPORTED); the LLM stage settings.
- Task 5 commits it, with a test that computes its SHA-256 and compares it with the hash written into every results file (`criteriaSha256`). A results file whose hash differs from the current file fails the test.
- The controller records the commit hash of `criteria.json` in the progress document before the first strategy runs. That order, criteria then results, is the pre-registration.
- A change after the first result is a new entry in `scripts/q13/criteria-amendments.json` (date, field, old value, new value, reason). The report lists every amendment and reruns every affected verdict under both the old and the new value.

## 2. The reference model

### 2.1 Language and location

Spec 9.4 says this plan "chooses the model's language and location; the implementation plan reuses it". Options:

| Option | Reuse by implementation-plan differential tests | Repo toolchain and CI | Language of the review scripts | Verdict |
| --- | --- | --- | --- | --- |
| A. TypeScript package `packages/mechanism-model`, harness in `scripts/q13/` | The model writes JSON vectors; the Foundry tests read them with `vm.readFile` and `vm.parseJson`; no `vm.ffi` is needed | `node:test` in `pnpm test`, `tsc` in `pnpm typecheck`, both inside `pnpm check` (CI job `check`); `BigInt` gives uint256 arithmetic natively | Different (the scripts are Python floats); their output becomes the first vectors | **Recommended** |
| B. TypeScript, harness and model both in `scripts/q13/` | Same | Same | Same | Works; but the off-chain reducer and the reference agents (spec 5.1, 5.4) could not import it without reaching into `scripts/` |
| C. Python beside the review scripts | Same JSON route | No Python step in CI (`.github/workflows/ci.yml`); a new toolchain to pin | Same as the scripts: lowest friction for the first vectors | Rejected: the verification would not run in `pnpm check`, so it could rot |
| D. A reference Solidity contract tested in Foundry | Direct, but it is the contract, not an independent model | Needs Foundry for every run | Different | Rejected: a differential test needs an implementation independent of the contract |

**Recommendation: A.** Reasons:

- The model, its tests and the vectors run in the same CI job as the rest of the repository.
- The off-chain code that must reproduce the same numbers (the baseline display, the Q19 numbers for makers, the sponsor cost estimate on the website) can import one implementation.
- Exact rationals on `BigInt` avoid the float noise the Python scripts remove with `Decimal` rounding (`worked_example.py:13`).
- Cost of A: one entry in the `allowed` map of `scripts/check-boundaries.mjs:4` (an empty dependency list), and a rule that no app imports the package. The web build and the service bundles never consume it, so the web and service rows of the Definition of Done do not apply; Task 1 adds a test that proves it.

The package follows the repository's source-export pattern (`"exports": "./src/index.ts"`, as in `packages/domain/package.json`).

**How the implementation plan reuses it.** `pnpm q13:vectors` writes `contracts/test/vectors/*.json` (a directory the implementation plan creates) from fixed seeds, with every amount as a decimal string. The Foundry differential tests read them. `contracts/foundry.toml` has no `fs_permissions` today (fuzz and invariant sections only, `contracts/foundry.toml:13–19`), so the implementation plan adds a read-only permission for that directory. `vm.ffi` is not used: it runs arbitrary commands from a test.

### 2.2 State, actions and events

All names follow spec 4.2; the model has no behaviour the spec does not state.

**State**

- *Generation parameters* (spec 6): W, φ bounds, `maxWindows`, `minAllowanceStepBps`, `minAllowance`, `maxFundingLead`, `minEscrowAdd`, `minCommitDeposit`, band and report grids, `b0MinWad`, `b0MaxWad`, `maxAllowance` = 2^96, `securityMultipleBps`.
- *Bounty*: b₀, φ, T, `commitStarts[]`, `allowances[]`, X and per-sponsor X_j, the baseline series b_1..b_{T+1}, and per window: R, P, H, the four direction sums, the two counts, `preRevealBound`, `revealedBound`, closed flag.
- *Commits*, keyed by (market, window, forecaster): x, δ, commitment, deposit, fee, revealed flag, p, lockFull, released flag.
- *Totals*: G_YES, G_NO, L_YES, L_NO, F (fees), M (forfeits), the claim count, the residue.
- *Market and neighbours* (stylised, section 2.7): `maxPayout`, `boundShares`, S1, S2, `hwm`, the vault price, a juror stake snapshot, the resolution state (OPEN, PROPOSED, DISPUTED, FINAL(y), INVALID), makers' quotes, the credit ledger.
- *Clock*: block time, advanced by explicit actions.

**Actions** (each returns an event list or a named revert):

- the bounty's own: `openBounty`, `addEscrow`, `commit`, `reveal`, `closeWindow`, `releaseUnfilled`, `settle`, `claim`, `sweep`;
- the environment's: `advanceTime`, `setVaultPrice`, `propose`, `challenge`, `voteCommit`, `voteReveal`, `finalizeOrTimeout`, `makerQuote`, `takeFromMaker`, `outage(start, length)`.

**Events** mirror spec 4.2.11 by name and fields (for example `WindowClosed` with the requested, revealed and filled totals, the mean m, the baseline before and after, and the missed count). The event log is part of every vector.

**Reverts** use the spec's error names (`WindowNotOpen`, `InvalidRequest`, `BountyExists`, `SecurityBoundExceeded`, and the rest of spec 4.2.12), so a strategy that tries an illegal action is told why.

### 2.3 Exact and integer arithmetic side by side

- **Integer engine.** `mulDiv(a, b, c, Floor | Ceil)` is the only multiplication-then-division primitive; every formula in spec 4.2 uses it with the direction the spec states (deposit, fee, lock and forfeit round up; baseline, G round down; L rounds up; closedBound and cap_t round up). Every intermediate is asserted below 2^256, and request and allowance values below `maxAllowance` = 2^96, so an overflow that the contracts would hit throws `Overflow` in the model.
- **Exact engine.** A `Rational` class (BigInt numerator and denominator, normalized) evaluates the same formulas with no rounding.
- **How they are compared.**
  1. *Per-operation shadow check (I-23).* For every rounding operation the integer engine also computes the exact value of the same formula on the same integer inputs, and asserts the integer result is within one base unit in the spec's direction. This is the check spec 9.4 calls "the gap between the exact and the integer values".
  2. *Trajectory drift.* The same action list runs through both engines independently (the integer baseline is floored each window, so the trajectories separate slightly). The maximum drift per final amount is recorded. The spec gives a per-operation bound (I-23) and a residue bound (I-24, fewer base units than commits plus sponsors) but no trajectory bound; Task 3 derives one, and a reviewer checks the derivation. Until it is checked, drift is reported, not asserted.
- **Worked example of why both are needed.** Window 1 of the rain example: P = 750 and R = 2,000 give b′ = 750 ÷ 2,000 = 37.5% exactly; with b₀ = 30.0001% the integer engine floors b′ to the base unit and the exact engine does not. The shadow check compares each flooring with its exact value; the drift report shows the accumulated effect.

### 2.4 Invariants checked after every step

All of I-1 to I-25 (spec 7) are implemented as functions over the model state and run after every action in every scenario and strategy:

- *Money:* I-1 sponsor cap, I-4 escrow sufficiency, I-5 solvency (the ledger of held deposits, locks, escrow, fees, forfeits, gains owed and residue), I-14 conservation, I-15 INVALID, I-22 destinations.
- *Windows and fills:* I-2 schedule, I-3 and I-21 no change after window 1, I-6 fill bounds, I-7 locks, I-9 payout identity (within 2 base units), I-10 baseline, I-11 only reveals move it, I-19 time order.
- *Commits:* I-8 missed reveals, I-16 no early payment, I-17 one commit, I-18 binding.
- *Bound:* I-12 security bound, I-13 accounting (including the window cap).
- *Jurors:* I-20 conflict.
- *Rounding and residue:* I-23, I-24.
- *I-25 (shares only)* is structural: the model's vault port exposes only the share price and share transfers, so a call to `deposit`, `mint`, `withdraw` or `redeem` cannot be written; a test asserts the port's keys.

A violation throws a typed `InvariantViolation` with the invariant name, the step index and the state digest, so a failing random scenario is a one-line reproduction.

### 2.5 Test vectors

The review scripts are the first vectors (spec 9.4, 9.2). A one-off run of each script with `python3 -I` produces a JSON file stored in `packages/mechanism-model/vectors/`, each carrying the script's name, the git blob hash of the script and the printed numbers. A pure-Node test hashes the script file in the repository and fails if it no longer matches, so a changed script is noticed. CI runs no Python.

| Vector | Source | What the model must reproduce, to the cent |
| --- | --- | --- |
| Rain example, main case (C reveals 60%) | `worked_example.py`; spec 3.3, 4.2.3 to 4.2.9 | X_min = 490.00 shares + 6,000 base units; b: 30% → 37.5% → 60% → 85%; A's lockFull 70.00, 162.50 back at reveal, 35.00 back at release; G, L, refund and burn at YES (back 214.525 + 6,000 base units, burn 0), NO (back X, burn 294.525) and INVALID (back X, 2.90 fees to the treasury); bound 150 + 270 + 150 = 570 |
| Rain example, "Other rules" variant (C misses its reveal) | `worked_example.py`; spec 4.2.7 | C, alone with x = 600 = B in window 2, forfeits 225.00 and gets nothing back; R = 0 so the baseline stays 37.5% (rule 5) |
| T-13a coalition | Section 11, ruling 5 | Sponsor with its own identity S′: +53.25 at NO and −150.225 at YES; an outsider with the same report: +59.775 at NO; the sponsor role adds −6.525 |
| Round 3 | `reconfirmed_examples.py`; spec 4.10 | Certain cost 0.94, contested cost 10.20, safe depth 14.3 shares, +8.0 at 136 shares, +31.9 at 500; best drag 12.6 points with depth 13.8; 575 at B_1 = 40,000 |
| Round 5 | `reconfirmed_examples.py`; spec 4.3 | Price 1.0816 after two years at 4%; bound 570 shares worth 616.51; reserve 80, 40, 0 |
| Cash flows | `reopen_cashflow.py` | Scenario A and D numbers 608 and 3,648, as a comparison column for section 6 (they are the earlier rule, not burning) |
| Other spec worked numbers | spec 4.2.4 to 4.2.8, 4.3 | b′ = 37.5% and 60%; forfeit 62.5% at R = 600, x = 1,000, B = 1,000; cap 40,000 against 80,000 per identity (OQ-16); INVALID worth 275.475 to sponsor S |

Each vector is a red test written before the engine exists.

### 2.6 Random scenarios

Spec 9.4 lists the cases; the generator draws from a fixed seed:

- 1 to 6 windows mostly, with a smaller share up to `maxWindows` (18 and 24);
- oversubscription (R > B), exact fill (R = B), undersubscription (R < B), and R = 0;
- missed reveals, including a missed commit whose x makes R + x ≤ B and one that makes it exceed B;
- reports inside the band, clamped at either end, and equal to b;
- both outcomes and INVALID;
- co-sponsors through `addEscrow` before window 1 (OQ-4 (c)), with scaled allowances;
- values near the overflow edges (requests of 1 base unit and of 2^96 − 1), and b near 0 and W.

A run has at least 10^6 scenarios, about 50 actions each, and checks every invariant after every action. **Coverage floor:** the run asserts each branch above was hit at least 1,000 times (the counters are in the result), so a generator that never reaches the interesting cases fails the run. CI runs 10^4 scenarios per push; the full 10^6 is `pnpm q13:invariants`, run by the controller and recorded with its seed and count (not part of CI by default).

### 2.7 The stylised neighbours

The attacks need four things outside `BlinkBounties`. They are modelled only as far as the incentives need, from the spec's text and today's parameters, and labelled "stylised" in the code and the report:

- **The security bound** (spec 4.3): `boundShares`, S1, S2, the reserve, `hwm`, the window cap cap_t = ceil(2·B_t·max(b_t, W − b_t) ÷ W), and the check value × `securityMultipleBps` ≤ attack cost × 10,000 (`securityMultipleBps` = 20,000, `packages/schemas/src/protocol-params.ts:118`).
- **Makers** that quote off the published baseline with a spread (3 points in the spec's example) and a depth rule: they follow at most the Q19 safe depth in total (spec 4.10, 5.4).
- **Resolution rounds**: a proposal, a challenge, rounds with a quorum of the snapshot stake (`quorumBps` 20%, 30%, 40%, 50%, `protocol-params.ts:113`), a non-reveal slash (`nonRevealSlashBps` 10%, `:114`), a timeout to INVALID, bonds sized on `maxPayout` or, with OQ-14 (b), on `boundShares` (`proposerBondBps` and `challengeBondBps` 5%, `:96`, `:97`), and the fee shares' destination (jurors today, treasury under OQ-29 (e)).
- **The credit read model** (spec 4.9): the score s = L(b_t, y) − L(p, y), at most one entry per question, a pass-or-fail test at significance α after `n_min` entries.

The rules of today's resolution contract that the stylised layer copies are cited by the spec (for example `contracts/src/protocol/BlinkResolution.sol:332`, `:335`, `:337`, `:475`); the layer never imports contract code. If the stylised layer disagrees with what the contracts do once built, the implementation plan's differential tests find it.

## 3. Scripted strategies

One strategy per row of spec 8.2 marked "Simulation" or "Both": **27 rows**. Each is a file `scripts/q13/strategies/t-<n>.ts` exporting its id, its parameter grid, a `run(cell)` returning the actor's net profit and the benchmark's, and its expected class from `criteria.json`. A strategy's test first asserts that the model reproduces the number the spec states (red), then that the verdict function returns the expected class. "Spec number" below means the figure the spec quotes for that row.

| Row | The attack | Parameters swept | What it measures | Expected outcome (pass rule) |
| --- | --- | --- | --- | --- |
| T-1 | Drag the baseline, then correct it later | Drag 2 to 40 points; T in {2, 3, 6, 18}; correction fraction 0 to 100%; plus 300,000 random six-window strategies | Best net profit over all of them | Best ≤ 0 (spec: best 0, a partial drag loses 8.1 to 24.0). PASS |
| T-2 | Drag, then buy from makers who quote off the baseline, then correct | Depth D from 1 to 500 shares; B_1 in {1,000, 40,000}; T = 18; drag 4 to 40 points; windows 1 to T | Profit by depth, without the late choice of direction (T-21 adds it) | Spec: about 0 at 14 shares, +8.0 at 136, +31.9 at 500. FAIL if profit > τ at any D at or below the published safe depth; beyond it, MATCHES-DISCLOSURE |
| T-3 | Drag in the last window | d in 4 to 40; B_T | Certain cost against B_T·d² + φ·B_T; the `frozen` flag | Certain cost equals contested cost; no profit at or below the published depth. PASS |
| T-5 | Hold private information until a later window | Delay 0 to T − 1 windows; one report or 2 to 5 steps; monopolist and shared | Profit by delay against reporting at window 1 | Spec: monopolist 1 instead of 10; five slow steps 8.8 against 10. PASS (delay never beats window 1 by more than τ) |
| T-6 | Pin the baseline with a huge request and a baseline report | Pin size 1 to 20 × B; φ in the grid; an honest forecaster at 0.7 against b = 0.5 | Baseline movement; pinner's cost; honest closing speed | Spec: baseline moves to 0.52; cost 9·φ·B = 72 at B = 40,000, φ = 0.02%; honest forecaster closes 10% of the gap a window, 85% after 18. PASS |
| T-7 | Identically informed forecasters over-request | n in {2, 5, 10}; edge in {2, 5, 10} points; request multiples 1 to 10; φ in the grid | The share of rent that turns into fees; net per forecaster | Spec: 62% at n = 5, 5 points, φ = 0.02%; 4% at n = 2, 10 points. No forecaster nets more than the honest benchmark + τ. PASS |
| T-8 | Split one forecaster into several identities | 1 to 20 identities; random searches (200,000) over reports and sizes; registration charged | Largest gain of the split over a single identity | Spec: ≤ 0. PASS |
| T-9 | Sybil identities copy the baseline to qualify for credit | Identities 1 to 1,000; (α, `n_min`, minimum filled exposure) from section 5 | Identities that qualify; cost per qualified identity (fees + registration) | Spec: they qualify at about 10 bUSD of fees plus a refundable 100 each. MEASURED-AND-REPORTED; the curve feeds the OQ-10 values |
| T-10 | Sybil identities capture the unstaked median | Share of qualifying identities 0 to 100%; honest population sizes | Share needed to move the median by a given amount; its cost | Spec: possible, labelled only. MEASURED-AND-REPORTED |
| T-13a | A sponsor that controls the source publishes the opposite result | Sponsor's identities 0 or 1 as forecaster; report and size; outcome chosen after seeing reveals; the same identity held by an outsider with the same control | Sponsor net, split into refund, own payout and fees; the source controller's gain from forecasting | Sponsor refund ≤ X_j at every cell (I-1); combined sponsor-and-identity net ≤ outsider-insider net + τ. PASS expected (hand calculation, section 11 ruling 5: the sponsor role adds −6.525). Separately measured and reported (MEASURED-AND-REPORTED): the controller's gain from forecasting, min(G_own, F + M + L) − fee, as a resolution-integrity disclosure; record 12.6 item 1 withdrew the Q23 (c) ground on the premise that this gain is 0 (SQ5) |
| T-13b | A sponsor that controls the source withholds the result to force INVALID | The same sponsor with and without maker trades; X and b₀ sweep | What withholding saves; the Q19 disclosure (`sponsorsOf`, `specHash`) | Spec: saves 275.475 in the rain example at YES. MATCHES-DISCLOSURE |
| T-15 | A sponsor forecasts on its own question | Sponsor informed or not; report and size | Sponsor's total net against an ordinary forecaster with the same information | No gain beyond the ordinary forecaster (burning means it pays for its own drag). PASS |
| T-18 | An honest operator misses reveals | Miss rate 0 to 10%; band equal to the 5-point edge | Net against miss rate | Spec: break-even near 4.8%. PASS if the model's break-even is within 0.5 points of it |
| T-20 | Tie up bound capacity before reveal | 1 to 1,000 identities committing B_t with the widest band; B_t = 40,000, b = 50% | The window's counted bound; attacker's cost per unit blocked | Counted ≤ cap_t = 40,000 (OQ-16 (b)); no profit. Zero tolerance on the cap. PASS |
| T-21 | Selective reveal across identities after seeing others | 2 to 6 identities with opposite reports; reveal subsets | The extra profit of choosing the drag direction late (OQ-20) | Withheld identity forfeits at least its lock (I-8). The T-2 profit curve is recomputed with the option and reported as f; it does not change T-2's verdict. The gate uses OQ-20's rule: f ≤ 1.2 passes; f > 1.2 goes to the user (section 7) |
| T-26 | Sequencer outage during a reveal phase | Outage 0.5 to 48 hours; reveal phase 1 to 48 hours; start slot | Honest forfeits as a share of reward | Used to set `forecastRevealSeconds` (OQ-19); expected: no forfeit if the phase exceeds the outage by the agents' retry interval. PASS at the chosen value |
| T-28 | Bribe jurors to flip an outcome | Stake distributions; bounties at the bound limit; briber budget | Gain from a flip against the cost of half the jurors' stake | Open payouts stay within a quarter of the jurors' staked value (I-12, I-13): gain ÷ attack cost ≤ 1 ÷ 2. PASS |
| T-29 | Stall a market into INVALID | For each party (losing forecasters, winning sponsor): the value of INVALID; each path's cost | INVALID value against the cost of the cheapest path (T-13b, T-45, T-46) | Reports the stall cost per path under today's rules and under OQ-29 (e); feeds OQ-15 and OQ-29 |
| T-30 | A shell market: tiny `maxPayout`, large bounty | `maxPayout` 1 to 1,000; bounty 1,000 to 100,000; bonds on `maxPayout` (today, OQ-14 (a)) or `boundShares` (OQ-14 (b)) | Profit of a wrong proposal minus its bond | With (b), swing − bond ≤ τ. PASS. With (a) the same cell is measured for OQ-14 |
| T-31 | An insider forecaster in an oversubscribed window | Insider's certainty q in {0, 1}; honest forecasters 1 to 10; B_1 | Insider's take from the escrow; honest scale-down | Insider takes at most X (I-1); that is the purpose (spec). MATCHES-DISCLOSURE |
| T-39 | Exploit rounding for dust | Adversarial search over x, b, p at rounding extremes; 1 to 10^4 identities | Any operation that rounds against the contract; total dust against registration | Zero tolerance on direction; dust below the registration fee of the identities used. PASS |
| T-42 | The outcome is public before the last window | Schedule shapes (3 windows, 18 linear, 18 equal, 40,000 linear); window at which the news breaks | Leakage Σ B_t(1 − b_t)² over the late windows | Spec: 48.00 if rain is known before window 3 of the rain example. MATCHES-DISCLOSURE; the numbers go on the sponsor page (OQ-24) |
| T-44 | Squat a market's bounty | `minAllowance`, `maxFundingLead` from section 5; flows of 10, 100, 1,000 markets a day | Capital to squat a day's markets; X_min; blocked time | Spec: still possible at the minimum's price. MEASURED-AND-REPORTED; the curve picks the two limits |
| T-45 | Deny quorum by self-conflict | Juror stake shapes (equal 100 jurors, Zipf, one 30% holder); dust commits and small `addEscrow` per juror; `minCommitDeposit`, `minEscrowAdd` from section 5 | Cheapest conflicted stake that keeps every round below quorum; its price | Spec: open under OQ-29 (e). MEASURED-AND-REPORTED, with its price |
| T-46 | Withhold reveals until the timeout | Cartel share 10 to 60%; today's rules against OQ-29 (e) | Cartel's cost (slashed share of its weight) against the INVALID value it gains | Under (e), net ≤ τ whenever INVALID's value ≤ the slash (10% of the cartel's weight). Reports the break-even |
| T-48 | Hold up settlement with dust commits | K identities 1 to 10^4; windows 1 to 18; `minCommitDeposit` from section 5 | Forced `releaseUnfilled` calls; attacker's cost per forced call | Settlement delayed, never blocked; cost per forced call reported against a keeper's call cost |
| T-49 | A reorganization or delay near a phase end | Drop probability 0.1%, 1%, 5%; send margin 0 to 20 blocks; resends 0 to 3 | Honest miss rate | Miss rate with the agents' margin and resend ≤ the T-18 break-even. PASS at the chosen reveal phase |

**Rule sets for the resolution attacks.** T-29, T-45 and T-46 are run under both rule sets. The gate (G1) uses OQ-29 (e) as decided; the today's-rules results are MEASURED-AND-REPORTED, with the INVALID value each path buys.

**Not simulated** (Unit, Invariant, P5 or no check in spec 8.2): T-4, T-11, T-12, T-14, T-16, T-17, T-19, T-22 to T-25, T-27, T-32 to T-38, T-40, T-41, T-43, T-47. The model still runs I-1 to I-25 on every scenario, which covers the invariants those rows rely on.

## 4. LLM participants

### 4.1 What the spec requires

Spec 9.7: "LLM participants given the rules, the published numbers and a budget, and asked to find profitable strategies within the rules." The user approves the cost before they run. They run in the reference model only.

### 4.2 What a participant sees and can do

**Sees:**

- the rules as plain text: spec 4.2.3 to 4.2.9, 4.3 and 4.10, the stylised resolution rules of section 2.7, and the parameters of the cell (the text, not the model's source);
- the public information through read tools: the schedule; the baseline and its history; every commit as it is made (identity, window, x, δ, commitment hash); every reveal as it arrives (identity, raw and effective report); the window totals; the Q19 query for any drag; the fee rate; the sponsor list; its own commits, deposits and balances;
- its own state and its budget (shares at the start, identities it may register, the cost to register).

**Does not see:** the model's code, the vectors, the section 3 list, `criteria.json` or the pass rule, other participants' unrevealed reports and salts, their private signals, or the true outcome before the market ends. Withholding the attack list is deliberate: a search for new strategies should not be steered by the known ones.

**Tools** (a fixed set, each argument validated by a schema before it touches the model; the model's output is untrusted input):

- reads: `read_rules`, `get_published`, `get_my_state`, `quote_costs(drag)`, `preview_payout(window, request, band, report, hypothetical_outcome)` (a pure function of the published state and the participant's own inputs);
- actions: `register_identity`, `commit`, `reveal`, `release_unfilled`, `add_escrow` (sponsor role), `take_from_maker(side, shares)`, `propose_result` and `vote` (juror and resolver roles in the resolution scenarios), `wait_until(phase)`, `finish`.

No file, shell, network or code tool exists. The harness advances every scripted participant (honest forecasters, makers that follow the depth rule, a keeper) between a participant's turns.

**Roles per run:** a participant is one of: an informed forecaster with a private signal; a trader who may move the baseline and take from makers; a sponsor, who may also forecast and, in some runs, controls the source; a free attacker with up to 10 identities and a small starting balance. The objective given to every role is the same sentence: maximize your own final balance of shares, within the rules.

### 4.3 Budget, size, models, stop rule, logs

- **Per participant per run:** at most 60 model requests ("steps") and a per-request output cap (`max_tokens`) of 8,000 tokens.
- **Per run:** 4 participants (5 in the high-cost case of section 8), one cell of the world set (schedule shape, b₀, q, φ, population), the harness's seed.
- **Number of runs, by stage** (section 8's recommended plan): stage 0, 4 Sonnet runs (pilot); stage 1, 36 more Sonnet runs and 6 Haiku runs; stage 2, 12 Opus runs only after stage 1's report, on the cells where a candidate was found (if there are none, on the T-2 with T-21, T-13 and T-45 families). Cells rotate through the section 3 families so each of T-1 to T-49's mechanisms is exposed to at least 3 runs.
- **Models** (exact ids; prices in section 8): `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`; `claude-fable-5-2` only in the most expensive option. Settings used for every request: automatic tool choice (forced tool use is rejected on the 5.5 family), an explicit `effort` level (thinking cannot be switched off on Opus 5.5), prompt caching on the rules prefix, no server-side fallback (it would make the spend depend on a model the cap code did not price), and the run of a participant ends if a response stops with `refusal`.
- **Spend cap in code** (section 8.5): the runner refuses to start without `--cap-usd`, refuses a cap above the approved figure in `scripts/q13/llm/approval.json`, refuses prices older than 14 days, and reserves each request's worst-case cost before sending it (section 8.5). Each stage has its own cap within the approved total.
- **Stop rule:** a run ends when every participant has finished, or 60 steps, or the cap. A stage ends when its run list is done, its cap is reached, or 8 consecutive runs produce no candidate (a candidate is a participant whose reference-model excess over its role's benchmark, section 1.2, exceeds τ). The stage report says which rule stopped it.
- **Logs:** per run `tmp/q13/llm/<run id>/` holds `transcript.jsonl` (every request and response with the key and headers removed), `usage.jsonl` (the `usage` object of every response and the computed cost), `actions.json` (the validated action list per participant) and `result.json`. The reservations and the running total are kept in `tmp/q13/llm/spend.json`, written before each request is sent and after each response, so a crash cannot reset it. None of it is committed (`.gitignore:6`).
- **Key:** read from `ANTHROPIC_API_KEY` in the environment; missing key stops the run before any request. The key is never printed, logged or stored; a redaction function (modelled on `redact` in `examples/llm-agent/src/tools.ts:12`, rewritten in the harness because `scripts/` may not import an example) is applied to every log line, and a test feeds it a fake key and asserts it never appears in any log the runner writes.

### 4.4 From an LLM finding to a deterministic strategy

1. **Extract.** `actions.json` of a candidate becomes a literal action list with block times (an LLM strategy, "found strategy").
2. **Replay.** The model replays the full recorded action log of all participants. The profit must equal the one in the run's result exactly; if not, the candidate is a recording error and is dropped, with the reason logged.
3. **Minimize.** For minimization, the other LLM participants' actions are frozen as scripted opponents. Delta debugging removes actions and shrinks sizes while the excess stays above τ. The result is the smallest strategy that keeps the excess.
4. **Generalize.** The minimal strategy is swept over its sizes, reports and windows (±50% on a grid) and over the world set, so the report states where it works and where it stops.
5. **Judge.** The same verdict function as section 1.3 runs on the generalized cells, with the benchmark of the world it was found in.
6. **Record.** The result is a short written finding (the idea in words, the numbers, the cells) in the report, and the minimal strategy is committed as `scripts/q13/strategies/found/llm-<n>.ts`, a model-level action list that cannot run against a chain (section 9). The large transcript stays in `tmp/q13/`.

A candidate that ends PASS, MARGINAL-EXACT, MATCHES-DISCLOSURE or MEASURED-AND-REPORTED is reported as "found, harmless". A FAIL or BORDERLINE one fails G2 and goes to the user.

## 5. Parameter sweeps

Every parameter the spec's section 6 says is "set by simulation". Ranges and grids are in `criteria.json`; the picking rule is applied by code and the report shows the whole curve, not only the pick. Where a rule rests on a number the sources do not give, it is a working value from section 10 and the report marks it so.

| Parameter | Range and grid | Strategies and measures that bind it | Picking rule |
| --- | --- | --- | --- |
| `minEntryFeeWad`, `maxEntryFeeWad` (φ; OQ-2) | 0.005%, 0.01%, 0.02%, 0.05%, 0.1%, 0.2%, 0.5% | T-6 (pinning cost 9·φ·B), T-7 (rent turned into fees), small edges (an edge below √φ is not worth reporting: 1.4 points at 0.02%, 3.2 at 0.1%) | φmin: the smallest grid value at which T-6 passes and a pin costs at least 0.05% of B per window. φmax: the largest at which two honest forecasters at a 5-point edge keep at least 50% of the gross reward and √φ ≤ 5 points. Both must keep G1 true |
| `forecastCommitSeconds` (OQ-5) | 1, 2, 4, 8, 24 hours | Honest commit success against the reference agents' polling interval (read from their configuration in Task 7); T-20 | The smallest value giving at least 99.9% honest commit success at twice the slowest reference polling interval |
| `forecastRevealSeconds` (OQ-19) | 1, 3, 6, 12, 24, 48 hours | T-26, T-49, T-18; the working outage tolerance of SQ2 | The smallest value above the accepted outage by at least two agent resend intervals, with honest miss rate below one tenth of the T-18 break-even (4.8% at a 5-point edge); the cost of the longer phase (delay of the next window, capital held) is shown |
| `maxWindows` (OQ-3) | 3, 6, 12, 18, 24 | T-1, T-5, T-42, safe depth by T | The largest value at which G1 holds. This is the simulation's ceiling; gas can only lower it (the implementation plan sets the final value as the minimum of the two) |
| `minAllowanceStepBps` (OQ-3) | 0 (as written, one base unit), 10, 50, 100, 250, 500, 1,000 | T-2, T-3 (certain cost = (B_t − B_{t+1})·d² + fees) | The smallest step at which the safe depth at d = 10 points, φ = φmin and B_1 = `minAllowance` is at least 1% of B_1. Worked: 18 equal steps, B_1 = 1,000, φ = 0.02% give certain cost 0.94 and a safe depth of 14.3 shares, 1.4% of B_1; a 2% step gives certain cost 0.596 and 9 shares, 0.9%, below the rule |
| `minAllowance` (OQ-25 (c)) | 10, 100, 1,000, 10,000 shares | T-44 (capital to squat a day's markets, blocked time), T-45 | The SQ3 working floor (100 shares) unless the T-44 curve shows capital to squat 100 markets a day below 100 × the registration fee, in which case the report states the next grid value. User approval is required (a sybil limit, P5 R5) |
| `maxFundingLead` (OQ-25 (c)) | 1, 7, 30, 90 days | T-44 (blocked display time), honest sponsors' lead | The smallest value not below the SQ3 working lead (7 days). User approval required |
| `minEscrowAdd` (OQ-4 (c)) | 1, 10, 100 shares | T-45 (small `addEscrow` as self-conflict), T-14 style harvesting excluded by the spec | The smallest value at which the cheapest conflicted stake that denies quorum costs at least the registration fee of every conflicted juror times 10. User approval required |
| `minCommitDeposit` (OQ-26 (b)) | 0 (one base unit), 0.01, 0.1, 1, 10 shares | T-48 (cost per forced release), T-45, T-18 (honest dust forecasters lose more on a miss), T-20 | The smallest value at which the attacker's cost per forced `releaseUnfilled` is at least 10 × a keeper's cost per call, using the placeholder 0.01 share until the first Foundry gas report after implementation; the upper limit is 1% of the smallest supported honest request's deposit. User approval required |
| Credit: α, `n_min`, minimum filled exposure (OQ-10) | α in 1%, 5%, 10%; `n_min` in 10, 50, 200, 1,600; exposure in 0, 1, 10, 100 shares | T-9, T-10 (qualifying sybils and their cost), the cold-start length (the record's 1,600 questions) | Reported as curves; the values are set with the first experiment's data (OQ-10 (b)). The simulation supplies the sybil side |
| Credit: the long and short bucket boundary (OQ-10) | none | none | Not set here: it needs the first experiment's horizons (record 12.11). The report says so |

**The sweeps never pick a value that makes a strategy FAIL.** If no grid value passes G1 for a parameter, the report says so and the user decides.

## 6. Sponsor costs under burning (C-11, OQ-18)

**What is recomputed.** The proposals recorded the sponsor's expected cost under the earlier rule 7 as 608 for scenario A and 3,648 for scenario D (reopened-decisions proposals 2.6, from `reopen_cashflow.py`); the decided rule burns the net loss instead of returning it (record 12.6). The simulation recomputes the six scenarios of that script's section 1 (A to F: five rivals at a 5-point edge; the same without yield; four-point edge with more noise; private data with two sharing; one forecaster with a 100,000 escrow; a creator-funded bounty at the fee ceiling).

**The formula.** For outcome y, the sponsor gets back min(X, X + F + M + L_y − G_y), so its cost is X − that = max(0, G_y − L_y − F − M). The expected cost is Σ_y P(y) × that, with P(YES) = q.

Worked: the rain example at q = 85% (spec 4.2.8). At YES: G = 278.375, L = 0, F = 2.90, M = 0 → cost = max(0, 278.375 − 2.90) = 275.475 (the sponsor gets back 214.525 of its 490.00). At NO: cost = 0. Expected cost = 0.85 × 275.475 = 234.15 shares. The worst case is X = 490.00 (the sponsor never loses more, I-1).

**What is reported** for each scenario: the expected cost, the worst case X, the expected net to forecasters, the expected burn, the share of the sponsor's expected payment that reaches forecasters, and the same under the earlier rule for comparison (608 and 3,648 where the scenarios match). A second table gives the cost against the number of forecasters, the edge and φ. The sponsor page of spec 5.5 needs these numbers; the report gives them to the user as C-11 requires.

## 7. Measurements for the open questions

Each row says what is measured, with which strategies and sweeps, and what it decides or confirms.

| OQ | What is measured | Decision rule (fixed in `criteria.json`) |
| --- | --- | --- |
| OQ-14 (settling a market that is mostly bounty) | T-30 with bonds on `maxPayout` (a) and on `boundShares` (b): profit of a wrong proposal minus its bond, across `maxPayout` × bounty size | Confirms (b) if with (b) swing − bond ≤ τ everywhere and with (a) it exceeds τ somewhere. If (b) is not enough, the report gives the bond share that is |
| OQ-15 (stalling into INVALID) | T-13b, T-29, T-45, T-46: the rate of markets ending INVALID under each stall path, by cartel stake share (10 to 60%) and bond size; the value of INVALID to each party | Confirms (b) if larger bonds lower the stall rate of paths they can reach; the paths they cannot reach (a sponsor that controls the source, the juror paths) are reported as open with their price |
| OQ-16 (tying up bound capacity) | T-20: counted bound against cap_t; attacker's cost per unit blocked | Confirms (b) if the counted bound never exceeds cap_t and the attacker nets less than 0; the report gives the 40,000 against 80,000 comparison |
| OQ-19 (reveal phase against outages) | T-26, T-49: honest forfeits by outage length and reveal phase length | Sets `forecastRevealSeconds` by the rule of section 5 |
| OQ-20 (selective reveal) | T-21 with T-2: the depth at which profit crosses zero with the option divided by the published safe depth, f | Confirms (a) if f ≤ 1.2. If f > 1.2 the report states the inflated depth and asks the user to choose between publishing it, a shorter reveal phase or forfeiting the whole deposit (OQ-20 (b), (c)) |
| OQ-24 (windows after the outcome is public) | T-42: leakage by schedule shape and by the window at which the news breaks | Confirms (a) and gives the sponsor page its numbers; flags OQ-3's step if a standard shape leaks more than 50% of X when the news breaks before window 2 |
| OQ-29 (resolution incentives) | T-29, T-45, T-46: cost to force INVALID under today's rules, under (e), and the cost to flip an outcome | Confirms (e) if forcing INVALID under (e) costs at least as much as flipping; reports the residual T-45 path and its price either way |
| OQ-18 (sponsor cost) | Section 6 | Delivers C-11 |

## 8. Cost estimate

### 8.1 Local compute (no money)

- **Model, invariants, strategies and sweeps** run in one Node process on one core: no network, no service, USD 0. A rough size: random scenarios 10^6 × about 50 actions = 5 × 10^7 steps; sampled cells (at most a few dozen) up to 10^5 seeds; exact cells about 10^3 enumerated leaves each over about 1,000 cells; sweeps about 10^4 points. In all, about 10^9 model steps. At an assumed 10^4 to 10^5 steps a second for `BigInt` rationals with 25 invariant checks per action, that is hours to about a day for the full run. **These are estimates;** Task 3 measures the real rate with a benchmark test and Task 9 records the measured run times (not the machine). The sweeps parallelize with `worker_threads` if needed.
- **CI** runs 10^4 random scenarios and the vector tests per push, which take seconds to under a minute.

### 8.2 Prices (official, read on 2026-11-27)

Source: the Anthropic pricing page for the API (`platform.claude.com/docs/en/about-claude/pricing`), read on 2026-11-27. USD per million tokens. The runner re-reads nothing from the network; its price table carries the read date, and the runner refuses prices older than 14 days (so the table is re-checked before a run).

| Model | Input | Output | Cache read | Cache write (5 minutes) |
| --- | --- | --- | --- | --- |
| Haiku 5.5 (`claude-haiku-5-5`) | 0.10 (0.50 when the prompt exceeds 100K tokens) | 0.50 (2.50 over 100K) | 0.01 | 0.125 |
| Sonnet 5.5 (`claude-sonnet-5-5`) | 2 | 10 | 0.10 | 2.50 |
| Opus 5.5 (`claude-opus-5-5`) | 4 | 20 | 0.20 | 5 |
| Fable 5.2 (`claude-fable-5-2`) | 8 | 40 | 0.20 | 10 |

The batch interface halves these prices but suits no interactive loop (each step needs the previous step's result), so it is not used. Tool use adds 286 tokens to each request on the 5.5 models (counted as input).

### 8.3 LLM spend: the formula and the three cases

**Formula.** Cost of one run = participants × steps × per-request cost × (1 + retry overhead), plus the first request's cache write per participant. The per-request cost is: cache-read tokens × read price + cache-miss tokens × input (or write) price + new history tokens × write price + output tokens × output price. Per-request input is the cached rules prefix plus the average history; history grows each step by the step's output and tool results.

| Case | Participants | Steps each | Prefix tokens | Final history tokens | Output tokens per step | Cache miss | Retry overhead |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Low | 4 | 24 | 9,000 | 31,200 (24 × 1,300) | 1,000 | 0% | 5% |
| Expected | 4 | 42 | 11,000 | 126,000 (42 × 3,000) | 2,500 | 10% | 10% |
| High | 5 | 60 | 14,000 | 348,000 (60 × 5,800) | 5,000 | 30% | 20% |

On the 5.5 models thinking is preserved and passed back, so a step's output and its tool results (300, 500 and 800 tokens in the three cases) enter the history and are billed as input on every later request. Final history is therefore steps × (output + tool-result tokens per step). For Haiku 5.5 each request is priced on its own prompt length (prefix plus history, cache reads and writes included): a request over 100K tokens pays the long-prompt rates (input 0.50, write 0.625, read 0.05, output 2.50). In the expected case that is the last 13 of 42 requests; in the high case, the last 45 of 60. No other model has a long-prompt rate.

Worked, Sonnet 5.5, expected case: 4 × 42 = 168 requests. Mean history 63,000, so mean input 74,000 tokens; new history per request 3,000. Per request: cache reads 0.9 × 71,000 × 0.10 ÷ 10^6 = 0.0064; misses 0.1 × 74,000 × 2.50 ÷ 10^6 = 0.0185; new history 3,000 × 2.50 ÷ 10^6 = 0.0075; output 2,500 × 10 ÷ 10^6 = 0.0250; total 0.0574. × 168 = 9.64; plus 4 prefix writes of 11,000 tokens at 2.50 = 0.11; = 9.75; × 1.10 retries = **10.73 USD per run**.

**These are assumptions.** Stage 0 (the pilot) exists to replace them with measured token counts; the later stages are projected from the pilot (section 8.5).

**Per run, USD (4 or 5 participants, one world):**

| Model | Low | Expected | High |
| --- | --- | --- | --- |
| Haiku 5.5 | 0.09 | 1.47 | 18.73 |
| Sonnet 5.5 | 1.66 | 10.73 | 78.78 |
| Opus 5.5 | 3.33 | 21.45 | 157.56 |
| Fable 5.2 | 6.19 | 40.54 | 305.94 |

### 8.4 Options, with totals

Triage (one reading of a transcript by a model, to name the idea in a paragraph) is 60,000 input and 4,000 output tokens each: 0.16 USD on Sonnet, 0.32 on Opus, 0.64 on Fable. Totals include triage of 10 transcripts, scaled with the case (half in low, double in high): by Sonnet in H and A, by Opus in B, and in C 20 by Opus and 10 by Fable.

| Option | Runs | Low | Expected | High |
| --- | --- | --- | --- | --- |
| H. Haiku only | 40 Haiku | 4.6 | 60.5 | 752.5 |
| A. Sonnet only | 40 Sonnet | 67.4 | 430.7 | 3,154.5 |
| B. Mixed (recommended) | 6 Haiku, 40 Sonnet, 12 Opus | 108.7 | 698.5 | 5,160.8 |
| C. Stronger | 80 Sonnet, 40 Opus, 10 Fable | 334.7 | 2,134.5 | 15,690.1 |

Option H's high figure is mostly Haiku's long-prompt rate. Option B by stage, expected case (low and high in brackets): stage 0, 4 Sonnet runs, 42.9 (6.6; 315.1); stage 1, 36 Sonnet and 6 Haiku runs, 395.0 (60.3; 2,949); stage 2, 12 Opus runs and 10 Opus triages, 260.6 (41.6; 1,897). The per-stage caps are 60, 500 and 340 USD, 900 in all.

What the cheaper and the stronger choices buy: Haiku runs cost almost nothing and show whether the tool set and the prompt work, but a weak model is likely to miss multi-window plans; Sonnet is the working model; Opus adds depth on the cells where Sonnet found a candidate; Fable is about twice Opus and is worth it only if the cheaper tiers found nothing and the user wants more search before accepting a pass.

### 8.5 The hard cap

- **Enforced in code**, in `scripts/q13/llm/budget.ts`, so that spend is bounded and not only checked:
  - Before each request, the budget *reserves* worstCase = counted input (from `messages.countTokens`, or a character-based upper bound) at the uncached input price + `max_tokens` × the output price. It persists the reservation in `spend.json` before the request is sent, and refuses the request if spent + reserved + worstCase would exceed the stage cap or the total cap. Prices are chosen per request: when the counted input exceeds a model's long-prompt threshold (Haiku 5.5: 100,000 tokens), the reservation and the settlement use that tier's input, cache and output prices for the whole request.
  - The response's `usage` settles the reservation. A request with no `usage` (a timeout or a network error) is charged at its full reservation.
  - The client is built with `maxRetries: 0`, so the SDK never retries behind the budget. The runner retries itself, and each retry passes the budget check.
  - Requests are serialized through one budget lock; there are no parallel runs unless each one reserves through the same lock.
  - `spend.json` is read at start-up. If it is missing while the progress document's ledger is not zero, the run stops.
- The runner has no default cap: `--cap-usd` is required, and it fails if the number exceeds `approvedCapUsd` in `scripts/q13/llm/approval.json`, a file created only after SQ1 is answered; the file also holds each stage's cap. A second cap, set at the account level by the user in the provider's console, is the backstop; the plan asks for it in SQ1.
- **Stage projection.** After the pilot, the runner projects each later stage's cost from the pilot's measured token counts, priced at the stage's model. If a projection exceeds its stage cap, the runner stops and the user is asked again before that stage runs. The first run of the Opus stage is projected the same way before the rest of the stage proceeds.
- **What the caps do in the high case.** Option B's high estimate (5,161) is far above the total cap of 900, and a single high-case Sonnet run (78.78) is above the pilot's cap of 60, so the pilot's reservations stop it inside its first run. That stop is the signal: the runner halts, the report marks LLM coverage as incomplete, and the user chooses between accepting that and raising the cap. Nothing runs fewer runs silently.

## 9. Safety and scope

- **Offline, against the model only.** The model performs no I/O. The harness reads and writes only inside the repository and `tmp/q13/`. No chain, RPC endpoint, wallet or deployed contract is touched. Tests enforce it: `packages/mechanism-model` and `scripts/q13/` (except `scripts/q13/llm/`) import none of `viem`, `ethers`, `node:net`, `node:http`, `node:https` or `node:dgram`, and use none of the identifiers `fetch`, `globalThis.fetch`, `WebSocket` or `XMLHttpRequest` (`fetch` is a global, so an import scan alone cannot catch it); only `scripts/q13/llm/` imports `@anthropic-ai/sdk`.
- **No LLM or paid service before approval.** Task 10 begins by reading the approval file and the user's answer to SQ1 in the decision log; with neither, it does not start.
- **LLM output is untrusted data.** It is validated against schemas before it reaches the model, it can only call the fixed tools, and it is never executed or interpreted as code.
- **Findings stay defensive.** A profitable or borderline strategy becomes, after the implementation exists, a minimal failing Foundry test in the contracts' suite (spec 9.7, 9.4; P5 section 14), not a replay of the attack against deployed contracts, and no standalone exploit tool is built. The committed "found strategy" files are action lists for the model, written as test inputs; they cannot run against a chain.
- **Testnet is not a sybil test** (spec 9.7): the faucet gives every address bUSD and juror tokens each day (`contracts/src/protocol/BlinkFaucet.sol:13–15`), so registration fees and stakes cost nothing there. The sybil limits are priced in this simulation, not on testnet.
- **Third-party material** (the vault surveys) is read only; the simulation has no vault code beyond the stylised share price.

## 10. Open questions for the user

Only what the sources leave open. The recommendation of each is worded so that "yes" accepts it.

### SQ1. The LLM budget

The spec requires LLM participants and says the user approves their cost before they run (9.7). Section 8 gives the numbers.

- (a) **No LLM runs.** Cost: nothing. The simulation then does not meet spec 9.7's decision, and G2 cannot be shown.
- (b) **Option A:** 40 Sonnet runs. Expected 431 USD (low 67, high 3,155).
- (c) **Option B, staged** (6 Haiku, 40 Sonnet, 12 Opus). Expected 699 USD (low 109, high 5,161). Stage 0 is a 4-run Sonnet pilot with its own cap of 60 USD; stage 1 (36 Sonnet and 6 Haiku runs) has a cap of 500 USD; stage 2 (12 Opus runs, and only after stage 1's report) has a cap of 340 USD.
- (d) **Option C:** the strongest. Expected 2,135 USD (low 335, high 15,690).

**Recommendation: (c), with the stage caps 60, 500 and 340 USD (900 USD for all LLM calls together).** The cap is about 1.3 times the expected cost: it absorbs a modest overrun but not the high case. The token counts behind the estimate are assumptions, and the pilot replaces them with measurements. After the pilot, the runner projects each later stage from the measured usage and stops for your approval again if a stage would exceed its cap. The Opus stage runs only after stage 1's report, on the cells where cheaper models found a candidate. Saying yes also means: the user provides the key in the environment when the stage starts, and sets a matching spend limit in the provider's console. The cap in force is the one written in `scripts/q13/llm/approval.json`; prices are re-read from the official page on the day of the run.

### SQ2. The working outage tolerance for the reveal phase (OQ-19)

OQ-19 (a) says the reveal phase must be longer than the longest outage the project accepts, "set from the chosen chain's outage history", and the chain is not chosen yet.

- (a) 1 hour. Cost: a short phase; one longer outage costs every honest forecaster its deposit on the filled part.
- (b) **6 hours.** Cost: the next window cannot start until the longer phase ends, and capital stays locked longer.
- (c) 24 hours. Cost: much longer windows and locks.

**Recommendation: (b), as a working value for the simulation only.** The sweep reports the curve for all three, and the deployed value is set from the chosen chain's history before deployment.

### SQ3. The smallest sponsor and the longest funding lead the project supports (OQ-25 (c))

The two limits `minAllowance` and `maxFundingLead` need a floor and a lead from the product side, which the sources do not give.

- Smallest first allowance B_1: (a) 10 shares; (b) **100 shares**; (c) 1,000 shares. A lower floor admits small sponsors and makes squatting cheaper; a higher one excludes them.
- Longest lead between funding and window 1: (a) 1 day; (b) **7 days**; (c) 30 days. A shorter lead hides the market's number for less time; a longer one lets sponsors plan further ahead.

**Recommendation: 100 shares (one `creditUnit`, 100 bUSD, `packages/schemas/src/protocol-params.ts:123`) and 7 days, as working values.** The sweep prices squatting at each and reports if the working value is too cheap to squat. The user still approves the final limits (they are sybil limits, P5 R5).

### SQ4. The pass thresholds and the borderline policy

Section 1 fixes them; "Mechanism R enters only after it passes" makes them a user decision.

- (a) **As written:** τ = max(1% of the strategy's published cost, 10^-5 × B_1); for sampled cells τ_s = max(τ, 10^-4 × B_1), ten times looser (4 shares at B_1 = 40,000); 10^5 seeds at most; 99% family-wise confidence; a borderline counts as FAIL for the gate. Cost: a strategy that earns a few shares more than the benchmark can hold up the gate even if it is harmless in practice, and a sampled cell can hide an edge up to τ_s.
- (b) Looser: τ = max(5%, 10^-4 × B_1). Cost: a small systematic edge passes; for a 40,000-share allowance that is 4 shares.
- (c) Stricter: τ = max(0.1%, 10^-6 × B_1). Cost: more cells sampled and borderline; more seeds; the exact cells are unaffected.

**Recommendation: (a).**

### SQ5. Does a source controller's gain from forecasting reopen the Q23 (c) creation-challenge ground?

**The gap.** Record 12.6 item 1 withdrew the Q23 (c) ground, "a bountied question's settlement source must not be controlled by a single private party", on the premise that a controller can at most keep its own escrow. The user had also objected that checking each question would bring back a human or a central authority. T-13a's calculation shows the premise is incomplete. A controller that also forecasts, from any identity, recovers honest forecasters' losses that burning would otherwise destroy.

Worked, the rain example's first window with φ = 0.1% and X = 490: A (40%) and B (35%) each request 1,000 at b₀ = 30%, so b = 37.5%. In window 2 a sponsor identity S′ requests 600 at 20%, and the sponsor then publishes NO. A and B lose 51.25 and pay 2.00 in fees; the sponsor and S′ together net +53.25 (refund 483.475 − X 490 + own payout 60.375 − own fee 0.60). An outsider with the same control and report nets +59.775. So the sponsor role itself adds −6.525; the gain is the insider's, not the mechanism's (T-31's case). At YES the same plan nets −150.225. The gain is bounded by the controller's own filled gain: at most B_t × b_t² a window if it then publishes NO, and B_t × (1 − b_t)² if YES (the filled exposure of all its identities together is at most B_t). In window 2 at NO that is at most 600 × 0.375² = 84.375; the coalition's net, min(G_own, F + M + L) − fee, is at most that, and over several windows the bounds add. The refund to a sponsor never exceeds its X_j (I-1).

- (a) **Disclose only.** The sponsor page and the market page state that whoever controls the source can profit by forecasting, and `sponsorsOf` lists the sponsors (spec 4.10). Cost: honest forecasters can lose to a controller who also forecasts, as A and B do above, and a second identity (10 shares to register, T-8) is not visible in `sponsorsOf`.
- (b) **Reinstate the Q23 (c) ground.** A creation challenge can be made when a single private party controls the settlement source. Cost: the check that the user objected to returns (someone must judge "control" per question), and it does not stop a controller that forecasts from an identity unrelated to its sponsor address.
- (c) **Drop Mechanism R** from the generation. Cost: the generation has no forecast bounty.

A rule that bars a sponsor from forecasting on its own bounty is not offered: spec 4.10 has no identity rules, and it could not be enforced against a second identity.

**Recommendation: (a).** The simulation still measures the gain in every T-13a cell and reports it (section 3); the answer can be changed after the numbers are in.

## 11. Pre-flight rulings (the controller records these in the decision log before Task 1)

1. **Model location.** Section 2.1, option A. The controller records the user's agreement or a change (this is not a numbered question because the spec delegates the choice to this plan).
2. **Isolation.** `@blink/mechanism-model` is imported by no `apps/*` or service code; the web and service rows of the Definition of Done do not apply; `pnpm check` is the covering command (CI job `check`).
3. **The package is added to the boundary map** (`scripts/check-boundaries.mjs:4`) with an empty dependency list. `tests/architecture.test.ts` scans every `packages/*/src` (lines 129 and 191). It rejects the identifiers or string literals `BASELINE`, `FORECASTER_A` and `FORECASTER_B` (`:149`), and module paths or specifiers containing `keeper`, `trader`, `faucet` or `signer` (`:94`). The package's file names, imports and identifiers avoid all of them (it uses other names), and Task 1's brief states the bans.
4. **The review scripts exist in the repository** (`docs/superpowers/specs/2026-11-17-long-horizon-review/scripts/`, eight Python files, 1,045 lines). The plan uses them only as the source of the first vectors. They are not edited.
5. **A calculation to reproduce first (T-13a).** With the rain example's first window (A at 40% and B at 35%, each requesting 1,000, allowance 1,000, φ = 0.1%, X = 490), a sponsor identity S′ that requests 600 at 20% in window 2 (baseline 37.5%, allowance 600) nets at NO: refund 483.475 − X 490 + own payout 60.375 − fee 0.60 = +53.25, at YES −150.225. An outsider with the same report and control nets +59.775 at NO and −150.225 at YES. S′'s gain of 60.375 is paid from A's and B's losses (51.25), all fees (2.60) and 6.525 of the sponsor's own escrow; the coalition's net is A's and B's losses plus their fees (51.25 + 2.00 = 53.25). In general the coalition's net is min(G_own, F + M + L) − own fee, and an outsider's is G_own − own fee. The sponsor role adds −6.525 against an outsider with the same control. The finding goes to the user as a correction of record 12.6 item 1's premise (SQ5), not as a Mechanism R FAIL. A rule barring sponsors from forecasting is not offered: spec 4.10 has no identity rules. This is a recomputation with the review script's formulas; Task 2's vector test must reproduce all four numbers (+53.25, −150.225, +59.775, −6.525) before the plan relies on them.
6. **The decision log** (the controller's own record, outside the tracked files) holds the answers to SQ1 to SQ5, each task's state and each review result.

## 12. Tasks

### Checkpoint procedure (the last step of every task)

Same as the direction-1 plan's: run the task's verification and the review, the controller reads the diff, updates `docs/Q13_SIMULATION_PROGRESS.md` (scope done, results, remaining limits; it never labels the whole milestone complete), commits with a descriptive message, pushes to `main`, and confirms the commit hash and the push. Large artifacts are never committed. Where a task creates results, they are summarized in the progress document and the tables go to `docs/superpowers/specs/<date>-q13-simulation-results/` (small CSV or Markdown tables, at most about 100 KB each).

### Task 1: The package, the arithmetic and the guards

**Files:** create `packages/mechanism-model/package.json`, `src/index.ts`, `src/arith.ts`, `src/rational.ts`; `tests/mechanism-model-arith.test.ts`, `tests/mechanism-model-isolation.test.ts`; edit `scripts/check-boundaries.mjs`, root `package.json` (scripts `q13:*` added by later tasks), `tsconfig.json` only if the include does not already cover the package (it covers `packages/*/src/**/*.ts`, `tsconfig.json:18`).

- [ ] Write failing tests: `mulDiv` Floor and Ceil on edge values (0, 1, 2^96, 2^255), an overflow throwing `Overflow`; `Rational` normalization, addition, multiplication, comparison; the isolation test (no app or service imports the package; no forbidden network or chain import under the model and harness paths; the vault port has no `deposit`, `mint`, `withdraw`, `redeem` keys; the forbidden identifiers of section 9; a scan of the package for the names `tests/architecture.test.ts` bans, listed in section 11 ruling 3). Brief: state those bans to the implementer.
- [ ] Implement `arith.ts` and `rational.ts`; add the boundary entry.
- **Verify:** `node --import tsx --test tests/mechanism-model-arith.test.ts tests/mechanism-model-isolation.test.ts`, `pnpm typecheck`, `pnpm check:boundaries`, then `pnpm check`. **CI job:** check.

### Task 2: The bounty engine, the exact engine and the first vectors

**Files:** `packages/mechanism-model/src/bounty.ts` (integer engine), `exact.ts`, `events.ts`, `errors.ts`, `vectors/*.json`; `tests/mechanism-model-vectors.test.ts`, `tests/mechanism-model-bounty.test.ts`; a one-off script `scripts/q13/make-vectors.sh` is not committed; the vector JSON records the script name and blob hash.

- [ ] Produce the vector JSON from `worked_example.py` and `reconfirmed_examples.py` with `python3 -I`; write the failing tests that assert every number of section 2.5 and the four T-13a numbers of section 11 (ruling 5).
- [ ] Implement `openBounty`, `addEscrow`, `commit`, `reveal`, `closeWindow`, `releaseUnfilled`, `settle`, `claim`, `sweep` (spec 4.2.3 to 4.2.9) in both engines; the shadow check of section 2.3.
- **Verify:** the two test files, `pnpm typecheck`, `pnpm check`. **CI job:** check. A reviewer other than the implementer checks every rounding direction against spec 4.0 and 4.2.

### Task 3: The invariant checker, the scenario generator and the benchmark

**Files:** `packages/mechanism-model/src/invariants.ts`, `scripts/q13/scenarios.ts`, `scripts/q13/prng.ts`, `scripts/q13/run-invariants.ts`; `tests/mechanism-model-invariants.test.ts`, `tests/q13-scenarios.test.ts`.

- [ ] Failing tests: each invariant is violated by a hand-built bad state and caught (one test per I-n); the generator reaches every coverage-floor branch within 10^4 scenarios; a seeded run is reproducible.
- [ ] Implement the checker, the generator and `pnpm q13:invariants` (count and seed arguments); a benchmark test records steps per second.
- [ ] The trajectory-drift bound (section 2.3) is derived and written in the progress document for the reviewer.
- **Verify:** the test files; `pnpm q13:invariants -- --scenarios 10000 --seed 1`; then, as a controller run recorded with its seed, count and elapsed time, `--scenarios 1000000`. `pnpm check`. **CI job:** check (the 10^4 run); the 10^6 run is recorded, not in CI.

### Task 4: The stylised neighbours

**Files:** `packages/mechanism-model/src/bound.ts`, `maker.ts`, `resolution.ts`, `credit.ts`, `q19.ts`; `tests/mechanism-model-bound.test.ts`, `-maker.test.ts`, `-resolution.test.ts`, `-credit.test.ts`, `-q19.test.ts`.

- [ ] Failing tests: round 3 (certain cost 0.94, contested 10.20, safe depth 14.3, +8.0, +31.9), round 5 (price 1.0816, 616.51, 80/40/0), the window cap example (40,000 against 80,000), the quorum rounds and the slash of section 2.7, and the credit score example (0.13 and −0.07).
- [ ] Implement the layers; each file's header says "stylised" and cites the spec section it copies.
- **Verify:** the five test files, `pnpm typecheck`, `pnpm check`. **CI job:** check.

### Task 5: The criteria, the verdict function and the harness

**Files:** `scripts/q13/criteria.json`, `criteria-amendments.json` (empty list), `scripts/q13/verdict.ts`, `stats.ts`, `report.ts`; `tests/q13-criteria.test.ts`, `tests/q13-verdict.test.ts`, `tests/q13-stats.test.ts`.

- [ ] Failing tests: the hash test of section 1.5; the verdict function on synthetic cells for each class (exact excess −1, +0.5 with τ = 0.72, +0.9; a disclosed cell at 100%, 103%, 107% of its number; a sampled cell whose interval straddles τ); the Student's t function against known table values; batch means on a known series; the staged ladder stops a cell at PASS or FAIL.
- [ ] Write `criteria.json` from sections 1 and 5 and 3 (strategy list, expected class, disclosed numbers with sources).
- **Verify:** the three test files, `pnpm check`. **CI job:** check. The controller records the commit hash of `criteria.json` before Task 6 starts.

### Task 6: The scripted strategies (four implementers in parallel, one worktree each)

**Files:** `scripts/q13/strategies/t-<n>.ts` for the 27 rows; `tests/q13-strategies-<group>.test.ts`. Groups: (1) T-1, T-2, T-3, T-5, T-6, T-7, T-8, T-21, T-42; (2) T-13a, T-13b, T-15, T-31, T-39; (3) T-9, T-10, T-18, T-26, T-49; (4) T-20, T-28, T-29, T-30, T-44, T-45, T-46, T-48.

- [ ] Per strategy, a failing test: the model reproduces the spec's number for that row (section 3's "spec" figures), then the verdict function gives the expected class. Strategies may not contain a threshold; they return profits and let `verdict.ts` decide.
- [ ] Implement each strategy over the model; zero tolerance on T-39 and on the cap in T-20.
- **Verify:** the group's test file, `pnpm typecheck`, `pnpm check` (after merging all four groups). **CI job:** check.

### Task 7: The sweeps and the OQ measurements

**Files:** `scripts/q13/sweeps.ts`, `scripts/q13/oq-measurements.ts`, `scripts/q13/sponsor-cost.ts`; `tests/q13-sweeps.test.ts`, `tests/q13-sponsor-cost.test.ts`.

- [ ] Failing tests: the picking rules of section 5 on small synthetic curves (including the 14.3-share and 9-share safe-depth example); the sponsor-cost formula against the rain example (275.475 at YES, 0 at NO, expected 234.15 at q = 85%) and against the scenarios A and D of `reopen_cashflow.py` as the comparison column.
- [ ] Implement the sweeps, the OQ measurement procedures of section 7 and the sponsor-cost report. Read the reference agents' polling interval for the commit-phase rule from their configuration and record the value found.
- **Verify:** the test files, `pnpm check`. **CI job:** check.

### Task 8: The LLM runner, offline

**Files:** `scripts/q13/llm/runner.ts`, `tools.ts`, `schemas.ts`, `budget.ts`, `prices.json`, `redact.ts`, `extract.ts` (candidate to strategy, replay, minimize, generalize); `tests/q13-llm-budget.test.ts`, `-tools.test.ts`, `-redact.test.ts`, `-extract.test.ts`. Root `package.json` gains `@anthropic-ai/sdk` 1.3.0 as a dev dependency.

- [ ] Failing tests, all against a fake transport that returns canned responses with `usage` objects (no network, no key): the budget stops a run before a request whose worst case would pass the cap; spend is computed from `usage` with cache read and write prices; the cap above the approved figure and prices older than 14 days are refused; the missing key stops the run; a fake key never appears in any log; a `refusal` ends only that participant; concurrent reservations cannot together exceed the cap; a request that times out is charged at its full reservation; the runner's own retries are counted; the client is built with `maxRetries: 0`; a Haiku request with 100,001 counted input tokens is reserved and settled at the long-prompt prices, and one with 100,000 at the standard prices; each tool rejects malformed arguments; the extraction pipeline turns a canned winning action list into a minimal strategy and replays it to the same profit.
- [ ] Implement the runner with the settings of section 4.3.
- **Verify:** the four test files, `pnpm typecheck`, `pnpm check`. **CI job:** check. The task makes no API call.

### Task 9: The scripted run and the first report

**Files:** `scripts/q13/run-all.ts`; results under `docs/superpowers/specs/<date>-q13-simulation-results/`; `docs/Q13_SIMULATION_PROGRESS.md`.

- [ ] Run every scripted strategy over its grid (exact cells first, then the seed ladder), the sweeps, the sponsor-cost report and `pnpm q13:invariants` at 10^6; write the tables and a first report: the verdict of each of the 27 strategies, the chosen parameters with their curves, the section 6 and 7 outputs, the amendments (none expected), and the run times.
- **Verify:** the report's numbers match `tmp/q13/` outputs; `criteriaSha256` in every results file equals the committed hash; `pnpm check`. **CI job:** check. This is the first moment the controller can report G1, G3, G4 (scripted part) and G5 to the user.

### Task 10: The LLM stages (starts only after SQ1 is answered and `approval.json` exists)

**Files:** `scripts/q13/llm/approval.json`; `scripts/q13/strategies/found/llm-<n>.ts`; results tables; the progress document.

- [ ] Stage 0: the pilot (cap 60 USD), then the controller reports real cost per run and the projection of each later stage. Stop and ask if a projection exceeds its stage cap (section 8.5).
- [ ] Stage 1, then stage 2 after stage 1's report; each stage stops by its stop rule (section 4.3).
- [ ] Run the extraction pipeline on every candidate; judge with `verdict.ts`; write the findings.
- **Verify:** the stage reports state the spend from `spend.json`, the stop rule that applied and the runs finished; no key or transcript is committed (`git status` shows only `scripts/q13/strategies/found/`, the results tables and the docs); `pnpm check`. **CI job:** check.

### Task 11: The final report and the gate

**Files:** the results record `docs/superpowers/specs/<date>-q13-attack-simulation-results.md`; the progress document; [the roadmap](../../ROADMAP.md) "Next steps" line for the next generation.

- [ ] The report states, for the user: G1 to G5 each met or not; every FAIL and BORDERLINE with the strategy in words and the number; the parameters proposed, with the sybil limits marked "needs your approval"; the sponsor costs; the seven measurements and what each decides; the LLM coverage and spend; every amendment; the limits ("LLM stage ran N of M planned runs; the 10^6 random run was a controller run, not CI").
- [ ] Update the roadmap line with the real state, without labelling the milestone complete unless the user has accepted the gate.
- **Verify:** every figure in the report appears in a committed table; the links resolve; the files are English. **CI job:** none for docs-only changes (`paths-ignore`); the commit that touches code in earlier tasks was green.

## Execution waves

- **Wave 1:** Task 1, then Task 2 (the engine depends on the arithmetic).
- **Wave 2:** Task 3 and Task 4 in parallel (both read Task 2's state types); Task 5 in parallel with them (criteria and verdicts do not depend on the model).
- **Wave 3:** Task 6's four groups in parallel, after Tasks 4 and 5; Task 7 after Task 6; Task 8 in parallel with Tasks 6 and 7 (it is offline and depends only on the model's action interface).
- **Wave 4:** Task 9.
- **Wave 5:** Task 10, after SQ1; then Task 11.

Tasks 1 to 9 need no user input beyond the answers to SQ2 to SQ4; SQ5 needs an answer before the Task 9 report is final, and does not block any task. If the user has not answered SQ1 when Task 9 finishes, the controller delivers the scripted report and waits.

## Out of scope

- The Foundry differential tests and the contracts themselves (the implementation plan); the vector directory and `fs_permissions` they need.
- Deployment, signing, broadcasting, and any paid service other than the approved LLM stage.
- P5 (it runs after the implementation; spec 9.8) and external audit work.
- The rows of spec 8.2 marked Unit, Invariant, P5 or no check.
- The first experiment (Q21, Q12) and the bucket boundary of OQ-10.
- Gas costs (they need the contracts); the plan records call counts instead.
- Website copy.

## Self-review notes

- **Brief and spec checked against each other.** The 27 rows of section 3 are exactly the rows of spec 8.2 marked Simulation or Both (T-1, T-2, T-3, T-5 to T-10, T-13a, T-13b, T-15, T-18, T-20, T-21, T-26, T-28 to T-31, T-39, T-42, T-44 to T-46, T-48, T-49). The ten "set by simulation" values of spec 6 and the OQ-10 credit parameters are all in section 5. The seven measurements of spec 9.7 are in section 7.
- **A finding to reproduce before relying on it:** the T-13a coalition numbers (section 11, ruling 5). They are a recomputation; Task 2 must reproduce them. The finding is not a Mechanism R FAIL; it corrects the premise of record 12.6 item 1 and goes to the user as SQ5.
- **Sources that disagree or leave a gap:**
  - Spec 8.2 T-13a states the sponsor's outcome as "at most keeps its own escrow"; the calculation says a controller's own forecaster payout is a second channel (SQ5).
  - No source gives a trajectory bound between the exact and the integer engines (only per-operation and residue bounds); Task 3 derives one and a reviewer checks it.
  - No source gives the sponsor population, juror stake distribution, polling interval of the reference agents, or the outage history of the chosen chain; the plan uses stated working values (SQ2, SQ3) and scenario families, and marks every result that depends on them.
  - The task brief said the review scripts might not be in the repository; they are, and the plan reads them.
- **Rules proposed by this plan, not by the spec** (all in `criteria.json`, all open to the user through SQ4): τ and τ_s, the seed ladder, the confidence level, the classes MARGINAL-EXACT, MATCHES-DISCLOSURE and MEASURED-AND-REPORTED, the picking rules of section 5, the f ≤ 1.2 and 50% thresholds of section 7. The LLM token counts in section 8.3 are assumptions that the pilot replaces.
- **Prices and model behaviour** in sections 4 and 8 were read from the official pricing page and the SDK guidance on 2026-11-27; the runner's price table carries that date and refuses to run on prices older than 14 days.
