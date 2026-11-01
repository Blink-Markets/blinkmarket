import { AbsoluteFill } from "remotion";
import { shots } from "../script.ts";
import { useShotTime } from "../time.ts";
import { Agent } from "../ui/Agent.tsx";
import { KineticLine } from "../ui/Type.tsx";

export function Hook() {
  const t = useShotTime();
  return <AbsoluteFill style={{ background: "#f4f1ea" }}>
    <div style={{ position: "absolute", left: "9%", top: "28%", width: 1100, fontSize: 138.24, lineHeight: 1.02, letterSpacing: "-.045em" }}><div style={{ whiteSpace: "nowrap" }}><KineticLine line={shots[0]!.lines[0]!} at={0} whole /></div><div style={{ whiteSpace: "nowrap" }}><KineticLine line={shots[0]!.lines[1]!} at={1} whole underlineAt={1.5} /></div></div>
    <Agent role="creator" size={211.968} x={1382.4} y={432} t={t} pose={{ pop: 1.9, hop: 1.9, blinkAt: [3.2] }} />
  </AbsoluteFill>;
}
