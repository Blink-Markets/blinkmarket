import { ImageResponse } from "next/og";

export const alt = "Blink: every forecast leaves a trail";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PAPER = "#FAFAF7";
const COBALT = "#2148B8";
const TERRACOTTA = "#C65F38";
const INK = "#242321";
const INK_SOFT = "#242321B3";

// Satori cannot read the woff2 files shipped with next, so fetch Geist TTFs from Google Fonts at build time.
async function geist(weight: number): Promise<ArrayBuffer> {
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=Geist:wght@${weight}`)).text();
  const url = /src: url\((.+?)\) format\('truetype'\)/.exec(css)?.[1];
  if (!url) throw new Error(`Geist ${weight} font URL not found`);
  return (await fetch(url)).arrayBuffer();
}

function ridge(x: number): number {
  return 400 - 26 * Math.sin(x * 0.004 + 0.6) - 12 * Math.sin(x * 0.011 + 2.1) - 60 * Math.exp(-Math.pow((x - 1320) / 130, 2));
}

function Landscape() {
  const top: string[] = [];
  for (let x = 0; x <= 1600; x += 8) top.push(`${x} ${ridge(x).toFixed(1)}`);
  const hatch: { d: string; opacity: number; dash: string }[] = [];
  for (let k = 1; k < 14; k++) {
    const row: string[] = [];
    for (let x = 0; x <= 1600; x += 10) row.push(`${x} ${(ridge(x) + k * 6 + Math.sin(x * 0.05 + k)).toFixed(1)}`);
    hatch.push({ d: `M${row.join(" L")}`, opacity: Number((0.55 - k * 0.03).toFixed(2)), dash: `${30 + k * 6} ${6 + k}` });
  }
  // viewBox crops the mockup's 1600x150 strip the way "xMidYMax slice" does at 1200x170.
  return (
    <svg width="1200" height="170" viewBox="270.5 330 1059 150" style={{ position: "absolute", left: 0, bottom: 0 }}>
      <path d={`M0 480 L${top.join(" L")} L1600 480 Z`} fill={COBALT} />
      {hatch.map((h, i) => (
        <path key={i} d={h.d} fill="none" stroke={PAPER} strokeWidth="1" opacity={h.opacity} strokeDasharray={h.dash} />
      ))}
      <path d="M300 480 C 520 452, 760 448, 1030 418" fill="none" stroke={TERRACOTTA} strokeWidth="4" strokeLinecap="round" />
      <circle cx="1030" cy="396" r="22" fill={PAPER} />
      <path d="M1016 396 Q1030 384 1044 396 Q1030 408 1016 396 Z" fill="none" stroke={COBALT} strokeWidth="2.4" />
      <circle cx="1030" cy="396" r="4.5" fill={COBALT} />
    </svg>
  );
}

export default async function OpengraphImage() {
  const [bold, regular] = await Promise.all([geist(800), geist(400)]);
  return new ImageResponse(
    (
      <div style={{ width: 1200, height: 630, display: "flex", position: "relative", background: PAPER, fontFamily: "Geist", color: INK }}>
        <div style={{ position: "absolute", left: 72, right: 72, top: 64, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", fontWeight: 800, fontSize: 40, letterSpacing: "-0.05em" }}>
            <svg width="56" height="36" viewBox="0 0 34 22" style={{ marginRight: 14 }}>
              <path d="M2 11 Q17 -3 32 11 Q17 25 2 11 Z" fill="none" stroke={COBALT} strokeWidth="2.4" strokeLinejoin="round" />
              <circle cx="17" cy="11" r="5.2" fill={COBALT} />
              <circle cx="19" cy="9" r="1.4" fill={TERRACOTTA} />
            </svg>
            Blink
          </div>
          <div style={{ display: "flex", fontSize: 18, letterSpacing: "0.08em", textTransform: "uppercase", color: COBALT, border: `2px solid ${COBALT}`, padding: "6px 12px" }}>
            Base Sepolia testnet
          </div>
        </div>
        <div style={{ position: "absolute", left: 72, top: 160, display: "flex", flexDirection: "column", fontSize: 104, fontWeight: 800, letterSpacing: "-0.055em", lineHeight: 0.92 }}>
          <div style={{ display: "flex" }}>every forecast</div>
          <div style={{ display: "flex" }}>
            <span style={{ display: "flex" }}>leaves a&nbsp;</span>
            <span style={{ display: "flex", color: TERRACOTTA, borderBottom: `10px solid ${TERRACOTTA}` }}>trail</span>
          </div>
        </div>
        <div style={{ position: "absolute", left: 72, top: 400, display: "flex", width: 390, fontSize: 26, fontWeight: 400, color: INK_SOFT, lineHeight: 1.35 }}>
          Prediction research for agents: explicit rules, traceable evidence, test trades only.
        </div>
        <Landscape />
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Geist", data: bold, weight: 800, style: "normal" },
        { name: "Geist", data: regular, weight: 400, style: "normal" },
      ],
    },
  );
}
