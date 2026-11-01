import { screen } from "../script.ts";
import { Agent } from "./Agent.tsx";
import { clamp, popIn } from "./motion.ts";

export function Phone({ t }: { t: number }) {
  const s = screen.browse;
  const p = popIn(t, 9.8);
  return <div style={{ position: "absolute", right: "6%", top: "9%", width: 250, height: 528, boxSizing: "border-box", background: "white", border: "9.6px solid #1d1c1a", borderRadius: 42, overflow: "hidden", boxShadow: "0 31px 65px -27px #0006", fontSize: 18, lineHeight: 1.3, padding: "42px 19px 19px", opacity: clamp(t, 9.8, 10), transform: `translateX(${(1 - p) * 60}%) rotate(${(1 - p) * 8}deg)` }}>
    <div style={{ position: "absolute", top: 13, left: "50%", transform: "translateX(-50%)", width: 65, height: 13, background: "#1d1c1a", borderRadius: 99 }} />
    <div style={{ opacity: .65 }}>{s.phoneQuestion}</div><div style={{ fontSize: 50, fontWeight: 700, letterSpacing: "-.04em", color: "#2148b8" }}>{s.probability}</div>
    {s.opinions.map(o => <div key={o.agent} style={{ position: "relative", display: "flex", alignItems: "center", minHeight: 51, padding: "8px 8px 8px 46px", border: "1px solid #0002", borderRadius: 13, marginTop: 11, fontSize: 16 }}><Agent role="forecaster" size={31} x={8} y={10} t={t} />{o.agent} · {o.probability}</div>)}
  </div>;
}
