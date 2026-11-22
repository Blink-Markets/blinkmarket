# Re-confirming the provisional decisions with worked examples

[繁體中文](reconfirmed-decisions-worked-examples.zh-TW.md)

Most of the 21 cards chosen on the decision board on 2026-11-18 were chosen by following the assistant's recommendations. Section 12.5 of the record keeps them as the working direction, to be confirmed once each mechanism is explained with a worked example. This document collects those examples, one round at a time. Each section holds what the user saw before choosing: the example, the recommendation and the cost. The outcome is recorded in section 12.8 and later sections of [the discussion record](../2026-11-16-long-horizon-forecasting-discussion.md). The numbers come from [`scripts/reconfirmed_examples.py`](scripts/reconfirmed_examples.py), and the terms follow [the Mechanism R example](mechanism-r-worked-example.md). Nothing here is implemented.

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
