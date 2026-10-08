import { INK } from "./inks";

// Shared screens referenced as fill="url(#ht-cobalt-60)" from any inline SVG on the page.
const screens = [
  { id: "ht-cobalt-15", r: 0.9, color: INK.cobalt },
  { id: "ht-cobalt-30", r: 1.4, color: INK.cobalt },
  { id: "ht-cobalt-60", r: 2.1, color: INK.cobalt },
  { id: "ht-cobalt-90", r: 2.7, color: INK.cobalt },
  { id: "ht-terracotta-60", r: 2.1, color: INK.terracotta },
];

// Paper-coloured screens for knockouts on solid cobalt (Aperture iris). Not an extra ink.
const paperScreens = [
  { id: "ht-paper-30", r: 1.5 },
  { id: "ht-paper-60", r: 2.4 },
];

export function HalftoneDefs() {
  return (
    <svg aria-hidden="true" focusable="false" width="0" height="0" style={{ position: "absolute" }}>
      <defs>
        {screens.map((s) => (
          <pattern key={s.id} id={s.id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <circle cx="3" cy="3" r={s.r} fill={s.color} />
          </pattern>
        ))}
        {paperScreens.map((s) => (
          <pattern key={s.id} id={s.id} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <circle cx="3.5" cy="3.5" r={s.r} fill={INK.paper} />
          </pattern>
        ))}
        <pattern id="hatch-cobalt" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)">
          <line x1="0" y1="0" x2="0" y2="5" stroke={INK.cobalt} strokeWidth="1.2" />
        </pattern>
      </defs>
    </svg>
  );
}
