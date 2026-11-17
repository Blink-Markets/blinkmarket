"""Repaired bounty mechanism: property checks. Pure python, no deps.

Model R (the proposal under test):
  window t has liquidity B_t (set by schedule, NON-INCREASING), baseline b (probability).
  forecaster i commits requested exposure x_i and a sealed report p_i.
  fill ratio k = min(1, B_t / sum(x));  exposure e_i = k * x_i;  E = sum(e_i) <= B_t.
  payout_i at FINAL with outcome y:  e_i * ((b - y)^2 - (p_i - y)^2)   (negative = taken from collateral)
  collateral locked to FINAL: e_i * w(p_i, b),  w = |p-b| * max(p+b, 2-p-b)  (the worst-case loss per unit)
  entry fee: phi * x_i (on REQUESTED exposure, non-refundable, to treasury)
  new baseline: b' = b + (E / B_t) * (m - b),  m = exposure-weighted mean report.
  No roll-over. Slashes are netted inside the question at FINAL.
"""
import random, math

def L(p, y): return (p - y) ** 2
def w(p, b): return abs(p - b) * max(p + b, 2 - p - b)

def window(b, B, bets):
    """bets: list of (x, p, owner). returns new baseline, list of (owner, e, p), E"""
    S = sum(x for x, _, _ in bets)
    if S == 0 or B <= 0: return b, [], 0.0
    k = min(1.0, B / S)
    fills = [(o, x * k, p) for x, p, o in bets]
    E = S * k
    m = sum(x * p for x, p, _ in bets) / S
    return b + (E / B) * (m - b), fills, E

def exp_pay(fills, b, q):
    out = {}
    for o, e, p in fills:
        out[o] = out.get(o, 0.0) + e * ((b - q) ** 2 - (p - q) ** 2)
    return out

random.seed(3)
print("== T1. Sponsor's total NET outlay over all windows is <= B_1 * L(b_0, y), whatever anyone does (non-increasing B) ==")
worst_ratio = -1e9; viol = 0; trials = 40000
for _ in range(trials):
    T = random.randint(1, 12)
    B1 = 1000.0
    Bs = sorted([B1 * random.random() for _ in range(T - 1)] + [B1], reverse=True)
    b0 = random.uniform(0.02, 0.98); b = b0
    net = {0: 0.0, 1: 0.0}
    for B in Bs:
        n = random.randint(0, 5)
        bets = [(random.random() * 2 * B, random.random(), i) for i in range(n)]
        nb, fills, E = window(b, B, bets)
        for y in (0, 1):
            net[y] += sum(e * (L(b, y) - L(p, y)) for _, e, p in fills)
        b = nb
    for y in (0, 1):
        bound = B1 * L(b0, y)
        worst_ratio = max(worst_ratio, net[y] - bound)
        if net[y] > bound + 1e-9: viol += 1
print(f"  {trials} random multi-agent paths: violations of the bound = {viol}; max (net outlay - bound) = {worst_ratio:.6f} (<= 0 means the bound held)")
print("  so an escrow of B_1 * max(b_0^2, (1-b_0)^2) is always enough: 0.25 * B_1 when b_0 = 0.5")

print("\n== T1b. the same bound FAILS if liquidity may rise (this is the drag-then-correct profit) ==")
b0 = 0.5
b1, f1, _ = window(b0, 100, [(100, 0.01, 'A')])
b2, f2, _ = window(b1, 1100, [(1100, 0.5, 'A')])
for y in (0, 1):
    net = sum(e * (L(b0, y) - L(p, y)) for _, e, p in f1) + sum(e * (L(b1, y) - L(p, y)) for _, e, p in f2)
    print(f"  liquidity 100 -> 1100, drag to 0.01 then back to 0.5: net paid to the attacker if y={y}: {net:+.1f}  (bound with B_1=100 would be {100*L(b0,y):.1f})")

