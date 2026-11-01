import { AbsoluteFill } from "remotion";
import { ROLES } from "../roles.ts";
import { screen, shots } from "../script.ts";
import { useShotTime } from "../time.ts";
import { Agent } from "../ui/Agent.tsx";
import { clamp, popIn } from "../ui/motion.ts";
import { KineticLine } from "../ui/Type.tsx";

const s = screen.montage;
const card = { background: "white", borderRadius: 15, padding: "17px 21px", boxShadow: "0 15px 31px -17px #0005" };
function Prop({ index, t }: { index: number; t: number }) {
  const p = clamp(t, .3, .55) * (1 - clamp(t, 1.28, 1.5));
  const common = { position: "absolute" as const, left: "31%", top: ["34%", "30%", "42%", "30%", "42%", "26%", "42%", "34%"][index], opacity: p, transform: `scale(${.6 + .4 * p})`, transformOrigin: "left center" };
  return <div style={common}>
    {index === 0 && <div style={{ ...card, width: 326, border: "1.5px solid #2148b8", fontSize: 25, lineHeight: 1.3, position: "relative" }}>{s.question}<span style={{ position: "absolute", right: -19, bottom: -19, width: 61, height: 61, borderRadius: "50%", background: "#e3a62a", border: "5px solid white", color: "white", display: "grid", placeItems: "center", fontSize: 15, transform: `scale(${popIn(t, .75)})` }}>{s.bond}</span></div>}
    {index === 1 && <><span style={{ background: "white", border: "1.5px solid #1d1c1a", borderRadius: 19, padding: "5px 15px", fontSize: 31 }}>{s.quote}</span><div style={{ marginTop: 100, background: "#1d1c1a", color: "white", borderRadius: 13, padding: "13px 19px", fontSize: 31, opacity: clamp(t, .55, .75) }}>{s.price} <small style={{ fontSize: 16, color: "#9be3bd" }}>{s.signed}</small></div></>}
    {index === 2 && <div style={{ display: "flex", gap: 19 }}>{[s.yes, s.no].map((v, i) => <span key={v} style={{ border: "4px solid #1d1c1a", borderRadius: 15, background: i === 0 && t >= .95 ? "#2f9e6e" : "white", color: i === 0 && t >= .95 ? "white" : "#1d1c1a", padding: "13px 27px", fontSize: 38, fontWeight: 700 }}>{v}</span>)}</div>}
    {index === 3 && <div style={{ ...card, width: 288 }}><b style={{ fontSize: 61, color: "#2f9fd0" }}>{s.probability}</b><svg viewBox="0 0 100 30" style={{ width: "100%", height: 58 }}>{["M2 6 C30 3 60 9 96 5", "M2 16 C25 13 55 19 80 15", "M2 26 C20 23 40 28 60 25"].map((d, i) => <path key={d} d={d} fill="none" stroke="#1d1c1a55" strokeWidth="2" strokeDasharray="120" strokeDashoffset={120 * (1 - clamp(t, .6 + i * .2, .95 + i * .2))} />)}</svg></div>}
    {index === 4 && <div style={{ ...card, border: "1.5px solid #1d1c1a", fontSize: 31 }}><svg viewBox="0 0 24 24" width="38" style={{ verticalAlign: "middle", marginRight: 19 }}><path d="M8 13 L15 6 a3 3 0 0 1 4 4 L10 19 a5 5 0 0 1 -7 -7 L11 4" fill="none" stroke="#1d1c1a" strokeWidth="2" strokeLinecap="round" /></svg>{s.result}<small style={{ display: "block", marginLeft: 45, fontSize: 17, opacity: .6 }}>{s.evidence}</small></div>}
    {index === 5 && <span style={{ fontSize: 173, lineHeight: 1, fontWeight: 700, color: "#d4562f" }}>{s.bang}</span>}
    {index === 6 && <div style={{ display: "flex", gap: 23 }}>{[0, 1, 2].map((i) => { const flip = clamp(t, .9 + i * .1, 1.15 + i * .1); return <div key={i} style={{ width: 96, height: 69, display: "grid", placeItems: "center", borderRadius: 10, border: "3px solid #1d1c1a", background: flip >= .5 ? "#2f9e6e" : "white", color: "white", fontSize: 38, transform: `scaleX(${Math.abs(1 - 2 * flip)})` }}>{flip >= .5 ? s.check : <svg width="90" height="40"><path d="M0 0 L45 32 L90 0" fill="none" stroke="#1d1c1a" strokeWidth="2" /></svg>}</div>; })}</div>}
    {index === 7 && <div style={{ display: "flex", alignItems: "center", gap: 27 }}><svg width="154" viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="white" stroke="#1d1c1a" strokeWidth="5"/><line x1="50" y1="50" x2="50" y2="16" stroke="#e0679a" strokeWidth="7" strokeLinecap="round" transform={`rotate(${-270 * (1 - clamp(t, .3, 1))} 50 50)`}/><circle cx="50" cy="50" r="5" fill="#1d1c1a"/></svg><span style={{ padding: "10px 17px", borderRadius: 99, background: t >= 1.05 ? "#2f9e6e" : "#1d1c1a14", color: t >= 1.05 ? "white" : "#1d1c1a", fontSize: 27, whiteSpace: "nowrap" }}>{t >= 1.05 ? s.final : s.proposed}</span></div>}
  </div>;
}
export function Montage() {
  const t = useShotTime();
  const index = Math.floor((t - .5) / 1.5);
  const local = t - (.5 + index * 1.5);
  const active = index >= 0 && index < ROLES.length;
  const r = active ? ROLES[index]! : undefined;
  const life = active ? (1 - clamp(local, 1.2, 1.5)) : 0;
  return <AbsoluteFill style={{ background: "#f4f1ea" }}>
    {r && <><div style={{ opacity: life }}><Agent role={r.id} size={r.id === "maker" ? 229.632 : 264.96} x={(r.id === "maker" || r.id === "proposer" || r.id === "juror" ? .13 : .14) * 1920} y={(r.id === "maker" || r.id === "juror" || r.id === "keeper" ? .38 : .36) * 1080} t={local} pose={{ pop: 0, hop: 0, shake: r.id === "challenger" ? .3 : undefined, scale: 1 - .7 * clamp(local, 1.2, 1.5) }} /><Prop index={index} t={local} /><div style={{ position: "absolute", left: "53%", top: "38%", width: "44%", fontSize: 74.88, lineHeight: 1.02, letterSpacing: "-.045em", opacity: clamp(local, 0, .27) }}>{<span style={{ color: r.color }}>{shots[1]!.lines[index]!.text.split(" ")[0]}</span>} {shots[1]!.lines[index]!.text.split(" ").slice(1).join(" ")}</div></div></>}
    {ROLES.map((role, i) => <Agent key={role.id} role={role.id} size={97.152} x={(12 + 10.5 * i) * 19.2} y={885.6} t={t} pose={{ pop: 1.8 + 1.5 * i, sway: 1.8 + 1.5 * i }} />)}
    <div style={{ position: "absolute", left: 0, right: 0, top: "34%", textAlign: "center", fontSize: 115.2, lineHeight: 1.02, letterSpacing: "-.045em" }}><KineticLine line={shots[1]!.lines[8]!} at={12.5} /></div>
  </AbsoluteFill>;
}
