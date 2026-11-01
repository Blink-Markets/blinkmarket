import { AbsoluteFill } from "remotion";
import { screen, shots } from "../script.ts";
import { useShotTime } from "../time.ts";
import { Agent } from "../ui/Agent.tsx";
import { clamp, popIn } from "../ui/motion.ts";
import { Phone } from "../ui/Phone.tsx";
import { LineSwap } from "../ui/Type.tsx";
import { ProductWindow, Sketch } from "../ui/Window.tsx";

const paths = ["M0 8 L20 10 L40 9 L60 13 L80 12 L100 14", "M0 14 L20 13 L40 11 L60 10 L80 8 L100 7", "M0 17 L20 16 L40 13 L60 11 L80 8 L100 5", "M0 12 L20 10 L40 9 L60 7 L80 7 L100 6", "M0 9 L20 11 L40 10 L60 12 L80 11 L100 12", "M0 10 L20 12 L40 14 L60 13 L80 15 L100 16", "M0 13 L20 12 L40 12 L60 10 L80 10 L100 9", "M0 15 L20 13 L40 12 L60 9 L80 9 L100 7"];
export function Browse() {
  const t = useShotTime();
  const s = screen.browse;
  const g = screen.goesLive;
  const markets = [g.markets[0]!, g.markets[1]!, { question: g.newMarket.question, probability: s.probability }, ...g.markets.slice(2), ...s.markets];
  const scroll = clamp(t, .7, 3.2);
  const cursor = clamp(t, 2.51, 3.56);
  const detail = clamp(t, 4.25, 4.75);
  return <AbsoluteFill>
    <Sketch t={t} color="#2148b8" />
    <div style={{ position: "absolute", left: 0, right: 0, top: "8%", textAlign: "center", fontSize: 74.88, lineHeight: 1.02, letterSpacing: "-.045em" }}><LineSwap lines={shots[6]!.lines} at={[.3, 3.7, 4.7, 6.6, 8.5]} /></div>
    <ProductWindow t={t} title={s.title} side="right" browse overlay={<Phone t={t} />}>
      <div style={{ position: "absolute", inset: "40px 0 0", overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 27, right: 27, top: 23, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 19, transform: `translateY(${-172.8 * scroll}px)` }}>{markets.map((m, i) => <div key={m.question} style={{ height: 153.6, boxSizing: "border-box", border: `1px solid ${i === 2 && t >= 3.5 ? "#2148b8" : "#0002"}`, borderRadius: 15, padding: "15px 19px", display: "grid", gridTemplateColumns: "1fr auto", gridTemplateRows: "auto 1fr", gap: "4px 15px", fontSize: 20, lineHeight: 1.3, transform: i === 2 && t >= 3.95 && t < 4.25 ? `scale(${1 - .04 * Math.sin((t - 3.95) / .3 * Math.PI)})` : undefined }}><span>{m.question}</span><b style={{ gridRow: "1 / 3", gridColumn: 2, alignSelf: "center", fontSize: 46, color: "#2148b8" }}>{m.probability}</b><svg viewBox="0 0 100 20" style={{ alignSelf: "end", width: "70%", height: 38 }}><path d={paths[i]} fill="none" stroke="#2148b866" strokeWidth="2" /></svg></div>)}</div>
        <svg viewBox="0 0 24 24" width="35" style={{ position: "absolute", left: 844.8 - 556.8 * cursor, top: 326.4 - 226.4 * cursor, zIndex: 5, opacity: 1 - detail, transform: `scale(${t >= 3.9 && t < 4.1 ? .8 : 1})` }}><path d="M3 2 L3 19 L8 14.5 L11.5 22 L14.5 20.6 L11 13.3 L17.5 13.3 Z" fill="#1d1c1a" stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" /></svg>
        <div style={{ position: "absolute", inset: 0, background: "white", padding: "23px 31px", opacity: detail, transform: `scale(${.94 + .06 * popIn(t, 4.25)})` }}>
          <div style={{ opacity: .65 }}>{g.newMarket.question}</div><div style={{ display: "flex", alignItems: "end", gap: 27 }}><div style={{ fontSize: 65, fontWeight: 700, color: "#2148b8" }}>{s.probability}</div><svg viewBox="0 0 220 40" style={{ flex: 1, height: 77 }}><path d="M2 36 L28 35 L52 31 L76 32 L104 24 L130 20 L156 17 L182 12 L218 8" fill="none" stroke="#2148b8" strokeWidth="2.6" strokeDasharray="260" strokeDashoffset={260 * (1 - clamp(t, 4.7, 6.4))} /></svg></div>
          <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 27, marginTop: 15 }}><div><div style={{ font: "500 17px monospace", opacity: .55, textTransform: "uppercase" }}>{s.opinionsLabel}</div>{s.opinions.map((o, i) => <div key={o.agent} style={{ position: "relative", display: "grid", gridTemplateColumns: "46px 1fr auto", gap: 15, alignItems: "center", padding: "11px 15px", border: "1px solid #0002", borderRadius: 13, marginTop: 11, fontSize: 19, lineHeight: 1.3, opacity: clamp(t, 6.8 + i * .4, 7 + i * .4), transform: `translateX(${14 * (1 - popIn(t, 6.8 + i * .4))}%)` }}><div style={{ position: "relative", width: 46, height: 46 }}><Agent role="forecaster" size={46} x={0} y={0} t={t} /></div><span><strong>{o.agent}</strong><br />{o.reason}</span><b style={{ fontSize: 31, color: "#2148b8" }}>{o.probability}</b></div>)}</div><div><div style={{ font: "500 17px monospace", opacity: .55, textTransform: "uppercase" }}>{s.sourcesLabel}</div>{s.sources.map((source, i) => <div key={source.title} style={{ padding: "11px 13px", borderLeft: "5px solid #d4562f", background: "#d4562f0b", borderRadius: "0 10px 10px 0", marginTop: 11, fontSize: 18, opacity: clamp(t, 8.7 + i * .3, 8.9 + i * .3), transform: `translateX(${14 * (1 - popIn(t, 8.7 + i * .3))}%)` }}>{source.title}<small style={{ display: "block", font: "500 14px monospace", opacity: .6 }}>{source.note}</small></div>)}</div></div>
        </div>
      </div>
    </ProductWindow>
  </AbsoluteFill>;
}
