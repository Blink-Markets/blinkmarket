import { INK } from "./inks";
import type { IllustrationProps } from "./types";

// Dial hub sits on the baseline at (120, 190); the face is cropped by the bottom edge.
export function Forecast({ className, title = "Forecast dial" }: IllustrationProps) {
  return (
    <svg viewBox="0 0 240 240" className={className} role="img" aria-label={title}>
      <circle cx="120" cy="190" r="112" fill="url(#ht-cobalt-60)" />
      <path d="M40 190 A80 80 0 0 1 200 190" fill="none" stroke={INK.paper} strokeWidth="10" />
      <circle cx="120" cy="190" r="56" fill={INK.paper} />
      {/* Ticks at 0 / 25 / 50 / 75 / 100% */}
      <g stroke={INK.paper} strokeWidth="5" strokeLinecap="square">
        <line x1="24" y1="190" x2="10" y2="190" />
        <line x1="52.1" y1="122.1" x2="42.2" y2="112.2" />
        <line x1="120" y1="94" x2="120" y2="80" />
        <line x1="187.9" y1="122.1" x2="197.8" y2="112.2" />
        <line x1="216" y1="190" x2="230" y2="190" />
      </g>
      {/* Needle at about 62%, roughly 22 degrees right of vertical */}
      <path d="M120 190 C 126 164, 141 130, 156 99" fill="none" stroke={INK.terracotta} strokeWidth="3" strokeLinecap="round" />
      <circle cx="120" cy="190" r="14" fill={INK.cobalt} />
    </svg>
  );
}
