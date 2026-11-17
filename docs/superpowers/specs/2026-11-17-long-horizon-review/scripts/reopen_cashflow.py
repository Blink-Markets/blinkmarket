"""Cash flows, fee base, contests, flip values, Q16/Q19/Q21 numbers for the reopened decisions. Pure python.

ASSUMED parameters that are NOT in the repo (they are the reviewer's, kept for comparison, or mine and marked):
  inference 1 bUSD per window, gas 0.04 per window, discount/yield rate 5%/yr, missed-reveal chance 0.5% per window,
  18 monthly windows on a 24-month question, 5 rivals, edge d and own noise sigma as listed,
  entry fee 0.1% (reviewer) and 0.02% (mine), reference-maker spread 3%.
In the repo: registrationFee 10, feeBps 100, creatorShareBps 2500, maxMarketPairs 10000, maxTakerShares 500.
"""
import math, random

def w(p, b): return abs(p - b) * max(p + b, 2 - p - b)      # worst-case loss per unit exposure

# ---------------------------------------------------------------- 1. two-year cash flow
def record(total, n, d, sig, infer, r, phi, yield_bearing, p_miss, windows=18, months=24):
    """the reviewer's model, copied from rest.py: stake == exposure, budget split over declining windows"""
    wt = [windows - t for t in range(windows)]; Bs = [total * x / sum(wt) for x in wt]
    rev = sm = st = 0.0
    for t, B in enumerate(Bs):
        s = B / n; rev += s * (d * d - sig * sig); sm += s * (months - t); st += s
    carry = 0 if yield_bearing else sm * r / 12
    cost = infer * windows + 0.04 * windows + 10
    pv = rev / (1 + r) ** (months / 12)
    return dict(liq1=Bs[0], locked=st, rev=rev, pv=pv, sd=st * 2 * d * 0.5, cost=cost, fee=phi * st, carry=carry,
                miss=p_miss * st, net=pv - cost - phi * st - carry - p_miss * st)

def proposal(escrow, n, d, sig, infer, r, phi, yield_bearing, p_miss, windows=18, months=24, b0=0.5, flat=False, band=2.0, contest=False):
    """escrow X buys liquidity B1 = X / max(b0^2,(1-b0)^2) in window 1; liquidity never rises.
    collateral after reveal = exposure * w(b+d, b); posted at commit = exposure * w(b + band*d, b); a missed reveal forfeits the posted amount.
    fee = phi * requested exposure. contest=True: every rival requests the Tullock amount, capped at B_t per identity."""
    B1 = escrow / max(b0 * b0, (1 - b0) ** 2)
    Bs = [B1 if flat else B1 * (windows - t) / windows for t in range(windows)]
    D = d * d - sig * sig
    rev = fee = miss = coll = collm = expo = 0.0
    for t, B in enumerate(Bs):
        e = B / n
        x = e
        if contest and n > 1 and phi > 0:
            x = max(e, min(B, B * D * (n - 1) / (n * n * phi)))
        rev += e * D; fee += phi * x; expo += e
        c = e * w(0.5 + d, 0.5); coll += c; collm += c * (months - t)
        miss += p_miss * e * w(0.5 + band * d, 0.5)
    carry = 0 if yield_bearing else collm * r / 12
    cost = infer * windows + 0.04 * windows + 10
    pv = rev / (1 + r) ** (months / 12)
    return dict(liq1=B1, locked=coll, rev=rev, pv=pv, sd=expo * 2 * d * 0.5, cost=cost, fee=fee, carry=carry, miss=miss,
                net=pv - cost - fee - carry - miss, expo=expo)

def show(tag, r):
    print(f"   {tag}: window-1 liquidity {r['liq1']:,.0f}; own capital locked {r['locked']:,.0f}; expected revenue at FINAL {r['rev']:+.1f} (PV {r['pv']:+.1f}, sd ~{r['sd']:,.0f}); "
          f"costs: inference+gas+registration {r['cost']:.1f}, entry fees {r['fee']:.1f}, carry {r['carry']:.1f}, missed reveals {r['miss']:.1f} => expected net {r['net']:+.1f}")

