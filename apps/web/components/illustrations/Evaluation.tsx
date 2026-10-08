import { INK } from "./inks";
import type { IllustrationProps } from "./types";

// Calibration plot: the perfect-calibration diagonal is y = 240 - x.
export function Evaluation({ className, title = "Forecast evaluation" }: IllustrationProps) {
  return (
    <svg viewBox="0 0 240 240" className={className} role="img" aria-label={title}>
      <rect x="78" y="0" width="162" height="162" fill="url(#ht-cobalt-30)" />
      <path d="M78 146 L224 0 H240 V16 L94 162 H78 Z" fill={INK.paper} />
      <path d="M12 8 V228 H232" fill="none" stroke={INK.cobalt} strokeWidth="1.5" />
      <line x1="12" y1="228" x2="240" y2="0" stroke={INK.cobalt} strokeWidth="1.5" strokeDasharray="4 5" />
      {/* Sample counts per bin */}
      <g fill={INK.cobalt}>
        <rect x="136" y="214" width="12" height="14" />
        <rect x="154" y="204" width="12" height="24" />
        <rect x="172" y="192" width="12" height="36" />
        <rect x="190" y="208" width="12" height="20" />
        <rect x="208" y="218" width="12" height="10" />
      </g>
      <circle cx="46" cy="198" r="9" fill="url(#ht-cobalt-60)" />
      <circle cx="68" cy="168" r="10" fill="url(#ht-cobalt-60)" />
      <circle cx="152" cy="86" r="9" fill="url(#ht-cobalt-60)" />
      <g fill={INK.cobalt}>
        <circle cx="28" cy="214" r="4.5" />
        <circle cx="104" cy="138" r="4.5" />
        <circle cx="122" cy="121" r="4.5" />
        <circle cx="139" cy="104" r="4.5" />
        <circle cx="168" cy="69" r="4.5" />
        <circle cx="181" cy="61" r="4.5" />
        <circle cx="203" cy="40" r="4.5" />
        <circle cx="216" cy="25" r="4.5" />
        <circle cx="150" cy="150" r="5" />
      </g>
      {/* The outlier */}
      <path d="M138 139 C 150 128, 172 136, 169 153 C 166 170, 140 172, 133 158 C 129 148, 136 140, 146 137" fill="none" stroke={INK.terracotta} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