print("\n== T2. drag-then-correct, attacker alone, truth = starting baseline, declining liquidity, no roll-over: random search ==")
def run(Bs, acts, q, b0):
    b, tot = b0, 0.0
    for B, (frac, p) in zip(Bs, acts):
        if frac <= 0: continue
        nb, fills, _ = window(b, B, [(frac * B, p, 'A')])
        tot += exp_pay(fills, b, q)['A']; b = nb
    return tot
Bs = [1000, 900, 800, 700, 600, 500]
best = -1e9
for _ in range(300000):
    acts = [(random.choice([0, 0, random.random(), 1.0, 3.0]), random.choice([0.5, random.uniform(0.01, 0.99)])) for _ in Bs]
    v = run(Bs, acts, 0.5, 0.5)
    if v > best: best, ba = v, acts
print(f"  best expected profit found over 300,000 six-window strategies: {best:.6f} (the record's roll-over version gave +600)")

print("\n== T2b. same search, but truth q=0.6 and baseline starts at 0.5: is anything better than 'report 0.6 at full exposure in window 1'? ==")
honest = run(Bs, [(1.0, 0.6)] + [(0, 0.5)] * 5, 0.6, 0.5)
best = -1e9
for _ in range(300000):
    acts = [(random.choice([0, random.random(), 1.0, 1.0, 3.0]), random.choice([0.6, random.uniform(0.01, 0.99)])) for _ in Bs]
    v = run(Bs, acts, 0.6, 0.5)
    if v > best: best, ba = v, acts
print(f"  honest-at-once = {honest:.4f}; best found = {best:.4f}  (difference {best - honest:+.6f})")

print("\n== T3. partial-exposure drag then full-exposure correct (closed form check): net = E*d^2*(B2*E/B1^2 - 1) ==")
for B1, B2, E, d in [(1000, 1000, 100, 0.3), (1000, 900, 1000, 0.49), (1000, 1000, 1000, 0.49), (1000, 1000, 500, 0.2)]:
    b1, f1, _ = window(0.5, B1, [(E, 0.5 - d, 'A')])
    l = exp_pay(f1, 0.5, 0.5)['A']
    b2, f2, _ = window(b1, B2, [(B2, 0.5, 'A')])
    g = exp_pay(f2, b1, 0.5)['A']
    print(f"  B1={B1} B2={B2} drag exposure={E} by {d:.2f}: loss {l:+.2f}, correction gain {g:+.2f}, net {l+g:+.2f}")

print("\n== T4. top-ups ==")
def topup_attack(B1, B2_sched, add, flatten_only):
    B2 = min(B1, B2_sched + add) if flatten_only else B2_sched + add
    b1, f1, _ = window(0.5, B1, [(B1, 0.01, 'A')])
    l = exp_pay(f1, 0.5, 0.5)['A']
    b2, f2, _ = window(b1, B2, [(B2, 0.5, 'A')])
    return l, exp_pay(f2, b1, 0.5)['A'], B2
for fo in (False, True):
    for B1, B2s, add in [(100, 90, 1000), (1000, 900, 3000)]:
        l, g, B2 = topup_attack(B1, B2s, add, fo)
        print(f"  {'flatten-only (new liquidity capped at the last closed window)' if fo else 'top-up may raise liquidity'}: "
              f"B1={B1}, scheduled B2={B2s}, top-up {add} -> B2={B2:.0f}: drag loss {l:+.1f}, correction gain {g:+.1f}, net {l+g:+.1f}")

print("\n== T5. splitting identities inside one window (random search, same total request) ==")
worst = -1e9
for _ in range(200000):
    b, q, B = random.random(), random.random(), 1000
    n = random.randint(2, 5)
    bets = [(random.random() * 800, random.random(), 'A') for _ in range(n)]
    rival = [(random.random() * 1500, random.random(), 'R')] if random.random() < 0.5 else []
    S = sum(x for x, _, _ in bets)
    _, f, _ = window(b, B, bets + rival)
    _, f1, _ = window(b, B, [(S, q, 'A')] + rival)
    worst = max(worst, exp_pay(f, b, q).get('A', 0) - exp_pay(f1, b, q).get('A', 0))
print(f"  max (coalition - one honest report with the same total request): {worst:.6f}")

