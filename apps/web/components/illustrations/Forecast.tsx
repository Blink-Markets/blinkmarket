import { INK } from "./inks";
import type { IllustrationProps } from "./types";

export function Forecast({ className, title = "Forecast dial" }: IllustrationProps) {
  return (
    <svg viewBox="0 0 240 240" className={className} role="img" aria-label={title}>
      <rect x="48" y="48" width="144" height="144" fill="url(#ht-cobalt-30)" stroke={INK.cobalt} />
    </svg>
  );
}
