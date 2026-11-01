import { AbsoluteFill } from "remotion";
import { screen, shots } from "../script.ts";
import { useShotTime } from "../time.ts";
import { Agent } from "../ui/Agent.tsx";
import { clamp } from "../ui/motion.ts";
import { LineSwap } from "../ui/Type.tsx";
import { Bubble, Coin, ProductWindow, Sketch } from "../ui/Window.tsx";

export function Trading() {
  const t = useShotTime();
  const s = screen.trading;
  const p = clamp(t, .7, 3.9);
  return <AbsoluteFill style={{ background: "#f4f1ea" }}>
    <Sketch t={t} color="#d4562f" />
    <ProductWindow t={t} title={s.title} side="left">
      <div style={{ opacity: .65 }}>{screen.goesLive.newMarket.question}</div>
      <div style={{ marginTop: 10, fontSize: 17, opacity: .55 }}>{s.consensusLabel}</div>
      <div style={{ fontSize: 81, fontWeight: 700, letterSpacing: "-.04em", color: "#2148b8" }}>{Math.round(s.consensusFrom + (s.consensusTo - s.consensusFrom) * p)}%</div>
      <svg viewBox="0 0 220 60" style={{ width: "100%", height: 154 }}><path d="M2 54 L28 52 L52 47 L76 49 L104 37 L130 31 L156 26 L182 19 L218 12" fill="none" stroke="#2148b8" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="260" strokeDashoffset={260 * (1 - p)} /></svg>
    </ProductWindow>
    {[0, 1].map(i => { const start = 1 + i * 1.1; const n = clamp(t, start, start + .8); return <div key={i} style={{ position: "absolute", left: 284 + i * 150 + n * (166 + i * 20), top: 900 - n * (330 + i * 30) - Math.sin(n * Math.PI) * 60, padding: "6px 10px", background: "white", border: "2px solid #2f9fd0", borderRadius: 8, color: "#2f9fd0", fontSize: 19, opacity: t >= start && t < start + .8 ? 1 : 0, transform: `rotate(${n * 15}deg)`, zIndex: 3 }}><b>{s.forecasts[i]}</b> <small>{s.signed}</small></div>; })}
    <Agent role="forecaster" size={88} x={240} y={890} t={t} pose={{ pop: .4, hop: .4 }} />
    <Agent role="forecaster" size={88} x={390} y={890} t={t} pose={{ pop: .7, hop: .7 }} />
    <Agent role="trader" size={88} x={1050} y={730} t={t} pose={{ pop: .5, hop: .5 }} />
    <Agent role="trader" size={88} x={1190} y={820} t={t} pose={{ pop: .65, hop: .65 }} />
    <Agent role="maker" size={100} x={1420} y={730} t={t} pose={{ pop: .8, sway: .8 }} />
    <Bubble t={t} at={1} x={1094} y={665}>{s.traderLines[0]}</Bubble><Bubble t={t} at={2} x={1234} y={755}>{s.traderLines[1]}</Bubble><Bubble t={t} at={2.6} x={1470} y={665}>{s.makerQuote}</Bubble>
    <Coin t={t} at={2.3} from={[1100, 750]} to={[1420, 750]} /><Coin t={t} at={3.2} from={[1420, 750]} to={[1230, 830]} />
    <div style={{ position: "absolute", left: "60%", right: "5%", top: "33%", fontSize: 82, lineHeight: 1.02, letterSpacing: "-.045em" }}><LineSwap lines={shots[3]!.lines} at={[.3, 1.8, 3.3]} /></div>
  </AbsoluteFill>;
}
