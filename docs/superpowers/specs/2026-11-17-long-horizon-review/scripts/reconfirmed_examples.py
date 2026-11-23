"""Numbers for reconfirmed-decisions-worked-examples.md and its zh-TW version. Pure Python, no packages.

Round 1 of the re-confirmation (discussion record 12.8, 2026-11-22):
  Q9  - why credit is a pass-or-fail threshold and not a weight, and why it is scored against
        a paid baseline (the free-consensus sybil example).
  Q16 - what a creator can recover from fees, and what an escrow of that size supports.
Round 2 (discussion record 12.9, 2026-11-22):
  Q10 - what an unfunded question shows: plain mean, median, and the qualified median.
  Q20 has no numbers.
Round 3 (discussion record 12.10, 2026-11-22):
  Q19 - the certain cost of dragging the paid baseline and dragging it back, the cost when someone
        else corrects it, and how deep a maker that quotes off the baseline can safely follow.
Round 4 (discussion record 12.11, 2026-11-22):
  Q21 - why arm 4 is compared with arm 2, why a 10% improvement is nearly out of reach, and what 100, 300
        and 1,000 questions can tell, under the proposals' model with a fixed seed and a normal approximation.
Round 5 (discussion record 12.12, 2026-11-22):
  Q7  - what interest on collateral is worth to a forecaster on a two-year question, and how far a market at
        the security bound drifts when payouts are counted in vault shares.
Binomial sums are computed in log space, so a large n does not overflow.
Run from this folder: python3 -I reconfirmed_examples.py
"""
from decimal import ROUND_HALF_UP, Decimal
from math import erf, exp, lgamma, log, sqrt
from random import Random
from statistics import median


def m(x, sign=False):  # an amount in bUSD, rounded half up to cents once float noise is removed
    d = Decimal(repr(round(x, 9))).quantize(Decimal("0.01"), ROUND_HALF_UP)
    return f"{d:+,.2f}" if sign else f"{d:,.2f}"


def r4(x, sign=False):  # a score or probability, rounded half up to four places
    d = Decimal(repr(round(x, 12))).quantize(Decimal("0.0001"), ROUND_HALF_UP)
    return f"{d:+}" if sign else f"{d}"


def L(p, y):  # Brier loss; y = 1 for YES, 0 for NO
    return (p - y) ** 2


def relative(b, p, y):  # relative score: the baseline's loss minus the forecaster's loss
    return L(b, y) - L(p, y)


def log_choose(n, k):
    return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1)


def prob_total_positive(n, q, up, down):
    """Exact chance that the total over n independent questions is above zero.
    k YES results give k*up + (n-k)*down (down is negative); sums are done in log space."""
    total = 0.0
    for k in range(n + 1):
        if k * up + (n - k) * down > 1e-12:
            total += exp(log_choose(n, k) + k * log(q) + (n - k) * log(1 - q))
    return total


print("== Q9: a forecaster whose report p equals the true probability q = 0.55, baseline b = 0.5 ==")
b, q = 0.5, 0.55
up, down = relative(b, q, 1), relative(b, q, 0)
print(f"  baseline loss {L(b, 1):.4f}; forecaster loss {L(q, 1):.4f} (YES) / {L(q, 0):.4f} (NO)")
print(f"  relative score: {r4(up, True)} if YES, {r4(down, True)} if NO")
mean = q * up + (1 - q) * down
sd = sqrt(q * up ** 2 + (1 - q) * down ** 2 - mean ** 2)
print(f"  mean {r4(mean)}, standard deviation {r4(sd)}, sd / mean = {sd / mean:.1f}")
need = (2 * sd / mean) ** 2
print(f"  questions for the mean to reach two standard errors: (2 x sd / mean)^2 = {need:,.0f}")
for n in (50, 1600):
    print(f"  chance the total over {n:,} questions is positive: {r4(prob_total_positive(n, q, up, down))}")

print("\n== Q9: free consensus dragged to c = 0.01; main identity reports 0.5, true probability 0.5 ==")
c, p, q2 = 0.01, 0.5, 0.5
gain = q2 * relative(c, p, 1) + (1 - q2) * relative(c, p, 0)
print(f"  expected relative score per question against the free consensus: {r4(gain)}")
print(f"  that is {gain / mean:.2f} times the honest 5-point edge of {r4(mean)}")

print("\n== Q16: what the creator can recover from fees, and what the escrow supports ==")
FEE, SHARE, PAIRS = 0.01, 0.25, 10_000
for price in (1.0, 0.5):
    print(f"  taker pays {price} per pair: creator recovers at most {PAIRS:,} x {price} x {FEE:.0%} x {SHARE:.0%} "
          f"= {m(PAIRS * price * FEE * SHARE)}")
X = 12.50
allowance = X / 0.25  # escrow = allowance x max(b0^2, (1 - b0)^2); at b0 = 0.5 that factor is 0.25
print(f"  escrow {m(X)} supports a first-window allowance of {m(X)} / 0.25 = {m(allowance)}")
for edge in (0.10, 0.05):
    print(f"  edge {edge * 100:.0f} points, whole allowance taken: expects {allowance:.0f} x {edge}^2 = "
          f"{allowance * edge ** 2:.3f} per window")

