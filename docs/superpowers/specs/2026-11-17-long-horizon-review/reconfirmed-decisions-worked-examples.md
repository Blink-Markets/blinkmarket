# Re-confirming the provisional decisions with worked examples

[繁體中文](reconfirmed-decisions-worked-examples.zh-TW.md)

Most of the 21 cards chosen on the decision board on 2026-11-18 were chosen by following the assistant's recommendations. Section 12.5 of the record keeps them as the working direction, to be confirmed once each mechanism is explained with a worked example. This document collects those examples, one round at a time. Each section holds what the user saw before choosing: the example, the recommendation and the cost. The outcome is recorded in section 12.8 and later sections of [the discussion record](../2026-11-16-long-horizon-forecasting-discussion.md). The numbers come from [`scripts/reconfirmed_examples.py`](scripts/reconfirmed_examples.py), except figures quoted from the review or the proposals; the terms follow [the Mechanism R example](mechanism-r-worked-example.md). Nothing here is implemented.

## Round 1, 2026-11-22: Q9 and Q16

### Two terms

- **Credit**: a forecaster's track record on settled questions. It decides whether its forecasts count toward the number shown on the website.
- **Relative score**: after settlement, the baseline's error minus the forecaster's error. Error = (forecast − outcome)², with YES counted as 1 and NO as 0.

### Q9: credit is only a pass-or-fail threshold, earned only on funded questions

**Why credit cannot be a weight.** The baseline is 50%, a forecaster reports 55%, and the true probability happens to be 55%:

| Outcome | Baseline's error | Forecaster's error | Relative score |
| --- | --- | --- | --- |
| YES (probability 55%) | 0.25 | 0.2025 | +0.0475 |
| NO (probability 45%) | 0.25 | 0.3025 | −0.0525 |

