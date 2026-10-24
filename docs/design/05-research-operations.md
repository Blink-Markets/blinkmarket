# 05 — Research, Budget and Operations Detailed Design

_Status: historical — v0.1 team-operated design baseline (2026-09-22), largely retired by the autonomous-market redesign of 2026-10-23 (§6). Current design: docs/superpowers/specs/2026-10-23-autonomous-market-design.md._

Tasks 2/3/7/10/11/12/13 implemented durable jobs/budgets, allowlisted evidence fetch, forecast windows, discovery/forecaster/baseline workers, resolution, evaluation, keeper and faucet. See the [delivery index](../ROADMAP.md). The model is only a deterministic REPLAY fixture gateway, with no paid provider. LIVE approval is still rejected. The [internal trader](../M3_INTERNAL_TRADER.md), the [local Alpha harness](../M5_LOCAL_ALPHA.md) and [health/metrics readiness](../M5_HEALTH_METRICS.md) are delivered. HTML/PDF extraction, notification delivery and real sources are still to be done. The text below is the design baseline. Differences are defined by the delivery records.

## Evidence and sources

Source configuration stores the company, the official host/path allowlist, the allowed mime types, the policy version and the schedule. An external candidate can only reference an evidenceId that the platform already has. The fetcher accepts only a sourceId and does not let the LLM pass an arbitrary URL.

Every request and redirect re-verifies scheme=https, host/path and the resolved IP. Loopback/private/link-local/metadata addresses are rejected. The connection goes to the verified IP and checks the TLS hostname, to avoid DNS rebinding. At most 3 redirects, 15 seconds per request, 60 seconds in total, and a 10MiB limit after decompression. These are initial engineering limits. Anything over the limit goes to the manual queue, and truncated content is never passed off as complete evidence.

Store the original bytes, keccak256, URL, observedAt, publishedAt (nullable), mime/size and accessPolicy. Extracted PDF/HTML text is a separate derived object, with the parser version and the parent hash. Any instruction inside a document is untrusted text. It cannot add a tool, read a secret or authorize the signer.

Spec objects use content-addressed put-if-absent and read back to confirm the hash. The same holds for original documents/evidence. The bucket being private, versioned and its retention policy are checked at deployment acceptance. A UUID file name is not used to claim it cannot be overwritten.

## Discovery and review

At most two scans per day and at most 10 new candidates per day. A UTC day row lock prevents multiple workers from exceeding this. After a fetch succeeds and evidence is created, first reserve the model cost, then output a structured candidate. A schema error is retried at most once, and the retry also needs budget. A failure goes to the manual queue.

The GM validator is split into:
- structural: company / quarter / GAAP / single quarter / LT / threshold / source / time fields.
- evidence: the citation exists and is usable for the current mode/cutoff, and the located text supports the variable.
- eligibility: canonical key / one traded market per company and quarter / LIVE capacity / official schedule and a 24h buffer.
- human: the admin checks the original text, the first-publication basis, data rights, the budget and the schedule.

DRAFT→VALIDATING→NEEDS_REVISION/REJECTED/APPROVED. Validation stores the rule version/report and does not overwrite the revision. An approval result freezes the spec and produces a manual ADMIN pending-signature intent. The worker monitors the receipt. APPROVED does not mean the ADMIN key is signed automatically.

If an announcement is found to be early: the database closes that market's quote gate immediately and alerts the ADMIN to pause. Because ADMIN uses a manual wallet, an on-chain pause is not an instant guarantee, and an already signed quote may fill before it expires. The publication / detection / quote stop / pause times are kept, the market settles under the original rules, and orders are not changed retroactively. This is an explicit operational limit of v0.1. It must not be claimed that an automatic on-chain pause exists.

## Forecast windows and publication

DAILY: every 00:00 UTC, the window opens 30 minutes before. PRE_CLOSE: closeAt-1 hour, also opened for 30 minutes. The window scheduledAt must be earlier than closeAt. After a market is created, only windows not yet missed are created, with no backfill. If the two horizons coincide exactly, they are still different windows, but evaluation does not count them as two independent events.

The job input fixes the market / specHash / window / dataCutoff, the evidence manifest, the model ID, the prompt hash and the sampling/tool policy. The two internal forecasters and the baseline each have independent runs. They must not read other answers for the same window. Publication is after the close.

After the LLM finishes generating, the window is checked against the DB receipt time. A late result is not accepted just because "the start time was inside the window". No submission, late, withdrawn and known outcome each keep an independent state. A forecast must not be overwritten.