print("\n== Q10 (round 2): an unfunded question with three agents and four new identities ==")
agents = [0.62, 0.58, 0.60]
sybils = [0.05] * 4
everyone = agents + sybils
REGISTRATION, DEPOSIT = 10, 100  # bUSD per identity; the deposit is refundable
print(f"  four new identities cost {len(sybils) * REGISTRATION} bUSD in registration fees "
      f"plus {len(sybils) * DEPOSIT} bUSD of refundable deposits")
print(f"  plain mean of all seven: {sum(everyone) / len(everyone):.1%}")
print(f"  median of all seven: {median(everyone):.0%}")
print(f"  median of the three qualified agents: {median(agents):.0%}")

print("\n== Q19 (round 3): drag the paid baseline, buy from a maker that quotes off it, drag it back ==")
WINDOWS = 18  # the allowance falls in equal steps over 18 windows
PHI = 0.0002  # entry fee rate, charged on the requested exposure
SPREAD, TRADE_FEE = 0.03, 0.01  # maker K's spread off the baseline; the taker's 1% trading fee
BASE, TRUE_P = 0.5, 0.5  # the baseline before the drag, and the true probability


# bt is the first window's allowance; with equal steps the second window gets (WINDOWS - 1) / WINDOWS of it
def next_allowance(bt):
    return bt * (WINDOWS - 1) / WINDOWS


def expected_relative(b, p, q):  # expected relative score per unit of exposure when the true probability is q
    return q * relative(b, p, 1) + (1 - q) * relative(b, p, 0)


def gain_per_share(d):  # M's expected gain on each YES share bought from K after a drag of d
    price = BASE - d + SPREAD
    return TRUE_P - price - TRADE_FEE * price


def certain_cost(bt, d):  # M drags the baseline in window t and drags it back itself in window t+1
    bn = next_allowance(bt)
    drag = bt * expected_relative(BASE, BASE - d, TRUE_P)
    back = bn * expected_relative(BASE - d, BASE, TRUE_P)
    return -(drag + back) + PHI * (bt + bn)


def contested_cost(bt, d):  # someone else drags it back in window t+1
    return -bt * expected_relative(BASE, BASE - d, TRUE_P) + PHI * bt


bt, d = 1_000.0, 0.10
bn = next_allowance(bt)
print(f"  allowance {bt:,.1f} in the first window and {bn:,.1f} in the second; drag {d * 100:.0f} points")
print(f"  window t:   M reports {BASE - d:.0%}, expected loss {-bt * expected_relative(BASE, BASE - d, TRUE_P):.3f}, "
      f"entry fee {PHI * bt:.3f}")
print(f"  window t+1: M reports {BASE:.0%}, expected gain {bn * expected_relative(BASE - d, BASE, TRUE_P):.3f}, "
      f"entry fee {PHI * bn:.3f}")
per = gain_per_share(d)
print(f"  K sells YES at {BASE - d + SPREAD:.2f}; M expects {per:.4f} a share")
certain = certain_cost(bt, d)
print(f"  certain cost {certain:.4f}; cost with a counterparty {contested_cost(bt, d):.4f}")
for n, label in ((round(certain / per), "certain cost / gain per share"), (136, "the review's safe depth"),
                 (500, "the cap per identity")):
    print(f"  {n:>3} shares ({label}): gain {m(n * per)}, after the certain cost {m(n * per - certain, True)}")
print(f"  safe depth, the total across all makers that quote off the baseline: {certain:.4f} / {per:.4f} = "
      f"{certain / per:.1f} shares")
drags = [i / 1000 for i in range(40, 401)]
best = min(drags, key=lambda x: certain_cost(bt, x) / gain_per_share(x))
print(f"  smallest safe depth over drags of 4 to 40 points: {certain_cost(bt, best) / gain_per_share(best):.1f} shares "
      f"(at {best * 100:.1f} points)")
big = 40_000.0
print(f"  first-window allowance {big:,.0f}: certain cost {certain_cost(big, d):.2f}, "
      f"safe depth {certain_cost(big, d) / per:.0f} shares")
print("  the proposals charge both entry fees at this window's allowance:")
for B in (bt, big):
    alt = certain_cost(B, d) + PHI * (B - next_allowance(B))
    print(f"    allowance {B:,.0f}: certain cost {alt:.1f}")

print("\n== Q21 (round 4): which arms to compare, and what 100 questions can tell ==")
Q = 0.70  # one question's true probability
print(f"  forecast p on a question whose true probability is {Q:.0%}: expected error = (p - {Q})^2 + {Q * (1 - Q):.2f}")
ARMS = {1: 0.12, 2: 0.07, 4: 0.05}  # assumed typical distance from the true probability (root mean square), per arm
err = {arm: off ** 2 + Q * (1 - Q) for arm, off in ARMS.items()}
for arm, off in ARMS.items():
    print(f"  arm {arm}: {off * 100:.0f} points off -> expected error {err[arm]:.4f}")
