"""Q14/Q15/Q17 checks. Pure python.

Model (my reading of the record, stated as an assumption):
  window t has budget Bt (after roll-over), baseline b (probability).
  forecaster i: stake s_i, report p_i.  S = sum s_i.
  exposure e_i = s_i * min(1, Bt/S);  E = sum e_i = min(S, Bt).
  payout_i (at FINAL, outcome y) = e_i * ((b-y)^2 - (p_i-y)^2)      [positive = paid by sponsor]
  baseline' = b + (E/Bt) * (m - b),  m = exposure-weighted mean report.
  roll-over (Q17c): unfilled exposure Bt - E is added to the next window's budget.
  entry fee (Q15): phi * stake, added to the next window's budget.
Expected payout under true probability q: e_i * ((b-q)^2 - (p_i-q)^2).
"""
import random, itertools, math

def window(b, B, bets, q, phi=0.0):
    """bets: list of (stake, report, owner). returns new baseline, dict owner->expected net, unfilled, fees"""
    S = sum(s for s, _, _ in bets)
    if S == 0 or B <= 0:
        return b, {}, max(B, 0), 0.0
    k = min(1.0, B / S)
    E = S * k
    m = sum(s * p for s, p, _ in bets) / S
    pay = {}
    for s, p, o in bets:
        pay[o] = pay.get(o, 0.0) + s * k * ((b - q) ** 2 - (p - q) ** 2) - phi * s
    nb = b + (E / B) * (m - b)
    return nb, pay, B - E, phi * S

print("== A. drag then correct, attacker alone in both windows, truth q=0.5, baseline starts at truth ==")
def drag_correct(B1, B2, sigma, p1, q=0.5, b0=0.5, rollover=True, topup=0.0, phi=0.0):
    b1, pay1, unf, fee = window(b0, B1, [(sigma * B1, p1, "A")], q, phi)
    B2e = B2 + (unf if rollover else 0) + fee + topup
    b2, pay2, _, _ = window(b1, B2e, [(B2e, q, "A")], q, phi)
    return pay1["A"], pay2["A"], B2e, b1
for label, B1, B2, roll, top in [
    ("flat budgets, no roll-over", 1000, 1000, False, 0),
    ("declining 1000->800, no roll-over", 1000, 800, False, 0),
    ("declining 1000->800, roll-over of unfilled", 1000, 800, True, 0),
    ("flat, roll-over of unfilled", 1000, 1000, True, 0),
    ("thin 100 -> new sponsor top-up makes next window 1100", 100, 100, True, 1000),
]:
    best = (-1e9,)
    for sg in [i / 20 for i in range(1, 21)]:
        for p1 in [i / 100 for i in range(1, 100)]:
            l, g, B2e, b1 = drag_correct(B1, B2, sg, p1, rollover=roll, topup=top)
            if l + g > best[0]:
                best = (l + g, sg, p1, l, g, B2e, b1)
    print(f"{label}: best net={best[0]:.2f} at stake={best[1]:.2f}*B1 report={best[2]:.2f} "
          f"(loss w1={best[3]:.2f}, gain w2={best[4]:.2f}, B2eff={best[5]:.0f}, dragged baseline={best[6]:.3f})")

print("\n== A2. cost of a 10-point temporary move if the mover also corrects next window ==")
for B1, B2 in [(1000, 1000), (1000, 900), (1000, 500)]:
    l, g, B2e, b1 = drag_correct(B1, B2, 1.0, 0.40, rollover=False)
    print(f"B1={B1} B2={B2}: gross 'cost to move'={-l:.2f}, recovered by self-correction={g:.2f}, net cost={-(l+g):.2f}")

print("\n== A3. multi-window monopolist, random search, declining schedule with roll-over, start at truth ==")
random.seed(1)
def run_path(Bs, acts, q=0.5, b0=0.5, phi=0.0, topups=None):
    b, carry, tot = b0, 0.0, 0.0
    for t, (sg, p) in enumerate(acts):
        B = Bs[t] + carry + (topups[t] if topups else 0)
        b, pay, unf, fee = window(b, B, [(sg * B, p, "A")] if sg > 0 else [], q, phi)
        tot += pay.get("A", 0.0)
        carry = unf + fee
    return tot
Bs = [1000, 900, 800, 700, 600, 500]
best = -1e9
for _ in range(300000):
    acts = [(random.choice([0, 0, random.random(), 1.0]), random.choice([0.5, random.random()*0.98+0.01])) for _ in Bs]
    v = run_path(Bs, acts)
    if v > best: best, ba = v, acts
print(f"best expected profit found (should be <= 0 if the claim holds): {best:.4f}")
Bs2 = [1000, 900, 800, 700, 600, 500]; tops = [0, 0, 0, 3000, 0, 0]
best = -1e9
for _ in range(300000):
    acts = [(random.choice([0, 0, random.random(), 1.0]), random.choice([0.5, random.random()*0.98+0.01])) for _ in Bs2]
    v = run_path(Bs2, acts, topups=tops)
    if v > best: best, ba = v, acts
