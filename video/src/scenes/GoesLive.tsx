import { AbsoluteFill } from "remotion";
import { screen, shots } from "../script.ts";
import { useShotTime } from "../time.ts";
import { Agent } from "../ui/Agent.tsx";
import { clamp } from "../ui/motion.ts";
import { KineticLine } from "../ui/Type.tsx";
import { Bubble, ProductWindow, Sketch } from "../ui/Window.tsx";

export function GoesLive() {
  const t = useShotTime();
  const s = screen.goesLive;
  const row = { display: "flex", justifyContent: "space-between", gap: 19, padding: "14px 6px", borderBottom: "1px solid #0000000f" };
  const p = clamp(t, 2.1, 2.7);
  return <AbsoluteFill style={{ background: "#f4f1ea" }}>
    <Sketch t={t} color="#2148b8" />
    <div style={{ position: "absolute", left: "7%", top: "36%", fontSize: 107.52, lineHeight: 1.02, letterSpacing: "-.045em" }}><KineticLine line={shots[2]!.lines[0]!} at={.3} breaks={[2]} underlineAt={1.1} /></div>
    <ProductWindow t={t} title={s.title} side="right">
      <div style={{ ...row, overflow: "hidden", height: 58 * p, boxSizing: "border-box", paddingBlock: 14 * p, background: "#2148b80d", borderRadius: 10, opacity: p }}><span><span style={{ fontFamily: "monospace", fontSize: 15, background: "#d4562f", color: "white", padding: "2px 8px", borderRadius: 6, marginRight: 10 }}>{s.tag}</span>{s.newMarket.question}</span><b style={{ color: "#2148b8" }}>{s.newMarket.probability ?? s.empty}</b></div>
      {s.markets.map(m => <div key={m.question} style={row}><span>{m.question}</span><b style={{ color: "#2148b8" }}>{m.probability}</b></div>)}
    </ProductWindow>
    <Agent role="creator" size={123.65} x={1613} y={173} t={t} pose={{ pop: .9, hop: .9 }} />
    <Bubble t={t} at={1.5} x={1500} y={174}>{s.bubble}</Bubble>
  </AbsoluteFill>;
}
