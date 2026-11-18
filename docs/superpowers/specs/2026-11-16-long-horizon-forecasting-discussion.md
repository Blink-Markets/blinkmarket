# Long-horizon questions: early forecasts, bounties and the sponsor role — discussion record

Date: 2026-11-16. Status: discussion record. The user confirmed these 26 decisions as the shared understanding on 2026-11-16. Nothing here is implemented, no implementation plan exists, and [the autonomous market design](2026-10-23-autonomous-market-design.md) has not been amended yet. The discussion was held in Chinese; this record follows the repository's language.

**Reviewed on 2026-11-17.** An independent review found several claims in this record to be wrong and recommended reopening 15 of the 26 decisions. The original text is kept. Each affected place carries a note marked **[Review]**, and section 12 gives the status of every decision. The review, the research behind it and the proposals for the reopened decisions are in [2026-11-17-long-horizon-review](2026-11-17-long-horizon-review/README.md). The decisions below are therefore no longer a settled design.

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

> **[Review]** Q7: any real source of yield has governance, pause or upgrade powers, which brings outside control into a system with no admin, and collateral held as vault shares breaks the unit comparison that the security bound relies on (finding 13). Interest also does nothing about the size of the reward; see the note in 6.2.

## 5. Changes to the forecast layer

| # | Decision | Source |
| --- | --- | --- |
| Q8 | A forecast on the parent question is never scored before FINAL against peers or a later consensus; that is a beauty contest and invites collusion. Feedback before FINAL comes only from child markets that have really settled. Parent bounties pay at FINAL, and the wait is compensated by interest (Q7). | Accepted |
| Q9 | Credit comes from the score relative to the previous window's consensus, not from absolute Brier. The current weight, max(0, 0.25 − mean Brier), has a hole unrelated to long horizons: forecasting 0.99 on near-certain questions earns full weight. Under the relative score, copying the consensus and farming easy questions both earn zero. | Accepted |
| Q10 | Credit is bucketed by horizon. (a) A long question's consensus is weighted by long-bucket credit. (b) When a bucket has no data, it falls back to the adjacent shorter bucket at a discount. (c) When that is empty too, it uses stake weighting; the plain-mean fallback is removed, because ten clones can dominate it. (d) The consensus states which bucket its weights came from. | Accepted |
| Q20 | Any creator may open a child market. The link to the parent is a label written at creation that cannot change and has no effect on settlement. Credit from a child goes only to its own short bucket and gives no special weight on the parent. There is no extra limit on the number of children beyond the existing bond. Letting child credit weigh the parent consensus is left out of the first version, because a creator could open children on which they hold inside knowledge; it stays as an experiment variable. | Accepted |

