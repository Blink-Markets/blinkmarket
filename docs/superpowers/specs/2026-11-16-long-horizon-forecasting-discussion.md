# Long-horizon questions: early forecasts, bounties and the sponsor role — discussion record

Date: 2026-11-16. Status: discussion record. The user confirmed these 26 decisions as the shared understanding on 2026-11-16. Nothing here is implemented, no implementation plan exists, and [the autonomous market design](2026-10-23-autonomous-market-design.md) has not been amended yet. The discussion was held in Chinese; this record follows the repository's language.

Each decision is marked with who it came from: **[User]** means the user's own answer or idea; **[Accepted]** means the assistant recommended it and the user said yes. Section 9 lists what is still unverified.

## 1. The problem

Some questions take six months to several years to resolve (next year's election, for example). Early on the price barely moves, so the early period gives no useful reference. How can a participant's benefit exceed their time cost, so that they take part early and the early forecast is accurate?

## 2. Starting point (the user's brief)

The user came in with a written brief. These points are from the brief; the papers it cites were not re-checked in this discussion.

- **Merge was explored and set aside.** Adding `merge` (burn YES+NO for 1 bUSD) lets a position exit early, but other platforms already have it and still needed more. It moves risk and creates no information. In Blink's contracts it also collides with the cumulative caps and the reserved security capacity.
- **Diagnosis.** Locked collateral that earns nothing pulls long-dated prices toward 50%. Research cost is hard to recover. Agents remove boredom but still pay for inference, data, monitoring and locked capital. A flat price is not necessarily wrong, and volume is not information.
- **Evidence cited in the brief.** Page & Clemen (2013); Gebele & Matthes (arXiv 2605.31431), a settlement wedge of about 3–7% a year; Tsang & Yang (arXiv 2603.03136); Maresca (arXiv 2602.21091, not peer-reviewed), where interest on positions removed about 83% of the long-horizon accuracy loss. Polymarket and Kalshi both pay holding rewards or interest.
- **The reframe.** Blink has a second channel besides price: signed, sealed, timestamped forecasts that need no position capital. So the early reference could come from forecasts.
- **Three candidate directions.** (1) Event-driven forecasting with no contract change. (2) Short-dated evidence markets under a long question. (3) Sponsor bounties scored by improvement over the prior consensus.

## 3. Assessment of the reframe

The reframe is half right. The forecast channel removes position capital, but it does not remove the wait: Brier scores, credit and any payment all arrive at FINAL. Until then an early forecast is cheap talk. The problem moves from "capital is locked" to "feedback is delayed".

One concrete hole: the consensus on a two-year question is weighted by credit the forecaster earned on other, short questions. Short-horizon skill is standing in for long-horizon skill.

## 4. Problem and goal

| # | Decision | Source |
| --- | --- | --- |
| Q1 | Success is relative. At N months before resolution, Blink's consensus must beat (a) one frontier model asked once and (b) the external market price at the same moment (Polymarket, Kalshi, Metaculus), in Brier score over a set of questions, counted as improvement per dollar of inference cost. One question alone is noise. | Accepted |
| Q2 | The problem is restated as: how to produce credible, non-manipulable feedback before FINAL. Thin early prices are a symptom and are not a target. This makes direction 2 central, because it is the only source of early settled outcomes. | Accepted |
| Q3 | Testnet and mainnet are not designed separately. The design assumes mainnet conditions, where stake and slashing have real value. Money incentives are therefore in scope, and direction 3 is a real design target. The assistant had recommended treating this generation's reward as reputation only; the user rejected that split. A verifiable, sealed track record remains a side benefit. | User |
| Q4 | The platform runs no role. Every participant is a third party who pays their own costs; the user runs all agents today only because it is still a test. | User |
| Q6 | Merge is a separate trading-feature decision and is out of this problem. | Accepted |
| Q7 | Interest goes into the design now, not at mainnet. The collateral interface should be able to bear yield (for example, collateral as vault shares), even if the testnet rate is zero. Reason: under Q3 the cost of stake locked until FINAL is real, and the contracts cannot be upgraded. This replaces the "mainnet only" part of the first Q6 recommendation. | User confirmed |

## 5. Changes to the forecast layer

| # | Decision | Source |
| --- | --- | --- |
| Q8 | A forecast on the parent question is never scored before FINAL against peers or a later consensus; that is a beauty contest and invites collusion. Feedback before FINAL comes only from child markets that have really settled. Parent bounties pay at FINAL, and the wait is compensated by interest (Q7). | Accepted |
| Q9 | Credit comes from the score relative to the previous window's consensus, not from absolute Brier. The current weight, max(0, 0.25 − mean Brier), has a hole unrelated to long horizons: forecasting 0.99 on near-certain questions earns full weight. Under the relative score, copying the consensus and farming easy questions both earn zero. | Accepted |
| Q10 | Credit is bucketed by horizon. (a) A long question's consensus is weighted by long-bucket credit. (b) When a bucket has no data, it falls back to the adjacent shorter bucket at a discount. (c) When that is empty too, it uses stake weighting; the plain-mean fallback is removed, because ten clones can dominate it. (d) The consensus states which bucket its weights came from. | Accepted |
| Q20 | Any creator may open a child market. The link to the parent is a label written at creation that cannot change and has no effect on settlement. Credit from a child goes only to its own short bucket and gives no special weight on the parent. There is no extra limit on the number of children beyond the existing bond. Letting child credit weigh the parent consensus is left out of the first version, because a creator could open children on which they hold inside knowledge; it stays as an experiment variable. | Accepted |

What child markets contribute: the same research gets paid earlier (someone researching an election is paid on each month's poll question), and they leave a timeline of settled evidence.

## 6. The bounty mechanism (direction 3)

Direction 3 is, in substance, Hanson's market scoring rule (a subsidised LMSR) in a sealed batch form.

### 6.1 Conditions for continuing (Q5) [Accepted]

Direction 3 as first written had three fatal problems:

1. **Stake locked until FINAL** brings back the locked-capital cost the reframe tried to escape.
2. **The baseline can be manipulated.** During cold start, a swarm of clones drags the consensus in one window and the main identity "improves" on it in the next.
3. **A fixed pool shared pro rata is no longer proper.** The reward becomes a relative rank, so honest reporting stops being the best strategy.

It continues only under three conditions: the payment baseline is separate from the displayed consensus; the baseline counts only staked forecasts; and anyone can recompute the baseline and dispute it through the existing challenge and arbitration layer.

### 6.2 Payment formula (Q14) [Accepted]

- Each window has a fixed budget B, escrowed in advance.
- Exposure = own stake × min(1, B ÷ total stake in that window).
- Payout = exposure × (own Brier score − the baseline's score). It can be negative and is taken from stake. Gains and losses use the same exposure, so honest reporting stays optimal.
- The baseline moves in each window only by the fraction (filled exposure ÷ B). It is not replaced by the last window's average.

The last rule is the one that matters. Without it, someone drags the baseline with a small stake in a quiet window and corrects it with a large stake in the next, keeping the difference. With it, the loss from dragging is at least the gain from correcting.

Properties: the sponsor pays at most B per window, and cloned agents submitting the same answer dilute each other instead of being paid twice. Brier is used rather than the log score because it is bounded, so stake always covers the largest loss.

### 6.3 The rest of the mechanism

| # | Decision | Source |
| --- | --- | --- |
| Q15 | A small, non-refundable entry fee per unit of stake, added to the budget of the same question's later windows. Without it, a large stake that copies the baseline costs almost nothing, takes exposure from informed forecasters and pins the baseline to its old value. The rate is a deployment parameter to be set by simulation. | Accepted |
| Q17 | The budget over time: (a) window budgets decline with the remaining horizon and reach zero before resolution; (b) early windows are spaced further apart (monthly, for example); (c) unspent budget rolls into the next window, so the bounty grows until someone finds it worth taking. Near resolution, information is cheap and public, and paying then buys news-reading, not research. | Accepted |
| Q18 | A staked forecast is put on-chain by the forecaster: commit a hash, then reveal after the window closes. A missed reveal counts as the largest loss and is slashed. The existing off-chain Merkle window stays only for unstaked, free forecasts. Reason: if the platform anchors the roots, it can omit or delay a forecast and becomes a trusted party. | Accepted |
| Q19 | A sponsor who also trades: (a) a bounty cannot be withdrawn once escrowed; (b) there are no identity rules, because addresses are anonymous and a ban cannot be enforced; (c) the cost of moving the consensus (for example, "what it costs to move it 10 points") is published in machine-readable form. The user's correction: the main readers are agents, above all makers deciding a quote; the website display is secondary. The assistant's reading, not contradicted: the number comes from a read-only contract query, not from a platform API. | Accepted, (c) revised by User |

The attack behind Q19: someone stakes a wrong forecast to pull the consensus down, buys cheaply from makers who quote off the consensus, and holds to FINAL. The cost is the lost bounty stake; the gain depends on how much maker depth follows the consensus blindly. The corrector in the next window collects what the manipulator lost.

## 7. Who pays: the sponsor role

### 7.1 The default sponsor (Q11, revised by Q16) [Accepted]

Q11 first set the default source as a fixed share of fees paid into a forecaster pool, with short markets subsidising long questions. Q16 withdrew that for two reasons:

- **A shared pool across markets can be farmed.** Open a junk question with an obvious answer, be its only forecaster, and drain the pool. No rule-based allocation of a shared pool prevents this.
- **A market's own fees arrive too late.** Fees are settled at FINAL, while the formula in 6.2 needs the budget before the window opens.

What stands instead: the creator escrows a forecast bounty when the market is created, the amount is public, and the creator recovers it from their own fee share at FINAL. Farming one's own bounty only moves money between one's own hands. Anyone may add to the bounty, and the platform has no privilege. A question with no bounty is labelled as having a consensus with no bounty behind it.

This revises U13 ("forecasters earn from trading") for long questions: forecasters now have a bounty source. It does not break the rule against volume-based rewards, because the payout depends only on relative scores after settlement.

Accepted consequence: on a long question with thin trading the creator cannot recover the bounty, so such a question has a bounty only when someone wants the answer and pays for it.

### 7.2 The sponsor as a role

The user proposed this: open a role for willing participants to fund a question (an election polling organisation, for example), so that both sides benefit. **[User]**

| # | Decision | Source |
| --- | --- | --- |
| Q22 | Sponsor is a first-class on-chain role that any address may take: a person, an organisation or an agent. It is the only role open to humans and organisations; this does not break the agents-only principle, because a sponsor only pays and makes no judgment that affects an outcome. It has no credit, since credit may come only from settled outcomes. U12 stands (a suggester is paid nothing), but a suggester who adds money becomes a sponsor. | Accepted |
| Q23 | The two sides are those who need an answer and those who hold private information. A polling organisation holds data others lack, so its natural place is to run an agent as a forecaster and earn the bounty; it may also sponsor. Likely payers are those whose decisions depend on the outcome: campaigns, funds, media, a DAO exposed to the result. Forecasters with private data are also the source of independent information that Q21 tests for. | Accepted |
| Q24 | A sponsor buys "this question gets answered", not exclusive information; forecasts on-chain are public. They get the choice of question and attribution. Identity is accepted only through proof that can be checked mechanically (a domain or ENS signature); the platform does no manual verification. A sponsor can fund only a market that already exists: they suggest the question through the existing channel, a creator agent opens it, and the sponsor picks which market to fund. The platform does not judge which market matches the request. | Accepted |
| Q25 | A sponsor never gets back more than they deposited: at most their unspent principal. Slashed stake rolls into later windows of the same question, and the remainder at FINAL goes to the treasury — not to the sponsor, and not to the juror or settlement pools, which would give those who rule a reason to rule wrongly. The market's resolution source and the sponsor's address are published in machine-readable form, as in Q19. | Accepted |
| Q26 | Sponsor money goes only to the forecast bounty, on the fixed schedule of Q17. It cannot subsidise makers or traders; that would be a volume-based reward and could be farmed. Information reaches trading indirectly: the bounty makes the consensus accurate, and makers read the consensus and the manipulation cost when they quote. | Accepted |

The attack behind Q25: a sponsor who is also the resolution source (a child market that settles on their own poll) funds a bounty, waits for forecasters to stake, publishes a number that makes them all wrong, and collects the slashes. A useful property holds here: a forecaster is paid against the baseline, not against other forecasters, so an insider forecaster does not take other forecasters' money directly. The damage is limited to makers who quote off the consensus.

## 8. Validation and staging

- **The first experiment (Q12, Q21) [Accepted].** It tests whether several agents carry independent information at all; if they all use the same model and read the same public news, the consensus is roughly one model and no incentive has anything to reward.
  - **Questions:** 100 as the target and 50 as the minimum, with horizons of 4 to 12 weeks, plus a few long questions that have an external market price.
  - **Four arms, compared on the same questions:** one model asked once; the same model averaged over several runs; different models; different models each with their own tools and data.
  - **Measured:** Brier at 8, 4 and 1 weeks before resolution, and the inference cost of each arm.
  - **Threshold, fixed in advance:** the "different models with their own tools" arm must beat "one model asked once" by at least 10% in Brier at 8 weeks, with a confidence interval that excludes zero. The 10% is the assistant's starting figure; the user may change it before seeing results.
  - **If it fails:** direction 3 is shelved, together with the bounty part of the sponsor role. Directions 1 and 2 and the credit changes of Q9 and Q10 remain.
- **Staging (Q13) [Accepted].** Direction 1 is built as planned. Direction 2 is tried on one question that has real intermediate events. Direction 3 is written as a full specification and run through attack scenarios in an agent simulation (in the manner of Maresca); it enters the next deployment generation only after passing. The contracts cannot be upgraded, so an error in direction 3 can be caught only before deployment.

## 9. What is not settled or not verified

- **The no-profit claims are derivations, not proofs.** That dragging then correcting the baseline is unprofitable (Q14), and that the sponsor attack is closed (Q25), were reasoned out in the discussion. Neither has been simulated or formally verified.
- **Parameters are open.** The entry fee rate, the shape of the budget decline and the discount on the bucket fallback are deployment parameters, to be set by simulation.
- **Demand is unproven.** Who would really pay, and how much, has no evidence behind it; only the role is designed.
- **The experiment reaches three months.** Anything about a two-year horizon is extrapolated from it.
- **The parent question has no feedback before FINAL.** This is accepted (Q8), not solved.

## 10. Existing decisions this changes

Each of these needs a new deployment generation:

- U13 is revised: forecasters have a bounty source.
- The credit formula becomes a relative score and is bucketed by horizon.
- The plain-mean fallback of the consensus is removed.
- The collateral interface becomes able to bear yield.
- A sponsor role and a bounty contract are added.

## 11. How the brief's open questions were answered

| Brief | Answer |
| --- | --- |
| Q1: the goal is early forecast accuracy, not trading activity | Yes, as a relative measure (Q1, Q2). |
| Q2: split merge out as a separate decision | Yes (Q6). |
| Q3: interest-bearing collateral is a mainnet item only | No. It enters the design now (Q7). |
| Q4: build direction 1, try direction 2, only design direction 3 | Changed: direction 3 gets a full specification and a simulation before the next generation (Q13). |
| Q5: bounties open to any sponsor, platform with no privilege | Yes, and sponsor becomes a formal role (Q16, Q22–Q26). |
