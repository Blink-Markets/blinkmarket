import { AbsoluteFill } from "remotion";
import { screen, shots } from "../script.ts";
import { useShotTime } from "../time.ts";
import { Agent } from "../ui/Agent.tsx";
import { clamp, popIn } from "../ui/motion.ts";
import { LineSwap } from "../ui/Type.tsx";
import { Bubble, Coin } from "../ui/Window.tsx";

export function Dispute() {
  const t = useShotTime();
  const s = screen.dispute;
  const shrink = clamp(t, 3.6, 4.2);
  return <AbsoluteFill style={{ background: "#f4f1ea" }}>
    <div style={{ position: "absolute", left: 0, right: 0, top: "15%", textAlign: "center", fontSize: 92.16, lineHeight: 1.02, letterSpacing: "-.045em" }}><LineSwap lines={shots[4]!.lines} at={[.2, 4.6]} /></div>
    <div style={{ opacity: 1 - .5 * shrink }}><Agent role="proposer" size={141.31} x={249.6} y={561.6} t={t} pose={{ pop: .4, sway: .4, scale: 1 - .45 * shrink, grey: t >= 4 }} /></div>
    <Bubble t={t} at={.9} x={320} y={490}>{s.answer}</Bubble>
    <Agent role="challenger" size={141.31} x={729.6} y={561.6} t={t} pose={{ pop: 1.2, hop: 1.2, shake: 1.8 }} />
    <Bubble t={t} at={1.4} x={800} y={490}>{s.challenge}</Bubble>
    {[0, 1, 2].map(i => <div key={i}><Agent role="juror" size={105.98} x={(64 + 10 * i) * 19.2} y={(i === 1 ? .52 : .57) * 1080} t={t} pose={{ pop: 2 + .3 * i, sway: 2 + .3 * i }} /><Bubble t={t} at={2.3 + .3 * i} x={(64 + 10 * i) * 19.2 + 53} y={(i === 1 ? .52 : .57) * 1080 - 65}>{s.check}</Bubble></div>)}
    <div style={{ position: "absolute", left: "50%", bottom: "7%", transform: `translateX(-50%) scale(${popIn(t, 4)})`, opacity: clamp(t, 4, 4.15), background: "#1d1c1a", color: "#f4f1ea", fontSize: 25, fontWeight: 500, padding: "13px 25px", borderRadius: 15, whiteSpace: "nowrap" }}>{s.toast}</div>
    {[0, 1, 2, 3, 4].map((i) => <Coin key={i} t={t} at={4.6 + .12 * i} from={[326, 648]} to={[[787, 648], [825, 629], [1247, 667], [1439, 610], [1631, 667]][i] as [number, number]} />)}
  </AbsoluteFill>;
}
