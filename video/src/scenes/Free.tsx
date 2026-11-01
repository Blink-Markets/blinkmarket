import { AbsoluteFill } from "remotion";
import { shots } from "../script.ts";
import { KineticLine } from "../ui/Type.tsx";

export function Free() {
  const line = shots[7]!.lines[0]!;
  const [first, second, ...last] = line.text.split(". ");
  return <AbsoluteFill><div style={{ position: "absolute", left: 0, right: 0, top: "38%", textAlign: "center", fontSize: 107.52, lineHeight: 1.02, letterSpacing: "-.045em" }}><KineticLine line={{ text: `${first}.` }} at={.2} />{"  "}<KineticLine line={{ text: `${second}.` }} at={.8} />{"  "}<KineticLine line={{ text: last.join(". "), accent: line.accent }} at={1.4} underlineAt={2} /></div></AbsoluteFill>;
}
