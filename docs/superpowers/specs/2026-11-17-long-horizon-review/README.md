# Long-horizon forecasting: review, research and proposals

Date: 2026-11-17. Status: working material; the decisions taken on it are in sections 12.5 and 12.6 of the discussion record. These files check [the 2026-11-16 discussion record](../2026-11-16-long-horizon-forecasting-discussion.md) and the project's differentiation. Nothing here is implemented.

The reports were written by subagents and are kept as delivered, in Traditional Chinese. Only file paths were changed, to make them relative to this folder or to the repository root.

## Files

| File | What it is | How far it was checked |
| --- | --- | --- |
| [participant-review-report.md](participant-review-report.md) | Independent review of the 26 decisions from each participant's seat: 13 findings, a per-participant table, the claims that held up, 15 decisions to reopen, and a section on innovation. | The reviewer read the contracts and parameters and ran the scripts below. The main session re-derived two results by hand (the +90 / −110 / +10 payoff and the 54 / 10 / 44 split); the rest was not rerun. Its section on innovation rests on training knowledge. |
| [prediction-markets-and-agent-commerce.md](prediction-markets-and-agent-commerce.md) | Web research of 2026-11-16 on live prediction markets and agent commerce, with source URLs. | Each claim is tagged as read from the page, seen only in a search summary, inferred, or unverified. English sources only. |
| [mechanism-prior-art-sources.md](mechanism-prior-art-sources.md) | Primary-source check of 2026-11-17: whether six mechanisms of the design already exist in other protocols, with quotations. | Documentation and whitepapers were read, not contract source code. "Not in the documents read" does not mean nobody does it. |
| [reopened-decisions-proposals.md](reopened-decisions-proposals.md) | Proposals for the 15 reopened decisions, including one consistent version of the bounty mechanism. Proposals only. | The author reproduced the reviewer's numbers. Three parts are derived, not simulated: the race for exposure, the honeypot, and top-ups in tranches. |
| [review-charts.html](review-charts.html) | Source of the page that explains the review's judgments in charts. It is a page fragment, written for the publishing tool that wraps it, so it has no `<html>` or `<body>` of its own. | Layout looked at once at desktop and phone width. |
| [mechanism-r-worked-example.md](mechanism-r-worked-example.md) ([繁體中文](mechanism-r-worked-example.zh-TW.md)) | Added 2026-11-21. Mechanism R on one rain question with a sponsor and four forecasters, including the user's three changes of that day and what burning costs the sponsor. | Every amount comes from `scripts/worked_example.py`. The two language versions carry the same tables. |
| [scripts/](scripts/) | Calculation scripts. `q14.py`, `q14c.py`, `rest.py` and `q21.py` are the reviewer's; `reopen_mechanism.py` and `reopen_cashflow.py` belong to the proposals; `worked_example.py` belongs to the worked example. Run with `python3 -I <file>`; no network or extra packages. | The Q21 part of `rest.py` is miscalibrated, by the reviewer's own note; `q21.py` replaces it. |

## What they conclude

- **The design as recorded does not solve the original problem.** A forecaster's expected payout is exposure × edge², so a 10-point edge is worth 1% of stake, locked until FINAL. Five of the 26 decisions are contradicted by a worked example (Q14, Q16, Q17, Q19, Q25), ten more are recommended for reopening, and eleven were not flagged.
- **The review's fixes are themselves disputed.** The proposals document reproduces the reviewer's numbers but finds that two of the suggested fixes do not work (Q25 and Q15), and that the safe maker depth in Q19 is overstated about tenfold.
- **Differentiation.** "Every role is an agent" already exists (Olas Predict), and so do sealed, verifiable forecast records in prototype form (Foresight Arena). After reading other protocols' specifications, two mechanisms of the whole design have no precedent in the documents read: the on-chain security bound enforced at creation, and deterministic settlement recomputed from archived source bytes. Confidence in both is medium-low. (Corrected 2026-11-18: the bound covers the total maximum payout of all open markets, `openPayoutTotal`, not each market on its own; some reports in this folder say "per-market".)

## Where the reports disagree

Read the proposals together with the review, not instead of it. Where they differ on a number, the proposals document says which assumption causes the difference (its section 5).

## What the user decided after reading the summaries

These are recorded in section 12 of [the discussion record](../2026-11-16-long-horizon-forecasting-discussion.md). On 2026-11-18 the user decided the reopened items on the page's decision board (section 12.5): Mechanism R is adopted as the working direction, mostly by following the recommendations, and is open to revision once explained with worked examples. On 2026-11-21, after the worked example, the user changed three rules (section 12.6): net losses are burned on every question, only the side that can lose stays locked after reveal, and the documentation will present a 50% starting baseline as "no stance".
