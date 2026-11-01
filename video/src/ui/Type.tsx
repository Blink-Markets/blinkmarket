import { useShotTime } from "../time.ts";
import type { Line } from "../script.ts";
import { clamp, popIn } from "./motion.ts";

export function KineticLine({ line, at, breaks = [], underlineAt }: { line: Line; at: number; breaks?: readonly number[]; underlineAt?: number }) {
  const t = useShotTime();
  const parts = line.accent ? [line.text.slice(0, -line.accent.length).trimEnd(), line.accent] : [line.text];
  let index = 0;
  return <>{parts.map((part, p) => {
    const start = index;
    const words = part.split(" ");
    index += words.length;
    const drawAt = underlineAt ?? at + (index - 1) * .15 + .35;
    return <span key={p}>{breaks.includes(start) && p > 0 && <br />}<span style={{ display: line.accent && p === 1 ? "inline-block" : undefined, position: "relative", color: line.accent && p === 1 ? "#d4562f" : undefined, whiteSpace: line.accent && p === 1 ? "nowrap" : undefined }}>{words.map((word, i) => {
      const delay = at + (start + i) * .15;
      const progress = clamp(t, delay, delay + .35);
      return <span key={i}>{breaks.includes(start + i) && !(p > 0 && i === 0) && <br />}<span style={{ display: "inline-block", opacity: progress, transform: `translateY(${(1 - progress) * .38}em) scale(${.88 + .12 * popIn(t, delay)})`, filter: `blur(${10 * (1 - progress)}px)` }}>{word}{i < words.length - 1 ? "\u00a0" : ""}</span></span>;
    })}{line.accent && p === 1 && <svg viewBox="0 0 200 12" preserveAspectRatio="none" style={{ position: "absolute", left: "-2%", bottom: "-.16em", width: "104%", height: ".32em", overflow: "visible" }}><path d="M3 8 C 50 2, 110 11, 197 4" fill="none" stroke="#d4562f" strokeWidth="3.2" strokeLinecap="round" strokeDasharray="220" strokeDashoffset={220 * (1 - clamp(t, drawAt, drawAt + .55))} /></svg>}</span>{p < parts.length - 1 ? "\u00a0" : ""}</span>;
  })}</>;
}
export function LineSwap({ lines, at, underlineAt }: { lines: readonly Line[]; at: readonly number[]; underlineAt?: readonly (number | undefined)[] }) {
  const t = useShotTime();
  const index = at.reduce((found, start, i) => t >= start ? i : found, -1);
  return index < 0 || !lines[index] ? null : <KineticLine line={lines[index]} at={at[index]!} underlineAt={underlineAt?.[index]} />;
}