print(f"same but a third-party sponsor adds 3000 to window 4: best profit {best:.2f} with acts {[(round(a,2),round(p,2)) for a,p in ba]}")

print("\n== B. informed monopolist (private edge d=0.10 over baseline), when to report? ==")
def informed(Bs, when, q=0.6, b0=0.5, rollover=True, decay=None):
    b, carry, tot = b0, 0.0, 0.0
    for t in range(len(Bs)):
        B = Bs[t] + (carry if rollover else 0)
        if t == when:
            b, pay, unf, _ = window(b, B, [(B, q, "A")], q)
            tot += pay["A"]
        else:
            unf = B
        carry = unf
    return tot
Bs = [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100]
for roll in (False, True):
    print(f"roll-over={roll}: " + ", ".join(f"w{t+1}:{informed(Bs, t, rollover=roll):.1f}" for t in range(len(Bs))))
print("with roll-over, edge decaying 10% per window (public news leaks): ")
vals = []
for t in range(len(Bs)):
    d = 0.10 * (0.9 ** t)
    carry = sum(Bs[:t])
    vals.append((Bs[t] + carry) * d * d)
print(", ".join(f"w{t+1}:{v:.1f}" for t, v in enumerate(vals)))

print("\n== C. within one window: can a coalition of identities beat one honest report? (random search) ==")
random.seed(2)
worst = 0.0
for _ in range(200000):
    b, q, B = random.random(), random.random(), 1000
    n = random.randint(2, 5)
    bets = [(random.random() * 800, random.random(), "A") for _ in range(n)]
    S = sum(s for s, _, _ in bets)
    _, pay, _, _ = window(b, B, bets, q)
    _, pay1, _, _ = window(b, B, [(S, q, "A")], q)
    worst = max(worst, pay["A"] - pay1["A"])
print(f"max (coalition payout - single honest report with same total stake): {worst:.6f}  (<=0 means splitting never helps)")

print("\n== D. who pays whom at FINAL: b=0.5, honest report q, exposure 1000 ==")
for b, q in [(0.5, 0.6), (0.5, 0.55), (0.3, 0.4), (0.5, 0.8)]:
    e = 1000
    yes = e * ((b - 1) ** 2 - (q - 1) ** 2); no = e * (b ** 2 - q ** 2)
    sponsor = q * max(yes, 0) + (1 - q) * max(no, 0)
    slashed = q * max(-yes, 0) + (1 - q) * max(-no, 0)
    net = sponsor - slashed
    sd = math.sqrt(q * (yes - net) ** 2 + (1 - q) * (no - net) ** 2)
    print(f"b={b} q={q}: payout if YES={yes:+.1f}, if NO={no:+.1f}; forecaster expected net={net:.2f} (sd {sd:.1f}); "
          f"sponsor expected outlay={sponsor:.2f}; slashed to treasury (Q25)={slashed:.2f} = {100*slashed/sponsor:.0f}% of what the sponsor pays")

print("\n== E. stake contest when the window is over-subscribed (n symmetric forecasters, edge^2=D, cost per unit stake c) ==")
for D, c, n in [(0.01, 0.002, 2), (0.01, 0.002, 5), (0.01, 0.002, 20), (0.0025, 0.002, 5)]:
    B = 1000
    S = B * D * (n - 1) / (n * c)
    if S <= B:
        print(f"D={D} c={c} n={n}: not over-subscribed in equilibrium (S*={S:.0f} <= B)")
        continue
    each = B * D / n - c * S / n
    print(f"D={D} c={c} n={n}: total stake {S:.0f} ({S/B:.1f}x B), expected gross paid to all {B*D:.1f}, "
          f"burned in fees/carry {c*S:.2f}, profit per forecaster {each:.3f}")

print("\n== F. pinning: attacker copies the baseline with a big stake (payout 0), honest informed forecaster stakes 1000 at q=0.7, b=0.5, B=1000 ==")
for mult, phi in [(0, 0.002), (4, 0.002), (9, 0.002), (19, 0.002), (9, 0.01)]:
    b, pay, unf, fee = window(0.5, 1000, [(1000, 0.7, "H"), (mult * 1000, 0.5, "P")] if mult else [(1000, 0.7, "H")], 0.7, phi)
    print(f"pin stake={mult}xB fee={phi}: baseline moves to {b:.3f} (should be 0.700); honest net={pay['H']:.2f}; "
          f"pinner cost={-pay.get('P',0):.2f}")

print("\n== G. baseline responsiveness: informed forecaster can afford stake 100, reports 0.8, b=0.5 ==")
for B in [100, 500, 1000, 5000]:
    b, pay, _, _ = window(0.5, B, [(100, 0.8, "H")], 0.8)
    print(f"B={B}: new baseline {b:.3f}, forecaster expected pay {pay['H']:.2f}")

print("\n== H. first-window baseline b0=0.5 on a question whose public base rate is q ==")
for q in [0.05, 0.1, 0.2, 0.9]:
    print(f"q={q}: window 1 pays (0.5-q)^2 = {100*(0.5-q)**2:.1f}% of filled exposure for restating the public base rate")
