import { INK } from "./inks";

type TrailSvgProps = { viewBox: string; d: string; className?: string; strokeWidth?: number; stretch?: boolean };

// The site's single hand-drawn gesture: a terracotta path drawn as it scrolls into view.
export function TrailSvg({ viewBox, d, className, strokeWidth = 3, stretch = false }: TrailSvgProps) {
  return (
    <svg viewBox={viewBox} className={className} aria-hidden="true" fill="none" data-draw-scope="" {...(stretch ? { preserveAspectRatio: "none" } : {})}>
      <path d={d} pathLength={1} data-draw="" stroke={INK.terracotta} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...(stretch ? { vectorEffect: "non-scaling-stroke" as const } : {})} />
    </svg>
  );
}
