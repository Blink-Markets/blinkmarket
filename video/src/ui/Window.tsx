import type { ReactNode } from "react";
import { clamp, popIn } from "./motion.ts";

export function Sketch({ t, color }: { t: number; color: string }) {
  return <svg viewBox="0 0 1000 560" preserveAspectRatio="none" style={{ position: "absolute", left: "2.2%", top: "2.6%", width: "95.6%", height: "94.8%", overflow: "visible" }}><path d="M28 6 C 300 2, 700 9, 972 5 C 990 6, 995 18, 994 32 C 996 200, 992 380, 995 528 C 994 545, 984 553, 968 554 C 700 557, 300 552, 30 555 C 12 553, 5 543, 6 526 C 3 380, 8 200, 5 30 C 6 14, 14 7, 28 6 Z" fill="none" stroke={color} strokeWidth="2.2" strokeDasharray="3400" strokeDashoffset={3400 * (1 - clamp(t, .1, 1.1))} /></svg>;
}

export function ProductWindow({ t, title, side, children }: { t: number; title: string; side: "left" | "right"; children: ReactNode }) {
  const right = side === "right";
  const flow = (1 - Math.cos(t * Math.PI / 6)) / 2;
  return <div style={{ position: "absolute", left: right ? "44%" : "5%", right: right ? "5%" : "44%", top: "9%", bottom: "9%", borderRadius: 27, overflow: "hidden", background: right ? "radial-gradient(55% 75% at 18% 22%, #2148b8 0 30%, transparent 62%), radial-gradient(45% 60% at 86% 78%, #e3a62a 0 26%, transparent 60%), radial-gradient(60% 60% at 62% 28%, #6c8de8 0 22%, transparent 60%), #f2c7a3" : "radial-gradient(55% 75% at 18% 22%, #d4562f 0 30%, transparent 62%), radial-gradient(45% 60% at 86% 78%, #ffe08a 0 26%, transparent 60%), radial-gradient(60% 60% at 62% 28%, #e8742f 0 22%, transparent 60%), #f6b37a", backgroundSize: "160% 160%", backgroundPosition: `${flow * 100}% ${flow * 60}%` }}>
    <div style={{ position: "absolute", left: right ? "7%" : "8%", right: right ? "7%" : "8%", top: right ? "18%" : "12%", bottom: right ? "10%" : "12%", background: "white", borderRadius: 19, overflow: "hidden", boxShadow: "0 31px 65px -27px #0006", fontSize: 23 }}>
      <div style={{ height: 40, display: "flex", alignItems: "center", gap: 9, padding: "0 17px", borderBottom: "1px solid #0001", background: "#faf9f6" }}>{[0, 1, 2].map(i => <span key={i} style={{ width: 12.5, height: 12.5, borderRadius: "50%", background: "#0002" }} />)}<span style={{ marginLeft: 15, fontFamily: "monospace", fontSize: 18, opacity: .55 }}>{title}</span></div>
      <div style={{ padding: "19px 25px" }}>{children}</div>
    </div>
  </div>;
}

export function Bubble({ t, at, x, y, children }: { t: number; at: number; x: number; y: number; children: ReactNode }) {
  return <div style={{ position: "absolute", left: x, top: y, transform: `translateX(-50%) scale(${popIn(t, at)})`, opacity: clamp(t, at, at + .15), whiteSpace: "nowrap", background: "white", border: "1.5px solid #1d1c1a", borderRadius: 19, padding: "5px 15px", fontSize: 22, zIndex: 3 }}>{children}</div>;
}

export function Coin({ t, at, from, to }: { t: number; at: number; from: [number, number]; to: [number, number] }) {
  const p = clamp(t, at, at + .8);
  return <div style={{ position: "absolute", left: from[0] + (to[0] - from[0]) * p, top: from[1] + (to[1] - from[1]) * p - 173 * 4 * p * (1 - p), width: 35, height: 35, borderRadius: "50%", background: "#e3a62a", border: "5px solid white", boxShadow: "0 6px 12px #0003", opacity: t >= at && t < at + .9 ? Math.min(1, p * 8) : 0, transform: `scale(${.4 + .6 * Math.min(1, p * 7)})`, zIndex: 4 }} />;
}
