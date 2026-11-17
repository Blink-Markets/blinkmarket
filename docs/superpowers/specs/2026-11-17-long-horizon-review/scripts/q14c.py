def window(b, B, bets, q, phi=0.0):
    S = sum(s for s, _, _ in bets)
    if S == 0 or B <= 0: return b, {}, max(B, 0), 0.0
    k = min(1.0, B / S); E = S * k
    m = sum(s * p for s, p, _ in bets) / S
    pay = {}
    for s, p, o in bets:
        pay[o] = pay.get(o, 0.0) + s * k * ((b - q) ** 2 - (p - q) ** 2) - phi * s
    return b + (E / B) * (m - b), pay, B - E, phi * S

Bs = [1000, 900, 800, 700, 600, 500]
print("drag in window 1 (full exposure, report p), stay out, correct in window k; truth 0.5; roll-over of unfilled budget; attacker alone")
for p in (0.40, 0.30, 0.01):
    for phi in (0.0, 0.005):
        out = []
        for k in range(1, 6):
            b, pay, unf, fee = window(0.5, Bs[0], [(Bs[0], p, "A")], 0.5, phi)
            tot = pay["A"]; carry = unf + fee
            for t in range(1, k): carry += Bs[t]
            B = Bs[k] + carry
            b2, pay2, _, _ = window(b, B, [(B, 0.5, "A")], 0.5, phi)
            out.append(f"k={k+1}: pot={B:.0f} net={tot + pay2['A']:+.1f}")
        print(f"report={p} fee={phi}: loss in w1={-tot:.1f}; " + "; ".join(out))
print()
print("same, but an honest rival also corrects in the correcting window with stake R (attacker stakes the whole pot)")
for R in (0, 500, 2000, 10000):
    b, pay, unf, fee = window(0.5, 1000, [(1000, 0.01, "A")], 0.5)
    B = sum(Bs[1:4])
    b2, pay2, _, _ = window(b, B, [(B, 0.5, "A"), (R, 0.5, "H")] if R else [(B, 0.5, "A")], 0.5)
    print(f"rival stake {R}: attacker net {pay['A'] + pay2['A']:+.1f}, rival gets {pay2.get('H', 0):.1f}, sponsor pays out {pay2['A'] + pay2.get('H', 0):.1f} for no information")