The average is +0.0025 a question. The spread from question to question (the standard deviation) is about 0.05, which is 20 times the average. After 50 questions the total is positive only about 61% of the time (the review's 67% came from its own simulation under different settings). It takes about 1,600 questions for the average to reach two standard errors; at that point the total is positive about 98% of the time. With the data we have today, weighting by credit would amplify luck.

**What credit is measured against.**

| Measured against | What goes wrong |
| --- | --- |
| Absolute error (the current code) | Answer only near-certain questions at 99%. The error is tiny and the credit high, and that credit is then used on hard questions. |
| The average of the free forecasts of the previous window | Fake identities run by one operator drag the average to 1% while the main identity reports 50%. If the true probability is 50%, the main identity earns 0.2401 a question on average, 96 times the honest 5-point edge (0.0025). |
| The paid baseline, counting only staked forecasts | Free identities cannot move the paid baseline. Moving it costs money. |

```
Funded questions
  Staked forecasts
    │ after settlement, scored against the paid baseline
    ▼
  Credit (at most one entry per question)
    │ only pass or fail is used
    ▼
Unfunded questions
  Website number = forecasts of those who pass, all equal (for example the median)
  Forecasting here earns no money and no credit
```

**Decision (the user answered "yes"):** a forecaster significantly worse than the baseline is excluded, and every other forecaster who passes counts equally (for example by taking the median). Credit comes only from staked forecasts on funded questions, and at most one entry per question counts.

**Costs stated before the choice:**

1. Credit cannot tell a good forecaster from a very good one. This admits that, with today's data, it cannot be done.
2. A forecast on an unfunded question earns neither money nor credit. Who forecasts there rests on volunteer agents. Whether to give those questions an incentive is a separate topic.
3. Passing can still be bought. A group of sybil identities first copies the baseline on funded questions. Their relative score is 0, so none is excluded. They then report the same extreme value on unfunded questions, and once they are a majority they take the median. Each identity costs about 10 bUSD in registration fees plus a refundable 100 bUSD deposit. No credit formula stops this. It can only be labelled clearly (Q10).

### Q16: remove "the creator is the default sponsor and recovers the bounty from fees"

| Item | Number |
| --- | --- |
| Fee | 1% of the taker's payment, 25% of it to the creator |
| Cap on pairs traded per market | 10,000 pairs, at most 1 bUSD paid by the taker per pair |
| The most the creator can recover | 10,000 × 1 × 1% × 25% = 25 bUSD; about 12.5 bUSD at a price near 50% |
| Creation bond | 500 bUSD |
| Allowance that an escrow of 12.5 bUSD supports | 50 (escrow = 0.25 × the first window's allowance) |
| A forecaster with a 10-point edge that takes the whole allowance expects, per window | 50 × 0.1² = 0.50, below the assumed inference cost of 1.00 |

**Decision (the user answered "yes"):** a creator that wants to pay a bounty is a sponsor like any other and deposits the whole escrow before the first window opens.

**Costs stated before the choice:** a question with no sponsor has no bounty, and there may be many such questions. If mainnet raises the per-market pair cap a hundredfold, the most a creator can recover becomes 1,250 to 2,500 bUSD, and the decision will be revisited then.

## Round 2, 2026-11-22: Q10 for unfunded questions, and Q20

### Two terms

- **Buckets**: credit is kept separately by question length, for example questions that settle within weeks and questions that take months or years. Being good at short questions does not show skill at long ones.
- **Sub-market**: a short question under a long one. Under the parent "who wins the 2028 election?", for example, a sub-market could ask "will this pollster's November average exceed 45%?"

### Q10: what an unfunded question shows

An unfunded question receives seven forecasts. Three agents that have done the work report 62%, 58% and 60%. Someone also opens four new identities that report 5% each, at a cost of 40 bUSD in registration fees plus 400 bUSD of deposits that come back later.

| What is shown | The number on the website |
| --- | --- |
| The plain mean of all forecasts (the current code) | (62 + 58 + 60 + 4 × 5) ÷ 7 = 28.6% |
| The median of all forecasts | 5% (four of the seven are 5%) |
| Qualified forecasters only (the three agents have credit, the new identities do not) | 60%, labelled "unstaked" |
| Nobody qualifies (common during cold start) | No number; the seven forecasts are listed |

So 40 bUSD moves the plain mean from 60% to 28.6%.

**Decision (the user answered "yes"):** when someone qualifies, show the median of the qualified forecasters, labelled "unstaked", meaning that no money stands behind the number. When nobody qualifies, show no number, only the list. The website then never shows a number that looks credible but can be moved for 40 bUSD. The label stays because, by cost 3 of Q9 in round 1, qualifying can also be bought, only more slowly.

**Cost stated before the choice:** during cold start most unfunded questions have no number, only a list of forecasts, so the knowledge base will look empty at first. The other option was to show the plain mean on every question, with a clear label: unstaked, unweighted, and movable by fake identities. That option suits someone who values "every question has a number" over "the number cannot be bought cheaply".

### Q20: a long question does not borrow credit from short ones

Creator C has ties to a pollster and knows its monthly numbers in advance.

1. C opens the sub-market "will this pollster's November average exceed 45%?", funds a small bounty itself, sets the starting baseline to 50%, and forecasts the right answer with several identities of its own. After settlement each of these identities has a positive relative score and qualifies in the short bucket. C pays little more than the registration fees: the bounty its identities collect and the entry fees they pay all move between C's own accounts. The bounty is far larger than the fees, so what is left in the pool is less than C's escrow and returns to C, the sponsor, in full; nothing is burned.
2. With borrowing: the parent "who wins the 2028 election?" is a long question, and nobody has long-bucket credit yet, so the short bucket is used instead. C's identities then count as qualified forecasters on the parent and can steer the median it shows.
3. Without borrowing: the credit C earned on the short question does not count on the parent, and the path is closed.

**Decision (the user answered "yes"):** a long question counts only credit earned on long questions; the rule that borrows short-bucket credit when the long bucket has no qualified forecaster is removed. Sub-markets can still be opened and still show their prices and results; they no longer affect the parent's number in any way. The Q2 wording approved in section 12.7 of the record already assumes this.

**Cost stated before the choice:** a long question has qualified forecasters only after other long questions settle and someone builds long-bucket credit. Until then, possibly for years, unfunded long questions show no number (given the answer to Q10). Funded long questions are unaffected, because they show the paid baseline.

## Round 3, 2026-11-22: Q19

### Five terms

- **Paid baseline**: on a funded question, the probability the contract computes at the end of each window. Moving it takes a stake, and a move in the wrong direction loses money.
- **Allowance**: the most that all forecasts together can fill in one window. The sponsor sets it in advance, and it falls from window to window.
- **Maker**: an agent that posts a price first and waits for others to buy. A maker that quotes off the baseline prices directly from it: with the baseline at 50%, for example, it sells YES at 53%.
- **Follow depth**: how many shares a maker is willing to sell at prices taken from the baseline.
- **Drag**: reporting a wrong probability on purpose, to push the baseline away from the true probability.

### Q19: what the contract publishes about the cost of dragging the baseline

Q19 was first about a sponsor that also trades. Since net losses are burned (section 12.6 of the record), a sponsor that drags the baseline of its own question pays too, so the published costs now concern anyone who drags the baseline, not only a sponsor that trades.

A funded question:

- This is the first of 18 windows. Its allowance is 1,000, and the allowance falls in equal steps, so the next window's is 1,000 × 17/18 = 944.4.
- The entry fee rate is 0.02%.
- The true probability and the baseline are both 50%.
- Maker K quotes off the baseline with a 3-point spread.
- A buyer pays a 1% trading fee on what it pays K, so a share bought at 43% costs 0.0043 more.
- M wants to buy YES cheaply.

```
Window t     M reports 40% and takes the whole allowance of 1,000      baseline 50% → 40%
             expected loss 1,000 × 0.1² = 10, entry fee 0.2
                │
                ▼
             K sells YES at 43%, off the new baseline
             M buys N shares: each is worth 0.50 on average, costs 0.43 and pays a fee of 0.0043
             expected gain 0.0657 a share
                │
                ▼
Window t+1   M reports 50% itself and takes the whole allowance of 944.4   baseline 40% → 50%
             expects to win back 944.4 × 0.1² ≈ 9.444, entry fee 0.189
```

What one drag costs M can be counted two ways:

- **Certain cost**: M drags the baseline and drags it back itself. It expects to pay 10 − 9.444 + 0.2 + 0.189, about 0.94. It is called certain because M makes both moves; the amount is still an average over the outcomes.
- **Cost with a counterparty**: an honest forecaster corrects the baseline in window t+1 instead. M does not win back the 9.444, and the cost is 10.20.

A maker cannot know in advance whether anyone will correct the next window, so it should count on the lower number, 0.94.

| K's follow depth | M's expected trading gain | After the certain cost of 0.94 |
| --- | --- | --- |
| 14 shares | 0.92 | about 0 |
| 136 shares (the review's "safe depth") | 8.94 | +8.0 |
| 500 shares (the most one identity may buy) | 32.85 | +31.9 |

- **Where 14 comes from**: the certain cost divided by what M gains per share, 0.94 ÷ 0.0657 ≈ 14. This is the safe depth. It is a break-even on average, not a guarantee, and it is the total across all makers that quote off the baseline, not the depth of each. It covers a mover without information; trading on real information is what the spread is for.
- **Another drag size does not help M**: across drags of 4 to 40 points, the one best for M (about 12.6 points) gives a safe depth of 13.8 shares, still about 14.
- **The review's 136 shares** were computed from the cost with a counterparty, about ten times too high.

**Options:**

- **(a) Publish one number, "what it costs to move the baseline 10 points".** If the number is 10.20, makers follow too deep; if it is 0.94, the cost when someone corrects the move does not show.
- **(b) Publish a "safe follow depth".** That is the review's 136 shares, about ten times too high.
- **(c) A read-only contract query returns the raw numbers and two computed costs.**
  - Raw numbers: this window's and the next window's allowances, the entry fee rate, how much of its allowance the last window filled, and when the allowance runs out. After that the baseline is frozen and no longer updates.
  - The two costs: the certain cost and the cost with a counterparty.
  - Each maker decides how deep to follow. The reference maker (the maker among the project's reference agents in `examples/agents`) sizes its depth by the certain cost: about 14 shares in this example.
- **(d) Stop recommending that makers use the baseline.**

**Decision (the user answered "yes"):** (c). The original two parts of Q19 stay: a bounty cannot be withdrawn once escrowed, and there are no identity rules, because addresses are anonymous and a ban cannot be enforced. (a) and (b) each give a single number, but that number depends on whether anyone corrects the next window; the two cases differ about tenfold, and the contract cannot know in advance which will happen. (c) sets out both and lets each maker judge. (d) would give up the baseline's use for trading altogether, even on questions with large allowances, where the baseline is more reliable.

**Costs stated before the choice:**

1. On questions with small allowances the baseline is nearly useless for quoting: all the makers together can follow about 14 shares when the first window's allowance is 1,000, and about 575 when it is 40,000.
2. Q26, as rewritten in section 12.7 of the record, says that information reaches trading indirectly through the baseline. On thinly traded questions that path is weak, and makers must rely on outside prices or their own models.
3. The contract gets one more read-only function, but no new parameters.

**What would change this:** if, once deployed, several independent forecasters reliably correct every window, the cost with a counterparty becomes the reasonable basis. Fake identities can make it look as if there are many, so relying on it is not recommended for now.

**How these numbers differ from the proposals:** Q19 in [the proposals](reopened-decisions-proposals.md) gives a certain cost of 1.0 at an allowance of 1,000, and 38.2 (about 580 shares) at 40,000, because it charges both entry fees at the first window's allowance. This example charges the second fee at the next window's allowance (944.4 and 37,777.8), which gives 0.94 and 37.78 (about 575 shares). The conclusions do not change.

## Round 4, 2026-11-22: Q21 and Q12

The first experiment (section 8 of the record) asks one thing: do several agents forecasting together beat one model? If they all use the same model and read the same news, the consensus is one model's answer, and the bounty of direction 3 (Mechanism R) pays for what a sponsor could get by running one model itself.

### Terms

- **Error**: (forecast − outcome)², lower is better (defined in round 1).
- **The four arms**: the same questions, forecast four ways.
  - Arm 1: one model, asked once.
  - Arm 2: the same model asked several times, averaged.
  - Arm 3: several different models, each asked once, averaged.
  - Arm 4: several different models, each with its own tools and data.
- **Independent information**: what one agent knows and the others do not, such as its own data source. Only the part by which arm 4 beats arm 2 counts as its contribution.
- **95% interval**: the range, worked out from the data, in which the true improvement most likely lies. More questions make it narrower.
- **Power**: the chance that the experiment proves a real improvement, meaning that the whole interval is above zero.
- **Smallest useful improvement**: a number registered before the experiment starts. An improvement smaller than it would not make direction 3 worth building.
- **Gate**: a pass-or-fail rule; if the experiment fails it, direction 3 is shelved.

**The rule recorded in section 8:** 8 weeks before resolution, arm 4's error must be at least 10% smaller than arm 1's, with an interval that excludes zero; if not, direction 3 is shelved.

### Example 1: against arm 1, the experiment mostly measures asking more than once

On a question whose true probability is 70%, a forecast p has an expected error of (p − 0.7)² + 0.21. The 0.21 comes from the question's own uncertainty, and nobody can remove it.

Assume the three arms do this well:

| Arm | Typical distance from the true probability | Expected error |
| --- | --- | --- |
| Arm 1: asked once | 12 points | 0.2244 |
| Arm 2: one model, averaged over runs | 7 points (the run-to-run noise cancels; the model's own bias stays) | 0.2149 |
| Arm 4: different models with their own data | 5 points (part of the different models' biases cancels too) | 0.2125 |

- Arm 4 beats arm 1 by 5.3%.
- Arm 2 adds no information, only more runs, and already beats arm 1 by 4.2%.
- The contribution of independent information is arm 4 against arm 2: 1.1%.

### Example 2: 10% is nearly out of reach

On the same question, a perfect forecaster who says 70% has an expected error of 0.21, and a model 10 points off, saying 80%, has 0.22. Even a perfect forecast is only 4.5% better. To be 10% better, the single model must be about 15 points off and arm 4 perfect (9.7%). The review's simulation over many questions (`scripts/q21.py`) agrees: with a single model 10 points off, the most anyone can improve is 4.8%.

### Example 3: 100 questions cannot tell "3.6% better" from "no better"

The proposals' assumptions: arm 2 is 10 points off, arm 4 is 5 points off, and their errors partly move together (a correlation of 0.5: when arm 2 is too high, arm 4 often is too), for example because both read the same wrong news. Arm 4 is then truly 3.6% better than arm 2.

| Questions | Typical 95% interval when arm 4 is 3.6% better | Chance the improvement is proven | Typical 95% interval when arm 4 is no better |
| --- | --- | --- | --- |
| 100 | −4.0% to +11.2% | 15% | −8.8% to +8.8% |
| 300 | −0.8% to +8.0% | 36% | −5.1% to +5.1% |
| 1,000 | +1.2% to +6.0% | 84% | −2.8% to +2.8% |

Each interval in the table is centred on the true improvement. A real experiment's interval is about as wide, but its centre moves from run to run, in 95 runs of 100 by less than half the width. So even at 1,000 questions with a true 3.6% improvement, a real interval includes zero 16% of the time, which is why the improvement is proven only 84% of the time.

At 100 questions the two cases give almost the same interval. The sample is also smaller than it looks: the main comparison is measured 8 weeks before resolution, and a question with a shorter horizon has not opened by then. With horizons spread evenly over 4 to 12 weeks, only about half of 100 questions count.

### What each rule does

| Rule | Arm 4 truly 3.6% better | Arm 4 no better |
| --- | --- | --- |
| (b) The review's: 100 questions, arm 4 against arm 2, passed only if the whole interval is above zero | shelved 85% of the time, wrongly | shelved 97% |
| (c) 100 questions; a smallest useful improvement registered first (2% here, as an example); shelved only if the interval's upper end is below it | shelved 1% | shelved 6% (so mostly kept, wrongly) |
| (d) Wait for 1,000 questions, then use (b)'s gate | shelved 16% | shelved 97% |

(a) keeps the current rule. Examples 1 and 2 show its problems: it compares the wrong arms, and 10% is nearly out of reach. In the review's simulation, even a true 8% improvement over arm 1 passes only 16% of the time with 100 questions.

With 100 questions, (b) and (c) mostly apply a default when the data cannot decide: (b) defaults to shelving, (c) to keeping. Only (d) actually separates the two cases.

### Q21: what the experiment compares and how its result is read

**Decision (the user accepted the recommendation):** (c).

- Main comparison: arm 4 against arm 2.
- Also reported: external market prices at the same time, the improvement per unit of inference cost, and how much the consensus worsens when one agent is left out (Mechanism R pays for exactly that).
- The experiment is an estimate, not a gate: the smallest useful improvement is registered first, and direction 3 is shelved only if the interval's upper end falls below it. The number is set when the experiment is scheduled; the 2% above is only an example.

Against arm 2 the experiment measures independent information, not more runs. At 100 questions nothing can separate 3.6% from 0; (b) would then shelve direction 3 by default, while (c) leaves it standing. Whether direction 3 enters the next contract generation also depends on the attack-scenario simulation of Q13.

**Costs stated before the choice:**

1. With 100 questions the experiment almost never shelves anything: even if arm 4 is no better, it shelves direction 3 only 6% of the time, and 28% of the time at 1,000 questions with a 2% threshold. It gives a rough number, not a verdict.
2. Q13's simulation tests attacks, not whether agents carry independent information. That premise may stay unknown until launch.
3. More arms cost more inference.

**What would change this:** if 1,000 questions are affordable, use (d) as a real verdict: with a true 3.6% improvement it passes 84% of the time, and with none it wrongly passes about 3%. (c) also allows adding questions later; more questions make the interval narrower.

### Q12: the experiment's main questions take only horizons of 8 to 12 weeks

**Decision (the user accepted the recommendation):** every main question in the experiment has a horizon of 8 to 12 weeks, so each one counts at the 8-week mark. A question with a shorter horizon has not opened 8 weeks before resolution. With 8 to 12 weeks all 100 main questions count, at no extra inference cost, and the main comparison still ends within 12 weeks. The few long questions with an external market price (section 8 of the record) were not part of this question and stay.

**Cost stated before the choice:** fewer candidate questions, since those of 4 to 8 weeks cannot be used. The errors 4 weeks and 1 week before resolution are still measured.

**How these numbers differ from what the user saw:** the conversation showed four of the figures above, from a smaller random simulation, as 98%, about 35%, about 7% and about 30%. The script computes them from a fixed seed as 97%, 36%, 6% and 28%. With no improvement, a 95% interval lies wholly above zero 2.5% of the time, so a gate shelves about 97.5% of the time; the conversation showed it as 98% and the script as 97%. The conversation also rounded the intervals to whole percents. The conclusions do not change.

## Round 5, 2026-11-22: Q7

Q7 asks whether collateral should earn interest. A long question locks money until it resolves, and the locked money earns nothing. The same money held elsewhere would earn interest.

### Terms

- **Collateral**: money locked in the contract until the question resolves. A forecaster that moves the baseline locks what it could lose; a sponsor deposits escrow.
- **Vault share**: what a vault that earns interest gives back for a stablecoin deposit. The number of shares stays the same, but each share redeems for more stablecoins as interest accrues. At 4% a year, a share worth 1.00 is worth 1.0816 after two years.
- **Generation**: the contracts cannot be upgraded, and their parameters are fixed at deployment, so a change means deploying a new generation.
- **Security bound**: the open payouts of all markets, times a security multiple of 2, may not exceed the cost of buying half the jurors' stake, which is half the jurors' staked value. Open payouts are therefore at most a quarter of that value. The contract checks the bound when a market is created and when a juror requests to unstake.

### Example: on a two-year question, interest decides whether forecasting pays

The example assumes 4% a year. The web research of 2026-11-16 ([prediction-markets-and-agent-commerce.md](prediction-markets-and-agent-commerce.md)) found that Polymarket's holding rewards pay 3.25% on designated markets and that Kalshi pays 3.50% a year on cash and positions; the script also shows both rates.

A question resolves in two years. The baseline is 50% and the true probability 60%. F reports 60% on the first window's whole allowance of 1,000:

```
F's expected payout   1,000 × 0.1² = 10
F locks               110 (what F loses if the answer is NO), until resolution in two years
Entry fee             0.20

No interest           the 110 would earn 8.98 elsewhere in two years → F keeps 10 − 0.20 − 8.98 = 0.82
Interest, (b)         the locked 110 is itself vault shares and keeps earning → F keeps 9.80, counted in shares
```

- The forgone interest is 90% of the expected payout. Without interest, F keeps 2.53 at 3.25% and 1.97 at 3.50%.
- With a 5-point edge (true probability and report both 55%), F expects 2.50, locks 52.50 and would earn 4.28 elsewhere. Without interest, F loses 1.98; with collateral in vault shares, it keeps 2.30.

### With vault shares, the security bound drifts

Payouts are counted in shares, and in stablecoins a share grows 8.2% over two years. The jurors stake a different token, whose value does not grow with it. So a market exactly at the bound when it is created is 8.2% over the bound two years later.

The contract checks the bound only when a market is created and when a juror requests to unstake. Open markets are not checked again between those events. By the next check, interest has used up part of the room:
- new markets are refused sooner;
- a juror is more likely to be unable to unstake.

### Q7: whether collateral earns interest

**Options:**

- **(a) No interest.** In the example F keeps 0.82, and with a 5-point edge it loses money. Long questions do not pay forecasters.
- **(b) The whole generation accounts in one vault share.**
  - Forecaster collateral, sponsor escrow, payouts and the security bound are all counted in shares.
  - Interest goes to the share holders: returned escrow carries interest, and so does a winner's payout.
  - The rule that a sponsor gets back no more than it deposited (Q25) counts shares. The extra stablecoins a sponsor receives are its own deposit's interest, not money taken from forecasters.
- **(c) No interest, but forecast positions can be transferred** (Q8's option c): a forecaster that wants out early sells its position.
- **(d) Each market chooses its collateral.** Payouts in different collateral cannot be added up, so the security bound cannot be computed.

**Decision (the user accepted the recommendation):** (b).
- The vault is chosen later.
- If none of the candidate vault contracts has acceptable permissions, the decision falls back to (c). That fallback makes forecast positions transferable, which Q8 (a) does not do, so it would reopen Q8 and make Q6 (merge) relevant again (section 12.5 of the record).

Why the other options were not chosen:
- Long questions are where this whole discussion started, and (a) gives them up.
- (c)'s exit needs a buyer, and thin long questions have none.
- (d) leaves the security bound uncomputable.

**Costs stated before the choice:**

1. "No external authority" cannot be met. The vault itself may be pausable or upgradable. If it is paused, the whole generation's funds are stuck, and the contracts have no admin to act. The user set aside a stablecoin issuer freezing funds as too extreme (section 12.5 of the record); a vault adds another layer of the same kind of risk.
2. A generation cannot change its collateral; changing it takes a new generation.
3. The security bound changes.
   - At creation it reserves room for the interest over the market's horizon, about 8% for two years.
   - It compares the juror token's value and the payouts in one unit.
   - Since the bound is also checked when a juror requests to unstake, the drift can block an unstake.
4. The testnet's bUSD earns nothing. The testnet can simulate interest with a mock vault that receives bUSD from time to time, but there is no real source of interest.
5. No vault is chosen yet. Reading each candidate vault contract's permissions comes later and can go to a subagent.

**Confidence:** low, as in the proposals.

**What would change this:** if no candidate vault has acceptable permissions, the decision falls back to (c).

**What was corrected before the user answered:** the presentation first said three things that were wrong:
- that the bound is checked only at creation;
- that open payouts must stay below half the jurors' staked value, leaving out the security multiple of 2 (the limit is a quarter);
- that the testnet could test the interface only with a zero-rate vault.

All three were corrected in the conversation before the user chose; the correction message counted the first two as one. The text above is the corrected version.

**What this document corrects:** the presentation gave the platforms' rates as about 3.25% to 4%. The web research of 2026-11-16 gives 3.25% and 3.50%. The example keeps 4% as an assumption, and at both of those rates F still keeps little without interest.

**How these numbers differ from the proposals:** the proposals say that a market that passes the check at creation is about a tenth over the bound two years later, which fits about 5% a year. At 4% it is 8.2%. The proposals also say the check is not redone; it is, whenever a juror requests to unstake.