If one platform model is missing, no two-model ensemble is produced, and the baseline does not fill in. If the answer was public before submission, mark it OUTCOME_ALREADY_PUBLIC. A comparison within the same window is marked as contaminated, and not just the underperforming model is removed. REPLAY data and runs are isolated by mode permanently.

## Cost control

Real USD cost:
- Question envelope USD2 = 2000000 micros, covering the candidate and later research.
- UTC daily model / paid data USD20 = 20000000 micros.
- Upper bound per request = input token cost + maxOutput cost + allowed tool cost. Use a conservative ceil. With no rate or no upper bound, automatic execution is rejected.
- Call the provider only after the reservation. A timeout / unknown usage → UNKNOWN, and the reservation stays occupied.
- Release only if it is certain that nothing was sent. If a response exists, reconcile the actual spend by the provider request ID. If it exceeds the reservation, record the full real spend, close the new-request gate and alert. The number must not be shrunk to pretend there was no overrun.
- A retry is a new attempt. If the previous cost is unknown, keep the old reservation and add a new one at the same time.
- Midnight does not zero an unresolved reservation. It still belongs to the original UTC day's ledger. The new day's budget is another row, and the question total keeps accumulating.

Model cost, hosting, data purchase, test gas and faucet are booked separately. The bUSD trading amount is not treated as revenue. An agent cannot buy a paid tool that has not been configured.

## Job policy initial values

| Job | Retry condition | Limit and final state |
| --- | --- | --- |
| evidence.fetch | timeout / recoverable HTTP | at most 3 attempts, backoff, failure goes to manual |
| discovery/forecast/baseline | a confirmed retry and the budget allows; schema error at most once | at most 2 attempts, unknown cost is still kept |
| candidate.validate | pure rules | at most 3 attempts; a business disqualification is not retried |
| market.deploy | tracks a manual intent, never re-signs automatically | an unknown receipt stays pending |
| quote/chain/budget.reconcile | read failure | at most 5 attempts per job, then alert; a monitor schedules a separate reconcile and does not clear the risk |
| keeper.finalize | due and executable on-chain | replay/replacement under the same intent; judge the state again when the deadline changes |
| faucet.mint | an approved claim, not yet successful and gas allows | the same intent; unknown does not mint again |
| evaluation.score | a pure computation that can be rebuilt | at most 3 attempts, results deduplicated by version |

The general lease initial value is 60 seconds, renewed every 20 seconds. A long task needs a checkpoint / lease extension. If renewal fails, the next external side effect is not started. The lease / fencing token cannot replace intent dedupe at the provider and the chain.

## Resolver / Keeper / Faucet

The parser only produces a suggested outcome/evidence. The RESULT_PROPOSER manually checks the first qualifying publication. The CHALLENGER checks the report, and the ARBITER, an independent role, handles disputes. In v0.1 the roles may be controlled by the same team, and this is publicly disclosed.

The keeper scans due states every 15 seconds and creates a unique intent for each market + target finalization. It re-reads the state/time before sending. After an unchallenged challenge window ends, it finalizes as soon as possible. After the hardDeadline it switches to timeout INVALID. If the original intent is UNKNOWN, check the receipt/nonce first and do not send a new nonce twice. The initial deadline reminders are 24h/1h/10m, and the REPLAY 120-second challenge uses correspondingly shortened reminders. When the RPC or the gas upper bound cannot be estimated, automatic sending stops and an alert is raised. A person can call the contract directly.

The faucet address is taken from the verified binding and an arbitrary `to` in the body is not accepted. Rolling 24h is at most 1000 bUSD, and pending/unknown also count. Lock the guard for the same deployment/address. The mint signer encodes to/amount itself, restricts role/chain/token and uses a separate daily gas allowance. Only when the receipt is certain to have failed may a retry be handled. The success time is the basis of the rolling window, and no more is released while pending.

## Acceptance and observability

S03/S04: two workers compete for the same budget, an unknown cost across midnight, an insufficient retry allowance.
S06: a malicious redirect / DNS / decompression bomb / document prompt injection does not obtain a secret or a signer scope.
S10/S11: an already published answer, an expired snapshot, a missing model, REPLAY does not report a fake LIVE probability or enter LIVE scores.
S12: a new invited agent needs only the public documentation / a key to get the window, cite evidence, submit, and be visible after the close.

Monitor requestId→jobId→runId/providerRequestId, reservation age, deadline lag and unknown count. The API public health gives only availability and the reason for being disabled. The admin health gives queue / signature policy / budget details.
