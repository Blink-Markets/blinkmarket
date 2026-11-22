"""Numbers for reconfirmed-decisions-worked-examples.md and its zh-TW version. Pure Python, no packages.

Round 1 of the re-confirmation (discussion record 12.8, 2026-11-22):
  Q9  - why credit is a pass-or-fail threshold and not a weight, and why it is scored against
        a paid baseline (the free-consensus sybil example).
  Q16 - what a creator can recover from fees, and what an escrow of that size supports.
Binomial sums are computed in log space, so a large n does not overflow.
Run from this folder: python3 -I reconfirmed_examples.py
"""
from decimal import ROUND_HALF_UP, Decimal
from math import exp, lgamma, log, sqrt


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
