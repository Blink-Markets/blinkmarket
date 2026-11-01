import type { ReactNode } from "react";
import { AbsoluteFill } from "remotion";
import type { Transition } from "../script.ts";
import { useShotTime } from "../time.ts";
import { clamp, popIn } from "./motion.ts";

export function ShotTransition({ in: entrance, out, duration, children }: { in: Transition; out: Transition | null; duration: number; children: ReactNode }) {
  const t = useShotTime();
  const enter = clamp(t, 0, .6);
  const exit = out ? clamp(t, duration - .38, duration) : 0;
  const amount = exit || (1 - enter);
  const kind = exit ? out : entrance;
  const transform = kind === "whip" ? `translateX(${(exit ? -42 : 42) * amount}%)` : kind === "zoom" ? `scale(${exit ? 1 + 1.2 * amount : 1 + .4 * amount})` : kind === "pop" && !exit ? `scale(${.86 + .14 * popIn(t, 0)})` : `scale(${1 - .06 * amount})`;
  return <AbsoluteFill style={{ opacity: enter * (1 - exit), transform, filter: `blur(${(kind === "whip" ? 18 : kind === "zoom" ? 12 : kind === "fade" ? 6 : 0) * amount}px)` }}>{children}</AbsoluteFill>;
}
