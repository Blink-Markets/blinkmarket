// Deterministic hand-drawn explainer diagrams (ink + pastel highlighters), ported from the approved mockup
// docs/superpowers/specs/assets/2026-10-10-docs-sketches-mockup.html. Pure: no imports, seeded RNG.

export const SKETCHES = ["lifecycle", "pipeline", "agent", "payout"] as const;
export type SketchName = (typeof SKETCHES)[number];

const INK = "#222222";
const HAND = "var(--font-hand, Kalam), Kalam, 'Comic Sans MS', cursive";
const HL = { yellow: "#f7dc6f", blue: "#b9d6f2", green: "#bfe5b8", purple: "#dccbf2", orange: "#f6c4a2", grey: "#d9d9d4" } as const;
type Hl = keyof typeof HL;

const r1 = (n: number): number => Math.round(n * 10) / 10;
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Attrs = Record<string, string | number>;
type LineOpts = { single?: boolean; color?: string; w?: number; dash?: string };
type BoxOpts = { fill?: string; color?: string; w?: number; dash?: string };
type TextOpts = { size?: number; bold?: boolean; color?: string; anchor?: "start" | "middle"; hl?: Hl; hlw?: number };
type ArrowOpts = { bend?: number; dash?: string; color?: string; w?: number; label?: string; lx?: number; ly?: number; lsize?: number; lhl?: Hl };

class Pen {
  private readonly out: string[] = [];
  private readonly rand: () => number;
  constructor(seed: number) {
    this.rand = rng(seed);
  }
  private j(n: number): number {
    return (this.rand() - 0.5) * 2 * n;
  }
  get body(): string {
    return this.out.join("");
  }
  el(name: string, attrs: Attrs, text?: string): void {
    const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(String(v))}"`).join("");
    this.out.push(text == null ? `<${name}${a}/>` : `<${name}${a}>${esc(text)}</${name}>`);
  }
  line(x1: number, y1: number, x2: number, y2: number, o: LineOpts = {}): void {
    for (let pass = 0; pass < (o.single ? 1 : 2); pass++) {
      const mx = (x1 + x2) / 2 + this.j(2.2);
      const my = (y1 + y2) / 2 + this.j(2.2);
      this.el("path", {
        d: `M${r1(x1 + this.j(1))} ${r1(y1 + this.j(1))} Q${r1(mx)} ${r1(my)} ${r1(x2 + this.j(1))} ${r1(y2 + this.j(1))}`,
        fill: "none", stroke: o.color ?? INK, "stroke-width": pass ? 1.1 : (o.w ?? 2.2), "stroke-linecap": "round",
        "stroke-dasharray": o.dash ?? "none", opacity: pass ? 0.55 : 1,
      });
    }
  }
  box(x: number, y: number, w: number, h: number, o: BoxOpts = {}): void {
    if (o.fill) this.el("rect", { x: x + 3, y: y + 3, width: w - 6, height: h - 6, rx: 14, fill: o.fill, opacity: 0.55 });
    const rr = 12;
    this.line(x + rr, y, x + w - rr, y, o); this.line(x + w, y + rr, x + w, y + h - rr, o);
    this.line(x + w - rr, y + h, x + rr, y + h, o); this.line(x, y + h - rr, x, y + rr, o);
    const corners: number[][] = [
      [x + w - rr, y, x + w, y, x + w, y + rr], [x + w, y + h - rr, x + w, y + h, x + w - rr, y + h],
      [x + rr, y + h, x, y + h, x, y + h - rr], [x, y + rr, x, y, x + rr, y],
    ];
    for (const c of corners) {
      const [a = 0, b = 0, cx = 0, cy = 0, d = 0, e = 0] = c;
      this.el("path", {
        d: `M${r1(a + this.j(0.8))} ${r1(b + this.j(0.8))} Q${cx} ${cy} ${r1(d + this.j(0.8))} ${r1(e + this.j(0.8))}`,
        fill: "none", stroke: o.color ?? INK, "stroke-width": o.w ?? 2.2, "stroke-linecap": "round", "stroke-dasharray": o.dash ?? "none",
      });
    }
  }
  highlight(cx: number, cy: number, w: number, color: string, h = 22): void {
    this.el("path", {
      d: `M${r1(cx - w / 2)} ${r1(cy + this.j(1.5))} L${r1(cx + w / 2)} ${r1(cy + this.j(1.5))}`,
      stroke: color, "stroke-width": h, "stroke-linecap": "round", opacity: 0.7, fill: "none",
    });
  }
  text(x: number, y: number, s: string, o: TextOpts = {}): void {
    const size = o.size ?? 22;
    if (o.hl) {
      const hw = (o.hlw ?? s.length * size * 0.5) + 14;
      this.highlight(o.anchor === "start" ? x + hw / 2 - 7 : x, y - size * 0.32, hw, HL[o.hl], size * 0.95);
    }
    this.el("text", { x: r1(x), y: r1(y), "text-anchor": o.anchor ?? "middle", "font-size": size, "font-weight": o.bold ? 700 : 400, fill: o.color ?? INK }, s);
  }
  arrow(x1: number, y1: number, x2: number, y2: number, o: ArrowOpts = {}): void {
    const bend = o.bend ?? 0;
    const mx = (x1 + x2) / 2 - (y2 - y1) * bend + this.j(2);
    const my = (y1 + y2) / 2 + (x2 - x1) * bend + this.j(2);
    this.el("path", {
      d: `M${x1} ${y1} Q${r1(mx)} ${r1(my)} ${x2} ${y2}`, fill: "none", stroke: o.color ?? INK, "stroke-width": o.w ?? 2.2,
      "stroke-linecap": "round", "stroke-dasharray": o.dash ?? "none",
    });
    const ang = Math.atan2(y2 - my, x2 - mx);
    const L = 13;
    for (const d of [0.45, -0.45])
      this.line(x2, y2, x2 - Math.cos(ang + d) * L, y2 - Math.sin(ang + d) * L, { single: true, ...(o.color ? { color: o.color } : {}), w: o.w ?? 2.2 });
    if (o.label) this.text(o.lx ?? mx, o.ly ?? my - 10, o.label, { size: o.lsize ?? 19, ...(o.lhl ? { hl: o.lhl } : {}) });
  }
  title(x: number, s: string, sub?: string): void {
    this.text(x, 58, s, { size: 44, bold: true, hl: "yellow", hlw: s.length * 22 });
    if (sub) this.text(x, 96, sub, { size: 22, hl: "blue", hlw: sub.length * 10.5 });
  }
  foot(x: number, y: number, s: string): void {
    this.text(x, y, s, { size: 19, hl: "grey", hlw: s.length * 9.2 });
  }
}