print("== 1. Two-year question, sponsor money 10,000 unless stated. 'record' = the reviewer's model of the accepted design. ==")
scen = [
 ("A public-info LLM, 5 rivals, edge 5pt, noise 3pt, yield-bearing", (10_000, 5, 0.05, 0.03, 1.0, 0.05), True),
 ("B same, collateral bears no yield",                                (10_000, 5, 0.05, 0.03, 1.0, 0.05), False),
 ("C public-info LLM, edge 4pt, noise 7pt",                           (10_000, 5, 0.04, 0.07, 1.0, 0.05), True),
 ("D private data, edge 10pt, noise 2pt, 2 sharing",                  (10_000, 2, 0.10, 0.02, 1.0, 0.05), True),
 ("E private data, alone, sponsor 100,000",                           (100_000, 1, 0.10, 0.02, 1.0, 0.05), True),
 ("F creator-funded at the fee ceiling (12.5), alone",                (12.5, 1, 0.10, 0.02, 1.0, 0.05), True),
]
for name, a, yb in scen:
    print(name)
    show("record (fee 0.1% of stake, miss = whole stake)", record(*a, 0.001, yb, 0.005))
    show("proposal, fee 0.02% of request            ", proposal(*a, 0.0002, yb, 0.005))
    show("proposal, fee 0.1% of request             ", proposal(*a, 0.001, yb, 0.005))
    if a[1] > 1:
        show("proposal, fee 0.02%, rivals over-request (contest, capped at B per identity)", proposal(*a, 0.0002, yb, 0.005, contest=True))
    pr = proposal(*a, 0.0002, yb, 0.005)
    print(f"   sponsor under the proposal: escrow {a[0]:,.0f}, expected cost if all {a[1]} forecasters are as described = {a[1]*pr['rev']:,.1f} (the rest of the escrow returns at FINAL); "
          f"worst case {a[0]:,.0f}")
print("flat liquidity instead of declining (scenario A, fee 0.02%):")
show("flat", proposal(10_000, 5, 0.05, 0.03, 1.0, 0.05, 0.0002, True, 0.005, flat=True))
print("scenario A with a missed-reveal chance of 0.1% instead of 0.5% (anyone may submit the preimage):")
show("p_miss 0.1%", proposal(10_000, 5, 0.05, 0.03, 1.0, 0.05, 0.0002, True, 0.001))

print("\n== 1b. risk: one question is one draw. expected net / sd, and the number of INDEPENDENT questions for expected total = 2 sd ==")
for name, a, yb in scen[:5]:
    pr = proposal(*a, 0.0002, yb, 0.005)
    if pr['net'] > 0:
        ratio = pr['net'] / pr['sd']; print(f"  {name}: net/sd = {ratio:.4f} -> {math.ceil((2/ratio)**2):,} questions")
    else: print(f"  {name}: expected net is not positive")

print("\n== 1c. Kelly view per unit of collateral (b=0.5, report b+d, true probability b+d, no noise) ==")
for d in (0.05, 0.10, 0.20):
    p = 0.5 + d; win = (0.25 - (1 - p) ** 2) / w(p, 0.5); lose = 1.0
    mu = p * win - (1 - p) * lose; f = (p * win - (1 - p)) / win
    g = p * math.log(1 + f * win) + (1 - p) * math.log(1 - f)
    print(f"  edge {d:.2f}: win {win:+.3f} with prob {p:.2f}, lose -1; expected return on collateral {100*mu:.1f}%; Kelly share of bankroll {100*f:.1f}%; "
          f"growth per question {100*g:.3f}% of bankroll -> bankroll needed to cover 28.72 of fixed cost: {28.72/g:,.0f}")
print("  same edge bought at a FIXED price 0.5 on an order book (for comparison): growth = " + ", ".join(
      f"{d:.2f}: {100*((0.5+d)*math.log(1+2*d)+(0.5-d)*math.log(1-2*d)):.3f}%" for d in (0.05, 0.10, 0.20)))

# ---------------------------------------------------------------- 2. the position is a share purchase
print("\n== 2. identity: exposure e moved from b to p  ==  buying 2e(p-b) YES shares at the average price (b+p)/2 ==")
for e, b, p in [(1000, 0.5, 0.6), (8000, 0.5, 0.55), (1000, 0.7, 0.4)]:
    N = 2 * e * (p - b); price = (b + p) / 2
    for y in (1, 0):
        score = e * ((b - y) ** 2 - (p - y) ** 2); shares = N * (y - price)
        print(f"  e={e} b={b} p={p} y={y}: scoring-rule payout {score:+.2f}; {N:+.0f} shares at {price:.3f} pay {shares:+.2f}")

# ---------------------------------------------------------------- 3. sponsor side
print("\n== 3. escrow per unit of window-1 liquidity, by the opening baseline b0 (= max(b0^2,(1-b0)^2)) ==")
print("  " + ", ".join(f"b0={b0}: {max(b0*b0,(1-b0)**2):.4f}" for b0 in (0.5, 0.3, 0.2, 0.1, 0.05)))
print("== 3b. what flipping the outcome is worth (liquidity 1000, honest forecasters moved the baseline b0 -> b1) ==")
for b0, b1 in [(0.5, 0.6), (0.5, 0.9), (0.2, 0.05)]:
    yes = 1000 * ((b0 - 1) ** 2 - (b1 - 1) ** 2); no = 1000 * (b0 ** 2 - b1 ** 2)
    v1 = abs(max(yes, 0) - max(no, 0)); v2 = abs(yes - no)
    print(f"  {b0}->{b1}: forecasters get {yes:+.0f} if YES, {no:+.0f} if NO. Sponsor's gain from choosing the outcome: record/'burn the losses' {v1:.0f}; 'losses return to the sponsor' {v2:.0f}; "
          f"forecasters' own gain from choosing it {v2:.0f}; proposed bound counts 2*e*|p-b| = {2*1000*abs(b1-b0):.0f}")

