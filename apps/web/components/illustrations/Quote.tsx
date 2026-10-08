import { INK } from "./inks";
import type { IllustrationProps } from "./types";

// Ticket rotated -8 degrees; the halftone stub bleeds off the right edge.
export function Quote({ className, title = "Signed quote" }: IllustrationProps) {
  return (
    <svg viewBox="0 0 240 240" className={className} role="img" aria-label={title}>
      <g transform="rotate(-8 120 120)">
        <rect x="26" y="62" width="144" height="120" fill={INK.cobalt} />
        <rect x="170" y="62" width="96" height="120" fill="url(#ht-cobalt-60)" />
        <circle cx="170" cy="62" r="11" fill={INK.paper} />
        <circle cx="170" cy="182" r="11" fill={INK.paper} />
        <line x1="170" y1="80" x2="170" y2="164" stroke={INK.paper} strokeWidth="3" strokeDasharray="6 6" />
        <rect x="46" y="86" width="92" height="7" fill={INK.paper} />
        <rect x="46" y="104" width="64" height="7" fill={INK.paper} />
        <rect x="46" y="130" width="54" height="24" fill={INK.paper} />
        <path d="M42 166 C 64 160, 90 171, 120 161" fill="none" stroke={INK.terracotta} strokeWidth="3" strokeLinecap="round" />
      </g>
    </svg>
  );
}
