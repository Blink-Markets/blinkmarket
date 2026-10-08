import { INK } from "./inks";
import type { IllustrationProps } from "./types";

// Dial hub sits on the baseline at (132, 192); the face is cropped by the bottom and right edges.
export function Forecast({ className, title = "Forecast dial" }: IllustrationProps) {
  return (
    <svg viewBox="0 0 240 240" className={className} role="img" aria-label={title}>
      <circle cx="132" cy="192" r="112" fill="url(#ht-cobalt-60)" />
      <path d="M52 192 A80 80 0 0 1 212 192" fill="none" stroke={INK.paper} strokeWidth="10" />
      <circle cx="132" cy="192" r="56" fill={INK.paper} />
      {/* Ticks at 0 / 25 / 50 / 75 / 100% */}
      <g stroke={INK.cobalt} strokeWidth="7">
        <line x1="42" y1="192" x2="20" y2="192" />
        <line x1="68.4" y1="128.4" x2="52.8" y2="112.8" />
        <line x1="132" y1="102" x2="132" y2="80" />
        <line x1="195.6" y1="128.4" x2="211.2" y2="112.8" />
        <line x1="222" y1="192" x2="244" y2="192" />
      </g>
      {/* Needle at about 62%, roughly 22 degrees right of vertical */}
      <path d="M132 192 C 137 166, 150 138, 154 128 S 163 111, 167 104" fill="none" stroke={INK.terracotta} strokeWidth="3" strokeLinecap="round" />
      <circle cx="132" cy="192" r="15" fill={INK.cobalt} />
    </svg>
  );
}
