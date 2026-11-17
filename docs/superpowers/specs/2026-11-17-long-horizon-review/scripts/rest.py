import random, math
random.seed(7)
# ---------- Q19 ----------
print("== Q19: move the baseline, then buy from makers who quote off it ==")
FEE=0.01; SPREAD=0.03; MAX_TAKER=500; MAX_FILL=100; MAX_PAIRS=10_000; REG=10; STAKE=100
def q19(B, delta, depth, b=0.5, B_next=None):
    """truth = b. attacker drags baseline to b-delta with full exposure B, buys YES at (b-delta+SPREAD)."""
    drag_cost = B * delta**2                       # expected Brier loss
    worst = B * ((b - delta - 1)**2 - (b - 1)**2)  # realised loss if YES
    price = b - delta + SPREAD
    edge = b - price * (1 + FEE)                   # expected profit per share
    shares = min(depth, MAX_PAIRS)
    ids = math.ceil(shares / MAX_TAKER)
    gain = shares * edge - ids * REG
    recover = (B_next if B_next is not None else 0) * delta**2
    return drag_cost, worst, price, edge, shares, ids, gain, recover
for B, delta, depth, Bn in [(1000,0.10,500,None),(1000,0.10,2000,None),(1000,0.10,10000,None),(1000,0.20,10000,None),
                            (10000,0.10,10000,None),(10000,0.20,10000,None),(50000,0.20,10000,None),(1000,0.10,2000,900),(25,0.20,2000,None)]:
    c,w,p,e,s,i,g,r = q19(B,delta,depth,B_next=Bn)
    print(f"B={B:>6} move={delta:.2f} maker depth={depth:>5}: expected drag cost={c:8.2f} (worst case {w:8.1f}), buy at {p:.2f}, "
          f"edge/share={e:.4f}, identities={i:>2} (reg fees {i*REG}, refundable taker stake {i*STAKE}), trade gain={g:8.1f}, "
          f"self-correction recovers={r:6.1f} => net {g-c+r:+9.1f}")
print("max safe consensus-following depth N* = min over delta of B*delta^2/(delta-c), c=spread+fee*price ~0.034 -> N* = 4cB:")
for B in (25,1000,10000,73500): print(f"  B={B}: {4*0.034*B:.0f} shares")

# ---------- Q8 cash flow ----------
print("\n== Q8: cash flow of a forecaster on a 24-month question ==")
def cash(total_bounty, n, d, sigma, infer, r, phi, yield_bearing, p_miss, windows=18, months=24):
    w = [(windows - t) for t in range(windows)]; tot = sum(w); Bs = [total_bounty * x / tot for x in w]
    exp_rev = 0; stake_months = 0; stake_tot = 0; fee = 0; miss = 0
    for t, B in enumerate(Bs):
        s = B / n                       # each takes an equal share of exposure, stake == exposure
        exp_rev += s * (d*d - sigma*sigma)
        lock = months - t               # months until FINAL
        stake_months += s * lock; stake_tot += s; fee += phi * s; miss += p_miss * s
    carry = 0 if yield_bearing else stake_months * r / 12
    cost_now = infer * windows + 0.04 * windows + 10   # inference + 2 txs/window (~0.02 each) + registration
    sd = stake_tot * 2 * d * 0.5       # all windows share one outcome: sd ~ stake * 2|p-b| * sqrt(q(1-q))
    pv = exp_rev / (1 + r) ** (months / 12)
    return Bs[0], stake_tot, exp_rev, pv, sd, cost_now, fee, carry, miss
for label, args in [
 ("public-info LLM, 10k bounty, 5 rivals, edge 5pt, own noise 3pt", (10_000,5,0.05,0.03,1.0,0.05,0.001,True,0.005)),
 ("same, collateral bears no yield",                                (10_000,5,0.05,0.03,1.0,0.05,0.001,False,0.005)),
 ("public-info LLM, edge 4pt, own noise 7pt",                       (10_000,5,0.04,0.07,1.0,0.05,0.001,True,0.005)),
 ("private data (pollster), edge 10pt, noise 2pt, 2 rivals",        (10_000,2,0.10,0.02,1.0,0.05,0.001,True,0.005)),
 ("private data, alone, 100k bounty",                               (100_000,1,0.10,0.02,1.0,0.05,0.001,True,0.005)),
 ("creator-funded bounty at the fee ceiling (12.5 bUSD), alone",    (12.5,1,0.10,0.02,1.0,0.05,0.001,True,0.005)),
]:
    B1, st, rev, pv, sd, cost, fee, carry, miss = cash(*args)
    print(f"{label}:\n   first-window budget {B1:.0f}, total own stake locked {st:.0f}, expected revenue at FINAL {rev:+.2f} (PV {pv:+.2f}, sd ~{sd:.0f}); "
          f"paid up front: inference+gas+registration {cost:.2f}, entry fees {fee:.2f}; carry {carry:.2f}; expected missed-reveal loss {miss:.2f} "
          f"=> expected net {pv - cost - fee - carry - miss:+.2f}")