type Sketch = { seed: number; w: number; h: number; title: string; draw: (p: Pen) => void };

const SKETCH_DEFS: Record<SketchName, Sketch> = {
  lifecycle: {
    seed: 101, w: 1200, h: 720, title: "Market lifecycle",
    draw(s) {
      s.title(600, "Market lifecycle", "who can move a market, and when");
      s.box(60, 170, 210, 110, { fill: HL.green }); s.text(165, 215, "OPEN", { size: 30, bold: true }); s.text(165, 250, "fills allowed", { size: 19 });
      s.arrow(275, 225, 395, 225, { label: "closeAt", lhl: "yellow" });
      s.box(400, 170, 210, 110, { dash: "8 7" }); s.text(505, 215, "CLOSED", { size: 30, bold: true }); s.text(505, 250, "derived, not stored", { size: 18 });
      s.arrow(615, 225, 735, 225, { label: "proposer", lhl: "blue" });
      s.text(675, 304, "YES / NO / INVALID", { size: 16 }); s.text(675, 324, "+ evidence", { size: 16 });
      s.box(740, 170, 220, 110, { fill: HL.blue }); s.text(850, 215, "PROPOSED", { size: 30, bold: true }); s.text(850, 250, "challenge window", { size: 19 });
      s.arrow(850, 285, 850, 395, { label: "challenger + evidence", lx: 735, ly: 365, lhl: "orange" });
      s.box(740, 400, 220, 100, { fill: HL.orange }); s.text(850, 445, "DISPUTED", { size: 30, bold: true }); s.text(850, 478, "arbiter decides", { size: 19 });
      s.box(1000, 300, 160, 120, { fill: HL.purple, w: 2.8 }); s.text(1080, 355, "FINAL", { size: 32, bold: true }); s.text(1080, 390, "irreversible", { size: 18 });
      s.arrow(962, 205, 1050, 296, { bend: -0.15, label: "no challenge", lx: 1080, ly: 210 });
      s.arrow(962, 450, 1040, 424, { bend: 0.1, label: "arbiter", lx: 1015, ly: 485 });
      s.arrow(165, 290, 1000, 560, { bend: -0.12, dash: "10 8", label: "hardDeadline passes, still not FINAL", lx: 520, ly: 548, lhl: "yellow" });
      s.box(1000, 520, 160, 90, { dash: "8 7" }); s.text(1080, 558, "FINAL", { size: 26, bold: true }); s.text(1080, 590, "= INVALID", { size: 20 });
      s.text(300, 640, "After FINAL every holder redeems on their own:", { size: 21, anchor: "start" });
      s.text(300, 676, "YES / NO pays 1 bUSD per winning share · INVALID pays 0.5 per share on each side", { size: 19, anchor: "start", hl: "green", hlw: 690 });
      s.foot(600, 706, "Pause only stops new fills; proposals, challenges, finalize and redeem still work.");
    },
  },
  pipeline: {
    seed: 202, w: 1200, h: 560, title: "Question pipeline",
    draw(s) {
      s.title(600, "From evidence to a market", "a question is frozen before it can trade");
      const folder = (x: number, y: number): void => {
        s.line(x, y + 12, x + 70, y + 12); s.line(x, y + 12, x, y + 62); s.line(x, y + 62, x + 90, y + 62); s.line(x + 90, y + 62, x + 90, y + 20);
        s.line(x + 70, y + 12, x + 76, y + 20); s.line(x + 76, y + 20, x + 90, y + 20);
        s.el("rect", { x: x + 4, y: y + 22, width: 82, height: 36, fill: HL.yellow, opacity: 0.7 });
      };
      folder(70, 160); s.text(115, 255, "Evidence", { size: 22, bold: true }); s.text(115, 282, "original bytes", { size: 17 });
      s.arrow(175, 200, 250, 200);
      s.box(255, 150, 190, 110, { fill: HL.blue }); s.text(350, 195, "Candidate", { size: 26, bold: true }); s.text(350, 228, "draft + revisions", { size: 18 });
      s.arrow(450, 205, 530, 205, { label: "human review", lhl: "green", ly: 134 });
      s.box(535, 150, 180, 110, { fill: HL.green }); s.text(625, 195, "APPROVED", { size: 26, bold: true }); s.text(625, 228, "by an operator", { size: 18 });
      s.arrow(720, 205, 800, 205);
      s.box(805, 140, 230, 130, { fill: HL.purple }); s.text(920, 185, "MarketSpec", { size: 26, bold: true }); s.text(920, 215, "exact UTF-8 bytes", { size: 18 }); s.text(920, 245, "specHash = keccak256", { size: 18 });
      s.arrow(920, 275, 920, 345, { label: "unsigned creation intent", lx: 1060, ly: 315, lhl: "yellow" });
      s.box(780, 350, 280, 100, {}); s.text(920, 390, "Admin wallet", { size: 26, bold: true }); s.text(920, 423, "signs + sends createMarket", { size: 18 });
      s.arrow(775, 400, 610, 400, { label: "Base Sepolia", lhl: "blue", ly: 380 });
      s.box(330, 345, 275, 110, { fill: HL.blue, w: 2.8 }); s.text(467, 390, "Market", { size: 28, bold: true }); s.text(467, 423, "deploymentId + marketId", { size: 18 });
      s.arrow(325, 400, 200, 400, { label: "receipt + 12 confirmations", ly: 486, lx: 200 });
      s.box(60, 350, 135, 100, { dash: "8 7" }); s.text(127, 392, "Tracker", { size: 24, bold: true }); s.text(127, 422, "operator-run", { size: 17 });
      s.foot(600, 520, "The spec is never re-serialised. Nothing in this repository signs or broadcasts the admin transaction.");
    },
  },
  agent: {
    seed: 303, w: 1200, h: 780, title: "Agent integration flow",
    draw(s) {
      s.title(600, "Connecting an agent", "local API at 127.0.0.1:3001");
      s.box(70, 130, 220, 80, { fill: HL.purple }); s.text(180, 180, "Your agent", { size: 26, bold: true });
      s.box(490, 130, 220, 80, { fill: HL.yellow }); s.text(600, 180, "Operator", { size: 26, bold: true });
      s.box(910, 130, 220, 80, { fill: HL.blue }); s.text(1020, 180, "Blink API", { size: 26, bold: true });
      for (const x of [180, 600, 1020]) s.line(x, 215, x, 725, { dash: "4 9", w: 1.6 });
      const step = (y: number, x1: number, x2: number, label: string, sub: string | null, planned = false): void => {
        s.arrow(x1, y, x2, y, { dash: planned ? "10 8" : "none", color: planned ? "#777" : INK });
        s.text((x1 + x2) / 2, y - 12, label, { size: 19, hl: planned ? "grey" : "green", hlw: label.length * 9 });
        if (sub) s.text((x1 + x2) / 2, y + 26, sub, { size: 16, color: planned ? "#666" : INK });
      };
      step(262, 185, 1015, "1  POST /v1/auth/wallet-challenges", "invited API key · Identity mode");
      step(334, 1015, 185, "2  challenge message", null);
      step(406, 185, 595, "3  ask the operator to sign", "outside the agent");
      step(478, 595, 185, "4  signature", null);
      step(550, 185, 1015, "5  POST /v1/auth/wallet-verifications", "wallet bound · Identity mode");
      step(630, 185, 1015, "6  read markets, specs, forecast windows", "Planned (specs: Approval mode)", true);
      step(702, 185, 1015, "7  POST /v1/markets/{id}/forecasts", "Planned · Idempotency-Key on every POST", true);
      s.foot(600, 765, "The agent never creates wallets, holds keys, or signs and sends transactions.");
    },
  },
  payout: {
    seed: 404, w: 1200, h: 600, title: "Collateral and payouts",
    draw(s) {
      s.title(600, "One trade, fully collateralised", "taker buys 100 YES at 6,000 bps");
      s.box(70, 150, 250, 120, { fill: HL.blue }); s.text(195, 195, "Taker", { size: 28, bold: true }); s.text(195, 230, "pays 60 bUSD", { size: 22, hl: "yellow", hlw: 130 });
      s.box(70, 330, 250, 120, { fill: HL.orange }); s.text(195, 375, "Maker", { size: 28, bold: true }); s.text(195, 410, "adds 40 bUSD", { size: 22, hl: "yellow", hlw: 130 });
      s.arrow(325, 210, 485, 280, { bend: -0.08 }); s.arrow(325, 390, 485, 320, { bend: 0.08 });
      s.box(490, 220, 260, 160, { fill: HL.purple, w: 2.8 }); s.text(620, 270, "Contract", { size: 28, bold: true }); s.text(620, 308, "holds 100 bUSD", { size: 22 }); s.text(620, 340, "= 100 complete sets", { size: 19 });
      s.text(620, 412, "taker: 100 YES · maker: 100 NO", { size: 18, hl: "grey", hlw: 270 });
      s.arrow(755, 260, 880, 190, { bend: -0.05 }); s.arrow(755, 300, 880, 300); s.arrow(755, 340, 880, 410, { bend: 0.05 });
      s.box(885, 150, 250, 80, { fill: HL.green }); s.text(1010, 185, "YES", { size: 24, bold: true }); s.text(1010, 214, "taker gets 100", { size: 19 });
      s.box(885, 260, 250, 80, { fill: HL.green }); s.text(1010, 295, "NO", { size: 24, bold: true }); s.text(1010, 324, "maker gets 100", { size: 19 });
      s.box(885, 370, 250, 80, { fill: HL.yellow }); s.text(1010, 405, "INVALID", { size: 24, bold: true }); s.text(1010, 434, "50 each (0.5 per share)", { size: 19 });
      s.foot(600, 530, "Shares are entries in the contract's ledger, not tokens. No early exit: holders redeem after FINAL.");
    },
  },
};

export function renderSketch(name: SketchName): string {
  const d = SKETCH_DEFS[name];
  const pen = new Pen(d.seed);
  d.draw(pen);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.w} ${d.h}" role="img" font-family="${esc(HAND)}">` +
    `<title>${esc(d.title)}</title><rect width="${d.w}" height="${d.h}" fill="#ffffff"/>${pen.body}</svg>`
  );
}
