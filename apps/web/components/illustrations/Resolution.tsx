import { INK } from "./inks";
import type { IllustrationProps } from "./types";

// Stamp offset up and left; the faint ring is a 4px registration drift.
export function Resolution({ className, title = "Resolution stamp" }: IllustrationProps) {
  return (
    <svg viewBox="0 0 240 240" className={className} role="img" aria-label={title}>
      <circle cx="110" cy="104" r="72" fill="none" stroke="url(#ht-cobalt-15)" strokeWidth="22" />
      <circle cx="106" cy="100" r="72" fill="none" stroke="url(#hatch-cobalt)" strokeWidth="22" />
      <circle cx="106" cy="100" r="48" fill={INK.cobalt} />
      <path d="M81 102 L98 119 L132 84" fill="none" stroke={INK.paper} strokeWidth="12" strokeLinecap="square" strokeLinejoin="miter" />
      <path d="M30 207 C 70 193, 108 211, 146 205 S 196 192, 216 197" fill="none" stroke={INK.terracotta} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
