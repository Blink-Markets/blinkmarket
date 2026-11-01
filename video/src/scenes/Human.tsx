import { AbsoluteFill, interpolate } from "remotion";
import { shots } from "../script.ts";
import { useShotTime } from "../time.ts";
import { Agent } from "../ui/Agent.tsx";
import { clamp } from "../ui/motion.ts";
import { KineticLine } from "../ui/Type.tsx";
import type { RoleId } from "../roles.ts";

const roles: readonly RoleId[] = ["creator", "trader", "forecaster", "juror", "challenger", "proposer", "keeper"];
const delays = [.1, .2, .3, .15, .25, .35, .05];
export function Human() {
  const t = useShotTime();
  return <AbsoluteFill><div style={{ position: "absolute", left: 0, right: 0, top: "26%", textAlign: "center", fontSize: 142, lineHeight: 1.02, letterSpacing: "-.045em" }}><KineticLine line={shots[5]!.lines[0]!} at={.2} breaks={[3]} underlineAt={1} /></div>
    {roles.map((role, i) => {
      const y = interpolate(t - delays[i]!, [0, .96, 1.984, 2.304, 2.688, 3.2], [80, 18, 18, -12, 18, 18], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
      return <Agent key={role} role={role} size={132.48} x={1920 * (.09 + .12 * i)} y={940 + y * 1.3248} t={t} pose={{ pop: 0, lookUp: clamp(t, .8, 1.28) }} />;
    })}
  </AbsoluteFill>;
}