What child markets contribute: the same research gets paid earlier (someone researching an election is paid on each month's poll question), and they leave a timeline of settled evidence.

> **[Review]** Three problems in this section (findings 7 and 9).
>
> - **Q9:** identities that submit free, unstaked forecasts can drag the consensus in one window so that a main identity "improves" on it in the next. The relative score it earns per question is about 96 times that of an honest forecaster with a 5-point edge, and the negative scores of the dragging identities cost nothing, because weight is floored at zero.
> - **Q10:** the long bucket is empty for the first two years, so falling back to the short bucket is the normal case; that is the hole section 3 describes. The stake used for weighting in (c) is the forecaster's role stake, which today can be withdrawn after a day and is never slashed.
> - **Q20:** through that fallback, credit from child markets does weigh on the parent, so "no special weight on the parent" does not hold while the long bucket is empty. The record's own example of a child market, a monthly poll, settles on data controlled by a party it invites to forecast.

## 6. The bounty mechanism (direction 3)

Direction 3 is, in substance, Hanson's market scoring rule (a subsidised LMSR) in a sealed batch form.

### 6.1 Conditions for continuing (Q5) [Accepted]

Direction 3 as first written had three fatal problems:

1. **Stake locked until FINAL** brings back the locked-capital cost the reframe tried to escape.
2. **The baseline can be manipulated.** During cold start, a swarm of clones drags the consensus in one window and the main identity "improves" on it in the next.
3. **A fixed pool shared pro rata is no longer proper.** The reward becomes a relative rank, so honest reporting stops being the best strategy.

It continues only under three conditions: the payment baseline is separate from the displayed consensus; the baseline counts only staked forecasts; and anyone can recompute the baseline and dispute it through the existing challenge and arbitration layer.

> **[Review]** Finding 8: the bounty and the forecast stake are not counted in the security bound, which adds up only each open market's `maxPairs × 1 bUSD` (`openPayoutTotal`, the total across all open markets). A market with a maximum payout of 1 bUSD could carry a bounty of 100,000 bUSD decided by the same arbitration result. A dispute about the baseline is a question about a number, which the existing arbitration (YES or NO) cannot answer. What happens to a bounty when the market ends INVALID is not defined, and a juror may hold forecast exposure in a market they vote on.

### 6.2 Payment formula (Q14) [Accepted]

- Each window has a fixed budget B, escrowed in advance.
- Exposure = own stake × min(1, B ÷ total stake in that window).
- Payout = exposure × (own Brier score − the baseline's score). It can be negative and is taken from stake. Gains and losses use the same exposure, so honest reporting stays optimal. **[Review]** The sign is written backwards: a Brier score is a loss, and lower is better. The intended payout is exposure × (the baseline's Brier loss − own Brier loss).
- The baseline moves in each window only by the fraction (filled exposure ÷ B). It is not replaced by the last window's average.

The last rule is the one that matters. Without it, someone drags the baseline with a small stake in a quiet window and corrects it with a large stake in the next, keeping the difference. With it, the loss from dragging is at least the gain from correcting.

> **[Review]** This claim is false as soon as a later window can hold more exposure than the window that was dragged. Roll-over (Q17c) and top-ups (section 7.1) both cause that. The reviewer's example: budgets decline from 1,000 to 500 over six windows; the attacker drags the baseline in window 1 for an expected loss of 240, lets four windows roll over, and corrects in window 6 with 3,500 of exposure for an expected gain of 840. That is a net 600 bUSD, and still 579 with an entry fee of 0.5%. The claim holds only if the available budget never rises (finding 2).

Properties: the sponsor pays at most B per window, and cloned agents submitting the same answer dilute each other instead of being paid twice. Brier is used rather than the log score because it is bounded, so stake always covers the largest loss.

> **[Review]** Both properties held up, and so did truthful reporting within a single window. What this section leaves out is the size of the reward (findings 1 and 11). The expected payout is exposure × edge², where edge is the distance between the forecaster's belief and the baseline. A 10-point edge is worth 1% of stake: with a baseline of 0.5, a belief of 0.6 and an exposure of 1,000, the payout is +90 if YES and −110 if NO, an expected +10, and the stake is locked until FINAL. In the reviewer's two-year scenarios a forecaster with only public information has a negative expected net value. The first window's baseline is undefined. And the more a sponsor funds a window, the less a forecaster with limited capital can move the baseline.

### 6.3 The rest of the mechanism

| # | Decision | Source |
| --- | --- | --- |
| Q15 | A small, non-refundable entry fee per unit of stake, added to the budget of the same question's later windows. Without it, a large stake that copies the baseline costs almost nothing, takes exposure from informed forecasters and pins the baseline to its old value. The rate is a deployment parameter to be set by simulation. | Accepted |
| Q17 | The budget over time: (a) window budgets decline with the remaining horizon and reach zero before resolution; (b) early windows are spaced further apart (monthly, for example); (c) unspent budget rolls into the next window, so the bounty grows until someone finds it worth taking. Near resolution, information is cheap and public, and paying then buys news-reading, not research. | Accepted |
| Q18 | A staked forecast is put on-chain by the forecaster: commit a hash, then reveal after the window closes. A missed reveal counts as the largest loss and is slashed. The existing off-chain Merkle window stays only for unstaked, free forecasts. Reason: if the platform anchors the roots, it can omit or delay a forecast and becomes a trusted party. | Accepted |
| Q19 | A sponsor who also trades: (a) a bounty cannot be withdrawn once escrowed; (b) there are no identity rules, because addresses are anonymous and a ban cannot be enforced; (c) the cost of moving the consensus (for example, "what it costs to move it 10 points") is published in machine-readable form. The user's correction: the main readers are agents, above all makers deciding a quote; the website display is secondary. The assistant's reading, not contradicted: the number comes from a read-only contract query, not from a platform API. | Accepted, (c) revised by User |

The attack behind Q19: someone stakes a wrong forecast to pull the consensus down, buys cheaply from makers who quote off the consensus, and holds to FINAL. The cost is the lost bounty stake; the gain depends on how much maker depth follows the consensus blindly. The corrector in the next window collects what the manipulator lost.

> **[Review]** Notes on the table above and on this paragraph (findings 2, 3, 6 and 10).
>
> - **Q19:** the last sentence is wrong. The corrector is paid from the sponsor's budget, and the manipulator's loss goes to the treasury under Q25. With the current caps (500 shares per taker identity, 10,000 pairs per market, a 1% fee, a 10 bUSD registration fee), dragging the baseline 10 points in a window of 1,000 has an expected cost of about 10 bUSD and an expected trading gain of up to 457 bUSD. "The cost of moving the consensus" has no single definition. After the last funded window the baseline is frozen and nobody can correct it.
> - **Q17:** roll-over (c) raises later budgets. That breaks the claim in 6.2 and pays a forecaster with private information to report later, which works against (a).
> - **Q15:** a fee charged on stake does not stop a large stake that copies the baseline. At 9 × B the honest forecaster's net gain falls from 38 to 2, at a cost of 18 to the attacker.
> - **Q18:** slashing the whole stake for a missed reveal leaves an honest operator a tolerance below 1% per window, because the expected honest reward is only 0.25% to 1% of stake. A sequencer outage would slash every honest forecaster at once.

## 7. Who pays: the sponsor role

### 7.1 The default sponsor (Q11, revised by Q16) [Accepted]

Q11 first set the default source as a fixed share of fees paid into a forecaster pool, with short markets subsidising long questions. Q16 withdrew that for two reasons:

- **A shared pool across markets can be farmed.** Open a junk question with an obvious answer, be its only forecaster, and drain the pool. No rule-based allocation of a shared pool prevents this.
- **A market's own fees arrive too late.** Fees are settled at FINAL, while the formula in 6.2 needs the budget before the window opens.

What stands instead: the creator escrows a forecast bounty when the market is created, the amount is public, and the creator recovers it from their own fee share at FINAL. Farming one's own bounty only moves money between one's own hands. Anyone may add to the bounty, and the platform has no privilege. A question with no bounty is labelled as having a consensus with no bounty behind it.

This revises U13 ("forecasters earn from trading") for long questions: forecasters now have a bounty source. It does not break the rule against volume-based rewards, because the payout depends only on relative scores after settlement.

Accepted consequence: on a long question with thin trading the creator cannot recover the bounty, so such a question has a bounty only when someone wants the answer and pays for it.

> **[Review]** The default source does not work with the current parameters (finding 5). A creator receives 25% of a 1% fee: on the largest market, with all 10,000 pairs filled at an average price of 0.5, that is 12.5 bUSD, and never more than 25 bUSD, against a creation bond of 500 bUSD. "Farming one's own bounty only moves money between one's own hands" is true only while nobody else's money, entry fees or rolled-over slashes sit in the same budget. Withdrawing the shared pool was correct.

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

> **[Review]** Three corrections (findings 4, 8 and 9).
>
> - **Q25:** winners are paid in full by the sponsor and losers' stake goes to the treasury, so 81% to 90% of what a sponsor spends ends in the treasury. In the example of 6.2 the sponsor's expected spend is 54, the forecasters' net gain is 10 and the treasury receives 44. A sponsor who is the resolution source still profits: by publishing the opposite outcome they pay nothing and recover their whole principal. Slashes on a parent question are known only at FINAL, so they cannot roll into later windows.
> - **The property claimed in this paragraph fails when a window is oversubscribed.** An insider's stake then scales down the honest forecasters' exposure, and an insider forecaster can take co-sponsors' money and other forecasters' entry fees from the same budget.
> - **Q23:** the record invites a polling organisation to forecast and to sponsor while a child market settles on its own poll. The governing design lists "the result can be influenced by participants" as a ground for challenging a market's creation.

## 8. Validation and staging

- **The first experiment (Q12, Q21) [Accepted].** It tests whether several agents carry independent information at all; if they all use the same model and read the same public news, the consensus is roughly one model and no incentive has anything to reward.
  - **Questions:** 100 as the target and 50 as the minimum, with horizons of 4 to 12 weeks, plus a few long questions that have an external market price.
  - **Four arms, compared on the same questions:** one model asked once; the same model averaged over several runs; different models; different models each with their own tools and data.
  - **Measured:** Brier at 8, 4 and 1 weeks before resolution, and the inference cost of each arm.
  - **Threshold, fixed in advance:** the "different models with their own tools" arm must beat "one model asked once" by at least 10% in Brier at 8 weeks, with a confidence interval that excludes zero. The 10% is the assistant's starting figure; the user may change it before seeing results.
  - **If it fails:** direction 3 is shelved, together with the bounty part of the sponsor role. Directions 1 and 2 and the credit changes of Q9 and Q10 remain.
- **Staging (Q13) [Accepted].** Direction 1 is built as planned. Direction 2 is tried on one question that has real intermediate events. Direction 3 is written as a full specification and run through attack scenarios in an agent simulation (in the manner of Maresca); it enters the next deployment generation only after passing. The contracts cannot be upgraded, so an error in direction 3 can be caught only before deployment.

> **[Review]** The experiment's threshold compares the wrong arms (finding 12). Arm 4 against arm 1 can pass through averaging or a search tool alone, which is not independent information; arm 4 against arms 2 and 3 tests that. Only questions with a horizon of at least 8 weeks count at the 8-week mark. Under the reviewer's assumptions, a true improvement of about 8% would pass roughly 16% of the time with 100 questions. The comparison with external market prices (Q1b) is left untested.

## 9. What is not settled or not verified

- **The no-profit claims are derivations, not proofs.** That dragging then correcting the baseline is unprofitable (Q14), and that the sponsor attack is closed (Q25), were reasoned out in the discussion. Neither has been simulated or formally verified. **[Review]** Both were checked on 2026-11-17 and both failed; see the notes in 6.2 and 7.2.
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

## 12. Review and follow-up (2026-11-17)

The material for this section is in [2026-11-17-long-horizon-review](2026-11-17-long-horizon-review/README.md).

### 12.1 What was done

- **A review from each participant's seat.** An independent reviewer worked out, with the repository's real parameters, what a self-interested forecaster, maker, taker, creator, sponsor, juror and attacker would do. It produced 13 findings.
- **Web research** on live prediction markets and agent commerce, with sources.
- **A primary-source check** of six mechanisms against other protocols' specifications.
- **Proposals for the 15 reopened decisions**, including one consistent version of the bounty mechanism. They are proposals; the user has not decided on them.

### 12.2 Status of the 26 decisions

| Status | Decisions |
| --- | --- |
| Contradicted by a worked example | Q14, Q16, Q17, Q19, Q25 |
| Recommended for reopening | Q5, Q7, Q8, Q9, Q10, Q15, Q18, Q20, Q21, Q23 |
| Not flagged by the review | Q1, Q2, Q3, Q4, Q6, Q11, Q12, Q13, Q22, Q24, Q26 |

The proposals document suggests reopening five of the unflagged decisions as well: Q22, Q26, Q24, Q2 and Q6.

What held up under the reviewer's attempts to break it:

- Splitting into several identities within one window gains nothing.
- The sponsor pays at most the window's budget.
- Within a single window, and without trading, truthful reporting is optimal.
- When a missed reveal is penalised by the largest loss, selective reveal is not an option worth having.
- Copying the consensus earns no credit (Q9).
- Withdrawing the shared pool across markets (Q16) was correct.

The review's own fixes are disputed in places: the proposals document reproduces the reviewer's numbers but finds that the suggested fixes for Q25 and Q15 do not work, and that the safe maker depth given for Q19 is overstated about tenfold.

### 12.3 Differentiation

- **The forecast layer adds little that is new.** "Every role is an agent" already exists (Olas Predict, with an approval server for market creation and trading that relies on token subsidies). Sealed, verifiable forecast records exist in prototype form (Foresight Arena, which pays nothing). No venue was found that combines a market with no admin, a sealed forecast layer and payment by score.
- **Checked against the whole design**, after reading other protocols' specifications, two mechanisms have no precedent in the documents read: the on-chain security bound enforced at creation, and deterministic settlement recomputed from archived source bytes. Confidence in both is medium-low.
  - *Corrected 2026-11-18:* this record first called the bound "per-market". `BlinkMarkets.createMarket` checks the total maximum payout of all open markets, `(openPayoutTotal + payout) × securityMultipleBps ≤ attackCostMicros × 10,000`, so a new market is refused when the total would pass the bound. The protocol therefore knows its total open payout exactly; Augur, by its own account, cannot know its open interest. The per-role credit is a new combination of known properties; the creation challenge window and the generations are recombinations of known components; final arbitration by agents alone is not a differentiator.
- **Evidence that bears on the premises.** LLM agents that trade generally lose money, which undermines U13. Forecasts from several frontier LLMs are highly correlated, which is the risk Q21 tests.

### 12.4 What the user decided on 2026-11-17 [User]

- **Innovation is to be checked against the whole design** — roles, flows, rewards and penalties, mechanisms and goals — not only against the 26 decisions.
- **The knowledge base is a highlight of the project:** the collective intelligence of LLMs, used to forecast and reason about many more questions.
- **Breadth first, and its early weakness is accepted.** Early on, the knowledge base grows on computable, long-tail questions. Judgment questions, such as elections, get quality only when someone funds them. The user accepts this weakness for the early stage.
- **The proposals for the reopened decisions are not yet decided.** The user will read them first.

Two suggestions by the assistant remain unanswered: to measure the whole project by its entries (settled probabilities and their calibration) instead of by trading, and to treat the market and the bounty only as means to that end.