for better, worse in ((4, 1), (2, 1), (4, 2)):
    print(f"  arm {better} against arm {worse}: {(err[worse] - err[better]) / err[worse]:.1%} better")
for off in (0.10, 0.15):
    print(f"  a perfect forecast against one {off * 100:.0f} points off: "
          f"{off ** 2 / (Q * (1 - Q) + off ** 2):.1%} better")


def norm_cdf(x):  # standard normal distribution function
    return 0.5 * (1 + erf(x / sqrt(2)))


def clip(x):
    return min(0.99, max(0.01, x))


def arms_2_and_4(sd2, sd4, draws=400_000, seed=21, corr=0.5):
    """The proposals' model: true probabilities spread over 0.05 to 0.95, and normal forecast errors, with
    arm 4's error correlated `corr` with arm 2's. Returns arm 2's mean error, and the mean and standard
    deviation of arm 2's error minus arm 4's on one question."""
    rng = Random(seed)
    total2 = total = total_sq = 0.0
    for _ in range(draws):
        q = min(0.95, max(0.05, rng.betavariate(1.2, 1.2)))
        y = 1 if rng.random() < q else 0
        z = rng.gauss(0, 1)
        e4 = sd4 * (corr * z + sqrt(1 - corr ** 2) * rng.gauss(0, 1))
        b2, b4 = (clip(q + sd2 * z) - y) ** 2, (clip(q + e4) - y) ** 2
        total2 += b2
        total += b2 - b4
        total_sq += (b2 - b4) ** 2
    mean = total / draws
    return total2 / draws, mean, sqrt(total_sq / draws - mean ** 2)


MIN_USEFUL = 0.02  # an example of the smallest useful improvement, as a share of arm 2's error
for label, sd4 in (("arm 4 is better", 0.05), ("arm 4 is no better", 0.10)):
    error2, improvement, sd_diff = arms_2_and_4(0.10, sd4)
    print(f"  {label} (arm 2 is 10 points off, arm 4 {sd4 * 100:.0f}, errors correlated 0.5): "
          f"true improvement {improvement / error2:.1%} of arm 2's error {error2:.4f}")
    for n in (100, 300, 1_000):
        se = sd_diff / sqrt(n)
        # an interval centred on the true improvement; a real experiment's interval moves around it
        low, high = (improvement - 1.96 * se) / error2, (improvement + 1.96 * se) / error2
        proven = norm_cdf(improvement / se - 1.96)  # the whole interval is above zero
        shelved_c = norm_cdf((MIN_USEFUL * error2 - improvement) / se - 1.96)  # the upper end is below the threshold
        print(f"    {n:>5,} questions: typical interval {low:+.1%} to {high:+.1%}; improvement proven {proven:.0%}; "
              f"shelved by a gate {1 - proven:.0%}, by rule (c) {shelved_c:.0%}")

print("\n== Q7 (round 5): what interest on collateral is worth on a two-year question ==")
RATE, YEARS = 0.04, 2  # an assumed yearly rate, and the years until the question resolves
EXPOSURE = 1_000.0  # F takes the first window's whole allowance
growth = (1 + RATE) ** YEARS  # what one vault share worth 1 today is worth at resolution
print(f"  one vault share after {YEARS} years at {RATE:.0%}: {growth:.4f}")


def held_to_resolution(edge, rate=RATE):  # F reports the true probability, edge above a 50% baseline
    fair = 0.5 + edge
    payout = EXPOSURE * expected_relative(0.5, fair, fair)
    locked = -EXPOSURE * relative(0.5, fair, 0)  # what F loses on NO, locked until resolution
    forgone = locked * ((1 + rate) ** YEARS - 1)  # what the locked stake would earn elsewhere
    return payout, locked, forgone


fee = PHI * EXPOSURE
for edge in (0.10, 0.05):
    payout, locked, forgone = held_to_resolution(edge)
    print(f"  F reports the true probability {0.5 + edge:.0%} against a 50% baseline: expected payout "
          f"{m(payout)}, locked {m(locked)}, entry fee {m(fee)}")
    print(f"    the locked stake would earn {m(forgone)} elsewhere; F keeps {m(payout - fee - forgone, True)} "
          f"without interest and {m(payout - fee, True)} with collateral in vault shares")
payout, locked, forgone = held_to_resolution(0.10)
print(f"  forgone interest as a share of the expected payout: {forgone / payout:.0%}")
for rate in (0.0325, 0.035):  # Polymarket's holding rewards and Kalshi's rate in the 2026-11-16 web research
    forgone_at = held_to_resolution(0.10, rate)[2]
    print(f"  at {rate:.2%} a year: forgone {m(forgone_at)}, F keeps {m(payout - fee - forgone_at, True)} "
          f"without interest")
print(f"  payouts in vault shares grow {growth - 1:.1%} in stablecoin terms over {YEARS} years, and the jurors' "
      f"stake does not: a market exactly at the security bound at creation is that much over it at resolution")
