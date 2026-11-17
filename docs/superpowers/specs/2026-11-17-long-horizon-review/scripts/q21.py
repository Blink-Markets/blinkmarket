import random, math
random.seed(11)
def clip(x): return min(0.99, max(0.01, x))
def draw_q(): return min(0.95, max(0.05, random.betavariate(1.2, 1.2)))
def trial(N, n1, n4):
    d=[]; b1s=[]
    for _ in range(N):
        q=draw_q(); y=1 if random.random()<q else 0
        p1=clip(q+random.gauss(0,n1)); p4=clip(q+random.gauss(0,n4))
        b1=(p1-y)**2; b4=(p4-y)**2; d.append(b1-b4); b1s.append(b1)
    m=sum(d)/N; sd=math.sqrt(sum((x-m)**2 for x in d)/(N-1)); se=sd/math.sqrt(N); mb=sum(b1s)/N
    return m, se, mb
def big(n1,n4,N=400000):
    m,se,mb=trial(N,n1,n4); return mb, mb-m, m/mb
print("ceiling: improvement of a PERFECT forecaster (knows the true probability) over a single model with error sd n1")
for n1 in (0.05,0.08,0.10,0.14,0.18):
    mb,b4,rel=big(n1,0.0)
    print(f"  single-model error sd {n1:.2f}: Brier {mb:.4f}, perfect {b4:.4f}, max possible improvement {100*rel:.1f}%")
print("power when the true improvement is ~10% (single error sd 0.18, arm-4 error sd 0.105)")
mb,b4,rel=big(0.18,0.105); print(f"  calibrated: Brier1 {mb:.4f} Brier4 {b4:.4f} true improvement {100*rel:.1f}%")
for N in (25,50,100,300):
    ok_ci=ok_both=0; T=4000
    for _ in range(T):
        m,se,mb=trial(N,0.18,0.105)
        if m-1.96*se>0:
            ok_ci+=1
            if m/mb>=0.10: ok_both+=1
    print(f"  N={N}: CI excludes zero {100*ok_ci/T:.0f}%; CI excludes zero AND point estimate >= 10%: {100*ok_both/T:.0f}%")
print("power when the true improvement is ~20% (single 0.18, arm-4 0.0)")
mb,b4,rel=big(0.18,0.02); print(f"  true improvement {100*rel:.1f}%")
for N in (25,50,100):
    ok=0; T=4000
    for _ in range(T):
        m,se,mb=trial(N,0.18,0.02)
        if m-1.96*se>0 and m/mb>=0.10: ok+=1
    print(f"  N={N}: pass {100*ok/T:.0f}%")
