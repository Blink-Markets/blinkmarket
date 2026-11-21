"""Numbers for mechanism-r-worked-example.md and its zh-TW version. Pure Python, no packages.

Rules: reopened-decisions-proposals.md section 2.2, with the user's changes of 2026-11-21
(record 12.6): rule 4 locks only the side that can lose, and rule 7 burns the net loss, so the
sponsor never gets back more than its escrow.
Run from this folder: python3 -I worked_example.py
"""
from decimal import ROUND_HALF_UP, Decimal

PHI = 0.001  # entry fee, 0.1% of the requested units


def m(x, sign=False):  # an amount in bUSD, rounded half up to cents once float noise is removed
    d = Decimal(repr(round(x, 9))).quantize(Decimal("0.01"), ROUND_HALF_UP)
    return f"{d:+,.2f}" if sign else f"{d:,.2f}"


def L(p, y):  # Brier loss; y = 1 for rain (YES), 0 for no rain (NO)
    return (p - y) ** 2


def pay(e, b, p, y):  # a forecaster's payout at settlement
    return e * (L(b, y) - L(p, y))


def lock(e, b, p):  # rule 4 as changed on 2026-11-21: only what the forecaster can lose
    return e * abs(p - b) * ((p + b) if p > b else (2 - p - b))


def lock_first_proposal(e, b, p):  # rule 4 as first proposed: the larger of the two outcomes
    return e * abs(p - b) * max(p + b, 2 - p - b)


def deposit(x, b, band):  # rule 3, before reveal: the worse end of the band (unchanged)
    return max(lock(x, b, min(1.0, b + band)), lock(x, b, max(0.0, b - band)))


def escrow(allowance_1, b0):  # rule 1
    return allowance_1 * max(b0 ** 2, (1 - b0) ** 2)


def settle(X, fees, net):
    """Rules 6 and 7. net = all forecasters' payouts in one outcome, already netted.
    Returns (the sponsor gets back, burned)."""
    pool = X + fees - net
    back = min(X, pool)
    return back, pool - back


def run(b0, allowances, windows):
    """windows: one list per window of (name, report, requested units, band)."""
    b, rows = b0, []
    for t, entries in enumerate(windows):
        requested = sum(x for _, _, x, _ in entries)
        k = min(1.0, allowances[t] / requested)
        filled = sum(k * x for _, _, x, _ in entries)
        mean = sum(k * x * p for _, p, x, _ in entries) / filled
        new_b = b + filled / allowances[t] * (mean - b)
        for name, p, x, band in entries:
            e = k * x
            rows.append(dict(name=name, b=b, p=p, x=x, e=e, fee=PHI * x, deposit=deposit(x, b, band),
                             lock=lock(e, b, p), lock_first=lock_first_proposal(e, b, p),
                             rain=pay(e, b, p, 1), dry=pay(e, b, p, 0), own=e * (p - b) ** 2,
                             shares=2 * e * abs(p - b), side="YES" if p > b else "NO",
                             price=(b + p) / 2 if p > b else 1 - (b + p) / 2))
        print(f"  window {t + 1}: allowance {allowances[t]:,}, requested {requested:,}, each filled at {k:.0%}, "
              f"mean report {mean:.1%}, baseline {b:.1%} -> {new_b:.1%}")
        b = new_b
    return rows


def outcomes(X, rows):
    fees = sum(r["fee"] for r in rows)
    net = {y: sum(r["rain" if y else "dry"] for r in rows) for y in (1, 0)}
    return fees, net, {y: settle(X, fees, net[y]) for y in (1, 0)}


def expected(q, X, rows):
    """Expected values if q is the true chance of rain."""
    fees, net, s = outcomes(X, rows)
    forecasters = q * net[1] + (1 - q) * net[0] - fees
    sponsor = q * (X - s[1][0]) + (1 - q) * (X - s[0][0])
    burned = q * s[1][1] + (1 - q) * s[0][1]
    return forecasters, sponsor, burned


