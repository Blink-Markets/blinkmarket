import { interpolate, spring } from "remotion";

export const clamp = (t: number, a: number, b: number) => interpolate(t, [a, b], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
export function popIn(t: number, delay: number) {
  return t < delay ? 0 : spring({ frame: (t - delay) * 30, fps: 30, config: { damping: 11, stiffness: 180 } });
}
export function hop(t: number, at: number) {
  const phase = ((t - at) % 1 + 1) % 1;
  return interpolate(phase, [0, .3, .55, .8, 1], [0, -0.26, -0.3, 0, 0]);
}
export function blink(t: number, at: number) {
  const d = Math.abs(t - at);
  return d >= .1 ? 1 : .12 + .88 * d / .1;
}
export function shake(t: number, at: number, duration?: number) {
  if (t < at || t >= at + (duration ?? .8)) return 0;
  return duration === undefined ? 9 * Math.sin((t - at) * Math.PI * 5) : -9 * Math.sin((t - at) * Math.PI * 4);
}