print("bounty needed for inference break-even (18 runs at 1 bUSD, n rivals, net edge^2):")
for n, e2 in [(1,0.0096),(5,0.0016),(5,0.0025),(10,0.0016)]:
    print(f"  n={n}, d^2-sigma^2={e2}: total bounty >= {18*n/e2:,.0f} bUSD, and forecasters must lock the same amount as stake")

# ---------- creator economics ----------
print("\n== Q16: creator fee ceiling with repo parameters (feeBps=100, creatorShareBps=2500, maxMarketPairs=10000) ==")
for price in (0.5, 0.9999):
    vol = 10_000 * price; fee = vol * 0.01; cr = fee * 0.25
    print(f"all 10,000 pairs filled at avg price {price}: taker payments {vol:.0f}, fee pool {fee:.2f}, creator share {cr:.2f} bUSD; creation bond locked {10_000*0.05:.0f} bUSD for the whole life")

# ---------- Q21 power ----------
print("\n== Q21: chance that a TRUE 10% Brier improvement passes (paired test, CI excludes 0, AND point estimate >= 10%) ==")
def trial(N, rho, noise1=0.12, noise4=0.065):
    # latent truth prob q; arm1 = q + noise1, arm4 = q + noise4; shared-shock correlation of outcomes via common factor
    d = []; b1s = []
    common = random.gauss(0, 1)
    for _ in range(N):
        q = min(0.95, max(0.05, random.betavariate(1.2, 1.2)))
        z = math.sqrt(rho) * common + math.sqrt(1 - rho) * random.gauss(0, 1)
        # outcome with marginal prob q, correlated through z
        thr = -inv_norm(q)
        y = 1 if z > thr else 0
        p1 = min(0.99, max(0.01, q + random.gauss(0, noise1)))
        p4 = min(0.99, max(0.01, q + random.gauss(0, noise4)))
        b1 = (p1 - y) ** 2; b4 = (p4 - y) ** 2
        d.append(b1 - b4); b1s.append(b1)
    m = sum(d) / N; sd = math.sqrt(sum((x - m) ** 2 for x in d) / (N - 1)); se = sd / math.sqrt(N)
    mb1 = sum(b1s) / N
    return (m - 1.96 * se > 0) and (m / mb1 >= 0.10), m / mb1
def inv_norm(p):
    # Acklam approximation
    a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00]
    b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01]
    c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00]
    dd=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00]
    pl=0.02425
    if p<pl:
        q=math.sqrt(-2*math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1)
    if p>1-pl:
        q=math.sqrt(-2*math.log(1-p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((dd[0]*q+dd[1])*q+dd[2])*q+dd[3])*q+1)
    q=p-0.5; r=q*q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)
for N in (25, 50, 100, 300, 1000):
    for rho in (0.0, 0.2):
        res = [trial(N, rho) for _ in range(4000)]
        pw = sum(1 for ok, _ in res if ok) / len(res); eff = sum(e for _, e in res) / len(res)
        print(f"N={N:>4} outcome correlation={rho}: true relative improvement ~{100*eff:.1f}%, pass rate {100*pw:.0f}%")
print("false pass when the true improvement is ZERO vs arm 4 == arm 2 (pure averaging): not testable by the stated threshold, it compares arm 4 with arm 1 only")

# ---------- Q9 credit ----------
print("\n== Q9: relative-score credit ==")
def rel_credit(n_answers, edge, q=0.5, trials=20000):
    pos = 0; ms = []
    for _ in range(trials):
        tot = 0
        for _ in range(n_answers):
            c = q - edge; y = 1 if random.random() < q else 0
            tot += (c - y) ** 2 - (q - y) ** 2
        ms.append(tot / n_answers); pos += tot > 0
    m = sum(ms) / trials; sd = math.sqrt(sum((x - m) ** 2 for x in ms) / trials)
    return m, sd, pos / trials
for edge in (0.02, 0.05):
    for n in (5, 50):
        m, sd, pos = rel_credit(n, edge)
        print(f"honest forecaster who is truly {edge:.2f} better than the consensus, {n} independent scored answers: mean relative score {m:.4f}, sd {sd:.4f}, P(weight>0)={pos:.2f}")
print("same 50 answers but all on ONE long question (one outcome): the score is +/- one draw:")
for edge in (0.02, 0.05):
    q=0.5; c=q-edge
    print(f"  edge {edge}: YES -> {(c-1)**2-(q-1)**2:+.4f}, NO -> {c**2-q**2:+.4f}")
print("clone farming: clones post 0.01 in window t (consensus dragged to 0.01 when weights are empty), main posts 0.5 in t+1, truth 0.5:")
print(f"  main's expected relative score per answer = {(0.01-0.5)**2:.4f}  vs honest {0.05**2:.4f} for a real 5-point edge -> {(0.49**2)/(0.05**2):.0f}x the weight")