# ---------------------------------------------------------------- 4. fee base and pinning
print("\n== 4. pinning (honest requests B at 0.7, baseline 0.5, B=1000): what the pinner pays under each fee base ==")
for mult in (4, 9, 19, 99):
    k = 1 / (1 + mult)
    print(f"  pin request {mult}xB: honest fill {100*k:.0f}%, baseline -> {0.5+0.2*k:.3f}; pinner pays: fee on stake/request at 0.2% = {0.002*mult*1000:.1f}; "
          f"fee on FILLED exposure at 0.2% = {0.002*1000*(1-k):.2f} (never more than {0.002*1000:.0f}); honest pays on request {0.002*1000:.1f} vs on fill {0.002*1000*k:.2f}")
print("== 4b. over-request contest: share of the forecasters' expected rent that ends up in fees = min((n-1)/n, n*phi/D) with the cap x<=B ==")
for n, D, phi in [(5, 0.0016, 0.001), (5, 0.0016, 0.0002), (5, 0.0096, 0.0002), (2, 0.0096, 0.0002), (10, 0.0016, 0.0002), (5, 0.0016, 0.00005)]:
    print(f"  n={n} D={D} phi={phi}: {100*min((n-1)/n, n*phi/D):.0f}%   (without the per-identity cap: {100*(n-1)/n:.0f}% whenever the window is over-subscribed)")
print("== 4c. smallest edge worth reporting when the fee is phi per unit of exposure: d > sqrt(phi) ==")
print("  " + ", ".join(f"phi={phi}: {100*math.sqrt(phi):.1f} points" for phi in (0.00005, 0.0002, 0.001, 0.002)))

# ---------------------------------------------------------------- 5. Q19 floor
print("\n== 5. Q19: what a temporary drag of delta is CERTAIN to cost (nobody else corrects) vs what it costs if rivals take the correction ==")
c = 0.034
for B, steps, phi in [(1000, 18, 0.0002), (40000, 18, 0.0002), (40000, 18, 0.001), (40000, 1e9, 0.0002)]:
    dB = B / steps
    for delta in (0.10, 0.20):
        floor = dB * delta ** 2 + 2 * phi * B
        print(f"  liquidity {B:,.0f}, next window lower by {dB:,.0f}, fee {phi}: drag {delta:.2f}: certain cost {floor:,.1f}, contested cost {B*delta**2:,.0f}; "
              f"shares a maker can sell off the dragged baseline before the certain cost is covered: {floor/(delta-c):,.0f} (contested: {B*delta**2/(delta-c):,.0f})")

# ---------------------------------------------------------------- 6. Q16
print("\n== 6. Q16: what a creator can fund from the fee share (cap 12.5-25 bUSD) ==")
for rec in (12.5, 25.0):
    B = rec / 0.25
    print(f"  recoverable {rec}: as escrow at b0=0.5 it buys liquidity {B:.0f}; a lone forecaster with a 10-point edge earns {B*0.01:.2f} per window, with a 5-point edge {B*0.0025:.3f}; inference is assumed at 1.00")

# ---------------------------------------------------------------- 7. Q21 power, arm 4 against arm 2
print("\n== 7. Q21: power of 'arm 4 beats arm 2' (paired, 95% interval excludes zero); errors of the two arms share a common part ==")
random.seed(5)
def clip(x): return min(0.99, max(0.01, x))
def one(N, s2, s4, rho):
    dif = []
    for _ in range(N):
        q = min(0.95, max(0.05, random.betavariate(1.2, 1.2))); y = 1 if random.random() < q else 0
        z = random.gauss(0, 1); e2 = s2 * z; e4 = s4 * (rho * z + math.sqrt(1 - rho * rho) * random.gauss(0, 1))
        dif.append((clip(q + e2) - y) ** 2 - (clip(q + e4) - y) ** 2)
    m = sum(dif) / N; sd = math.sqrt(sum((x - m) ** 2 for x in dif) / (N - 1))
    return m, sd / math.sqrt(N)
for s2, s4 in [(0.10, 0.05), (0.14, 0.07), (0.10, 0.10)]:
    m, _ = one(300000, s2, s4, 0.5); mb = sum(1 for _ in range(1)) and None
    bri = 0.0
    for _ in range(200000):
        q = min(0.95, max(0.05, random.betavariate(1.2, 1.2))); y = 1 if random.random() < q else 0
        bri += (clip(q + random.gauss(0, s2)) - y) ** 2
    bri /= 200000
    line = f"  arm-2 error sd {s2}, arm-4 error sd {s4}: true Brier gain {m:+.4f} = {100*m/bri:.1f}% of arm 2's Brier;"
    for N in (50, 100, 300, 1000, 3000):
        T = 600; ok = 0
        for _ in range(T):
            mm, se = one(N, s2, s4, 0.5); ok += (mm - 1.96 * se > 0)
        line += f" N={N}: {100*ok/T:.0f}%"
    print(line)
print("  (the third row is the false-positive check: equal arms should pass about 2.5% of the time)")