print("== The rain question: b0 30%, allowances 1,000 / 600 / 300 ==")
X = escrow(1000, 0.30)
print(f"  escrow X = 1,000 x max(0.30^2, 0.70^2) = {m(X)}")
rows = run(0.30, [1000, 600, 300], [[("A", 0.40, 1000, 0.15), ("B", 0.35, 1000, 0.10)],
                                    [("C", 0.60, 600, 0.25)], [("D", 0.85, 300, 0.30)]])
print("  name  deposit  fee   filled  shares          lock    (first proposal)  returned  rain     no rain  own view")
for r in rows:
    print(f"  {r['name']}    {m(r['deposit']):>7}  {m(r['fee'])}  {r['e']:6.0f}  {r['shares']:3.0f} {r['side']} at {r['price']:.4f}  "
          f"{m(r['lock']):>7}  ({m(r['lock_first']):>7})        {m(r['deposit'] - r['lock']):>7}  {m(r['rain'], True):>8}  "
          f"{m(r['dry'], True):>8}  {m(r['own'])}")
fees, net, s = outcomes(X, rows)
print(f"  entry fees {m(fees)}; pool before settlement {m(X + fees)}")
for y, word in ((1, "rain"), (0, "no rain")):
    back_first = X + fees - net[y]  # rule 7 'A' as first adopted: the net loss went back to the sponsor
    print(f"  {word}: forecasters {m(net[y], True)}; sponsor gets back {m(s[y][0])} "
          f"(first adopted rule: {m(back_first)}); burned {m(s[y][1])}")
print(f"  security bound: shares counted = {sum(r['shares'] for r in rows):.0f}")
c = rows[2]
print(f"  missed reveal: C forfeits the deposit on its filled part = {m(c['deposit'] * c['e'] / c['x'])}")
f, sp, bu = expected(0.85, X, rows)
print(f"  if 85% is right: forecasters expect to net {m(f)}; sponsor expects to pay {m(sp)} "
      f"(first adopted rule: {m(f)}); expected burned {m(bu)}; share reaching forecasters {f / sp:.0%}")

print("\n== Score per 100 units at a 30% baseline ==")
for p in (0.30, 0.40, 0.60, 0.15):
    print(f"  report {p:.0%}: rain {m(pay(100, 0.30, p, 1), True)}, no rain {m(pay(100, 0.30, p, 0), True)}")

print("\n== Window 1 only: A reports 40%, B 35%, each requests the whole allowance; 37.5% taken as the truth ==")
print("  setting      escrow    A own view  B own view  forecasters net  sponsor pays  burned   share  locks A / B")
for b0, allowance in ((0.30, 1000), (0.50, 1000), (0.50, 4000)):
    X1 = escrow(allowance, b0)
    print(f"  {b0:.0%}, {allowance:>5,}", end="")
    e = allowance / 2  # both request the whole allowance, so each fills half
    rows1 = [dict(fee=PHI * allowance, rain=pay(e, b0, p, 1), dry=pay(e, b0, p, 0), own=e * (p - b0) ** 2,
                  lock=lock(e, b0, p)) for p in (0.40, 0.35)]
    f, sp, bu = expected(0.375, X1, rows1)
    print(f"  {m(X1):>8}  {m(rows1[0]['own']):>10}  {m(rows1[1]['own']):>10}  {m(f):>15}  {m(sp):>12}  {m(bu):>6}  "
          f"{f / sp:5.1%}  {m(rows1[0]['lock'])} / {m(rows1[1]['lock'])}")

print("\n== One forecaster at a 50% baseline who is right: the share of the sponsor's expected payment that reaches it ==")
for d in (0.05, 0.10, 0.20):
    print(f"  edge {d * 100:.0f} points: forecaster expects {m(d * d * 1000)} per 1,000 units; "
          f"sponsor expects to pay {m((0.5 + d) * d * (1 - d) * 1000)}; share {d / ((0.5 + d) * (1 - d)):.1%}")
