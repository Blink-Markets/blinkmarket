import { INK } from "./inks";
import type { IllustrationProps } from "./types";

export function Architecture({ className, title = "Blink target architecture" }: IllustrationProps) {
  return (
    <svg viewBox="0 0 960 540" className={className} role="img" aria-label={title}>
      <rect x="192" y="108" width="576" height="324" fill="url(#ht-cobalt-30)" stroke={INK.cobalt} />
    </svg>
  );
}
