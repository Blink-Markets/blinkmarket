import { INK } from "./inks";
import type { IllustrationProps } from "./types";

export function Evidence({ className, title = "Evidence snapshot" }: IllustrationProps) {
  return (
    <svg viewBox="0 0 240 240" className={className} role="img" aria-label={title}>
      <path d="M58 28 H170 L196 54 V240 H58 Z" fill="url(#ht-cobalt-60)" />
      <path d="M170 28 V54 H196" fill="none" stroke={INK.cobalt} strokeWidth="2" />
      <rect x="74" y="76" width="96" height="7" fill={INK.paper} />
      <rect x="74" y="94" width="78" height="7" fill={INK.paper} />
      <rect x="74" y="112" width="104" height="7" fill={INK.paper} />
      <rect x="74" y="142" width="64" height="36" fill={INK.cobalt} />
      <path d="M62 160 C 60 128, 146 126, 152 154 S 96 196, 66 170" fill="none" stroke={INK.terracotta} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