print("\n== T6. informed monopolist (edge 0.10): expected pay by the window in which it reports, declining liquidity, no roll-over ==")
Bs10 = [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100]
print("  " + ", ".join(f"w{t+1}:{B*0.01:.1f}" for t, B in enumerate(Bs10)) + "   (the record's roll-over version rose from 10 to 55)")
drip = 0.0; b = 0.5
for B in Bs10[:5]:
    nb, f, _ = window(b, B, [(B, b + 0.02, 'A')]); drip += exp_pay(f, b, 0.6)['A']; b = nb
print(f"  dripping the same 10 points as five 2-point steps over windows 1-5: {drip:.2f} (reporting at once in window 1: 10.00)")

print("\n== T7. where the sponsor's money goes: three settlement rules, one forecaster, exposure 1000 ==")
print("  V0 = record (winners paid gross by sponsor, losers' slashes to treasury); V1 = net inside the question, a negative net is burned; V2 = net, a negative net goes to the sponsor")
for b, q in [(0.5, 0.6), (0.5, 0.55), (0.5, 0.8)]:
    yes = 1000 * (L(b, 1) - L(q, 1)); no = 1000 * (L(b, 0) - L(q, 0))
    fore = q * yes + (1 - q) * no
    v0 = q * max(yes, 0) + (1 - q) * max(no, 0)
    v1 = v0                                   # one forecaster: nothing to net against
    v2 = fore
    print(f"  b={b} q={q}: forecaster expected net {fore:.1f}; sponsor expected cost V0={v0:.1f} V1={v1:.1f} V2={v2:.1f}; share of sponsor cost not reaching forecasters V0/V1={100*(v0-fore)/v0:.0f}% V2=0%")

print("\n== T8. pinning with an entry fee on REQUESTED exposure (honest: request B, report 0.7; baseline 0.5; truth 0.7) ==")
for B in (1000, 40000):
    for mult in (0, 4, 9, 19):
        for phi in (0.0002, 0.001):
            bets = [(B, 0.7, 'H')] + ([(mult * B, 0.5, 'P')] if mult else [])
            nb, f, _ = window(0.5, B, bets)
            h = exp_pay(f, 0.5, 0.7)['H'] - phi * B
            print(f"  B={B} pin request={mult}xB fee={phi}: baseline -> {nb:.3f}; honest net {h:+.1f}; pinner pays {phi*mult*B:.1f}; pinner collateral at risk {sum(e*w(p,0.5) for o,e,p in f if o=='P'):.1f}")
print("  persistent pin at 9xB every window, honest forecaster keeps reporting 0.7: share of the gap closed after n windows")
print("  " + ", ".join(f"n={n}:{100*(1-0.9**n):.0f}%" for n in (1, 3, 6, 12, 18)))

print("\n== T9. missed reveal: break-even miss probability = expected gain / amount lost on a miss ==")
for d in (0.05, 0.10, 0.20):
    full = d * d / 1.0
    wc = d * d / w(0.5 + d, 0.5)
    print(f"  edge {d:.2f}: record (lose the whole stake = exposure) tolerates {100*full:.2f}% misses per window; proposal (lose the posted worst-case collateral) tolerates {100*wc:.1f}%")

print("\n== T10. Q19 with the repaired mechanism: cost of a temporary drag, and the depth a maker can safely follow ==")
c = 0.034   # spread 300 bps + 1% fee on price ~0.4 (the reviewer's figure; spread is the reference maker's choice, not a protocol parameter)
for B, Bn in [(1000, 1000), (40000, 40000 * 17 / 18)]:
    for d in (0.10, 0.20):
        print(f"  B={B:.0f} drag {d:.2f}: expected loss {B*d*d:.0f}, collateral at risk {B*w(0.5-d,0.5):.0f}; if nobody else corrects, self-correction recovers {Bn*d*d:.0f} -> net {B*d*d-Bn*d*d:.0f}; "
              f"if rivals take the whole correction the drag costs {B*d*d:.0f}; safe following depth 4cB = {4*c*B:.0f} shares")
