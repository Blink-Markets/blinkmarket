import type { CSSProperties } from "react";
import { INK } from "./inks";
import type { IllustrationProps } from "./types";

const label: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 14, letterSpacing: "0.06em" };
const line = { stroke: INK.cobalt, strokeWidth: 1.5, fill: "none" } as const;

export function Architecture({ className, title = "Target architecture: web and wallets request quotes from the API; the backend (API, worker, PostgreSQL, evidence storage) asks a private signer for signed quotes; wallets fill and redeem directly on Base Sepolia (BlinkMarket, BlinkTestUSD); an indexer syncs chain events into PostgreSQL. Not a live deployment." }: IllustrationProps) {
  return (
    <svg viewBox="0 0 960 540" className={className} role="img" aria-label={title}>
      {/* Web + Wallet */}
      <rect x="24" y="200" width="140" height="96" fill={INK.paper} stroke={INK.cobalt} strokeWidth="1.5" />
      <line x1="24" y1="218" x2="164" y2="218" {...line} />
      <g fill={INK.cobalt}>
        <circle cx="35" cy="209" r="2.5" />
        <circle cx="44" cy="209" r="2.5" />
        <circle cx="53" cy="209" r="2.5" />
      </g>
      <text x="94" y="264" textAnchor="middle" fill={INK.ink} style={label}>WEB + WALLET</text>

      {/* Backend */}
      <rect x="232" y="140" width="310" height="330" fill="url(#ht-cobalt-15)" stroke={INK.cobalt} strokeWidth="1" />
      <rect x="248" y="158" width="86" height="26" fill={INK.paper} />
      <text x="256" y="176" fill={INK.ink} style={label}>BACKEND</text>
      <rect x="256" y="196" width="124" height="60" fill={INK.cobalt} />
      <text x="318" y="231" textAnchor="middle" fill={INK.paper} style={label}>API</text>
      <rect x="404" y="196" width="124" height="60" fill={INK.cobalt} />
      <text x="466" y="231" textAnchor="middle" fill={INK.paper} style={label}>WORKER</text>
      <path d="M256 352 H300 L310 362 H380 V430 H256 Z" fill={INK.paper} stroke={INK.cobalt} strokeWidth="1.5" strokeLinejoin="round" />
      <text x="318" y="402" textAnchor="middle" fill={INK.ink} style={label}>EVIDENCE</text>
      <path d="M404 336 V432 A62 12 0 0 0 528 432 V336" fill={INK.paper} stroke={INK.cobalt} strokeWidth="1.5" />
      <ellipse cx="466" cy="336" rx="62" ry="12" fill={INK.paper} stroke={INK.cobalt} strokeWidth="1.5" />
      <text x="466" y="394" textAnchor="middle" fill={INK.ink} style={label}>POSTGRESQL</text>

      {/* Private signer */}
      <rect x="676" y="226" width="110" height="104" fill={INK.paper} stroke={INK.cobalt} strokeWidth="1.5" />
      <path d="M724 252 V246 A7 7 0 0 1 738 246 V252" fill="none" stroke={INK.cobalt} strokeWidth="2.5" />
      <rect x="720" y="252" width="22" height="16" fill={INK.cobalt} />
      <text x="731" y="294" textAnchor="middle" fill={INK.ink} style={label}>PRIVATE</text>
      <text x="731" y="314" textAnchor="middle" fill={INK.ink} style={label}>SIGNER</text>

      {/* Base Sepolia */}
      <text x="806" y="196" fill={INK.ink} style={label}>BASE SEPOLIA</text>
      <rect x="806" y="210" width="130" height="42" fill={INK.cobalt} />
      <text x="871" y="236" textAnchor="middle" fill={INK.paper} style={label}>BLINKMARKET</text>
      <rect x="806" y="260" width="130" height="42" fill={INK.cobalt} />
      <text x="871" y="286" textAnchor="middle" fill={INK.paper} style={label}>BLINKTESTUSD</text>

      {/* Indexer */}
      <rect x="806" y="400" width="130" height="52" fill={INK.paper} stroke={INK.cobalt} strokeWidth="1.5" />
      <text x="871" y="431" textAnchor="middle" fill={INK.ink} style={label}>INDEXER</text>

      {/* Arrows */}
      <g {...line} strokeLinecap="round" strokeLinejoin="round">
        <path d="M168 226 H252 M245 221 L252 226 L245 231" />
        <path d="M546 252 H672 M665 247 L672 252 L665 257" />
        <path d="M672 304 H546 M553 299 L546 304 L553 309" />
        <path d="M871 306 V396 M866 389 L871 396 L876 389" />
        <path d="M802 426 H532 M539 421 L532 426 L539 431" />
      </g>
      <text x="198" y="214" textAnchor="middle" fill={INK.ink} style={label}>RFQ</text>
      <text x="609" y="240" textAnchor="middle" fill={INK.ink} style={label}>SIGN REQUEST</text>
      <text x="609" y="328" textAnchor="middle" fill={INK.ink} style={label}>SIGNED QUOTE</text>
      <text x="883" y="356" fill={INK.ink} style={label}>EVENTS</text>
      <text x="667" y="414" textAnchor="middle" fill={INK.ink} style={label}>SYNC</text>

      {/* Funds trail: wallets fill and redeem directly on chain */}
      <path
        d="M94 194 C 112 120, 236 70, 420 64 C 556 52, 700 66, 790 104 C 832 122, 856 146, 866 170 M851 161 L867 172 L869 153"
        fill="none"
        stroke={INK.terracotta}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text x="480" y="50" textAnchor="middle" fill={INK.ink} style={label}>FILL / REDEEM</text>
    </svg>
  );
}
