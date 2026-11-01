import { AbsoluteFill } from "remotion";
import { ROLES } from "../roles.ts";
import { screen, shots } from "../script.ts";
import { useShotTime } from "../time.ts";
import { Agent } from "../ui/Agent.tsx";
import { blink, clamp, popIn } from "../ui/motion.ts";
import { KineticLine } from "../ui/Type.tsx";

// "This is" sits above the emblem row; the pair is one block centred on the frame.
const TITLE_SIZE = 138.24, TITLE_LINE = TITLE_SIZE * 1.02, TITLE_GAP = 56, EMBLEM = 345.6;
const ROW_Y = 540 + (TITLE_LINE + TITLE_GAP) / 2;

export function Ending() {
  const t = useShotTime();
  const gather = clamp(t, 2.3, 2.85);
  const open = clamp(t, 3.25, 3.85);
  const eye = Math.min(blink(t, 3.9), blink(t, 3.9 + 1 / 3));
  return <AbsoluteFill>
    <div style={{ opacity: 1 - gather }}>{ROLES.map((role, i) => <Agent key={role.id} role={role.id} size={88.32} x={1920 * (.12 + .1 * i) + 1920 * (.36 - .1 * i) * gather} y={475.2 + (ROW_Y - 475.2) * gather} t={t} pose={{ pop: i * .07, sway: 0, blinkAt: [1.265, 1.595], scale: 1 - .85 * gather }} />)}</div>
    <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: TITLE_GAP }}>
      <div style={{ fontSize: TITLE_SIZE, lineHeight: 1.02, letterSpacing: "-.045em", whiteSpace: "nowrap" }}><KineticLine line={shots[8]!.lines[0]!} at={2} whole /></div>
      <div style={{ display: "flex", alignItems: "center" }}>
      <svg viewBox="0 0 64 64" width={EMBLEM} height={EMBLEM} style={{ transform: `scale(${popIn(t, 2.75)})`, flexShrink: 0 }}><rect width="64" height="64" rx="14" fill="#2148B8" /><g style={{ transform: `scaleY(${eye})`, transformOrigin: "center" }}><path d="M8 32 Q32 8 56 32 Q32 56 8 32 Z" fill="none" stroke="#FAFAF7" strokeWidth="5.5" strokeLinejoin="round" /><circle cx="32" cy="32" r="10" fill="#FAFAF7" /><circle cx="35.5" cy="28.5" r="3" fill="#C65F38" /></g></svg>
      <div style={{ maxWidth: 768 * open, marginLeft: 50 * open, overflow: "hidden", whiteSpace: "nowrap", fontWeight: 700, fontSize: 211.2, letterSpacing: "-.06em", paddingBlock: ".1em" }}>{[...screen.ending.wordmark].map((letter, i) => <span key={i} style={{ display: "inline-block", opacity: clamp(t, 3.35 + i * .08, 3.55 + i * .08), transform: `scale(${popIn(t, 3.35 + i * .08)})` }}>{letter}</span>)}</div>
      </div>
    </div>
  </AbsoluteFill>;
}
