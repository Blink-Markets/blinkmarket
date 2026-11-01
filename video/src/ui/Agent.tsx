import type { CSSProperties } from "react";
import { screen } from "../script.ts";
import { ROLES, type RoleId } from "../roles.ts";
import { blink, hop, popIn, shake } from "./motion.ts";

export type Pose = { pop?: number; hop?: number; sway?: number; blinkAt?: readonly number[]; lookUp?: number; shake?: number; shakeDuration?: number; grey?: boolean; scale?: number };
export function Agent({ role, size, x, y, t, pose = {} }: { role: RoleId; size: number; x: number; y: number; t: number; pose?: Pose }) {
  const r = ROLES.find((item) => item.id === role)!;
  const bounce = pose.hop === undefined ? 0 : hop(t, pose.hop);
  const eye = Math.min(1, ...(pose.blinkAt ?? []).map((at) => blink(t, at)));
  const shape: CSSProperties = { position: "absolute", background: r.color };
  return <div style={{ position: "absolute", left: x, top: y, width: size, height: size / r.aspect, opacity: pose.pop !== undefined && t < pose.pop ? 0 : 1, transform: `scale(${(pose.pop === undefined ? 1 : popIn(t, pose.pop)) * (pose.scale ?? 1)})`, transformOrigin: "50% 100%", filter: pose.grey ? "grayscale(1)" : undefined }}>
    <div style={{ position: "absolute", inset: 0, borderRadius: role === "trader" ? "50%" : role === "maker" ? "24%" : "32%", background: r.color, transform: `translateY(${bounce * 100}%) rotate(${(pose.sway === undefined ? 0 : 4 * Math.sin((t - pose.sway) * Math.PI)) + (pose.shake === undefined ? 0 : shake(t, pose.shake, pose.shakeDuration))}deg) scale(${1.1 + bounce * .6}, ${.9 - bounce * .66})`, transformOrigin: "50% 100%" }}>
      {role === "creator" && <><i style={{ ...shape, left: "46%", top: "-30%", width: "8%", height: "32%", borderRadius: 9 }} /><i style={{ ...shape, left: "36%", top: "-50%", width: "28%", aspectRatio: "1", borderRadius: "50%", background: "#e3a62a" }} /></>}
      {role === "maker" && <><i style={{ ...shape, left: "18%", right: "18%", top: "-22%", height: "14%", borderRadius: 99, opacity: .55 }} /><i style={{ ...shape, left: "30%", right: "30%", top: "-42%", height: "14%", borderRadius: 99, opacity: .3 }} /></>}
      {role === "trader" && <i style={{ ...shape, right: "-16%", top: "-14%", width: "36%", aspectRatio: "1", borderRadius: "50%", background: "#e3a62a", border: `${size * .054}px solid #f4f1ea`, boxSizing: "border-box" }} />}
      {role === "forecaster" && <i style={{ position: "absolute", left: "13%", right: "13%", top: "28%", height: "44%", border: `${size * .07}px solid white`, boxSizing: "border-box", borderRadius: "40%" }} />}
      {role === "proposer" && <><i style={{ ...shape, right: "-12%", top: "-38%", width: "6%", height: "74%" }} /><i style={{ ...shape, right: "-46%", top: "-38%", width: "36%", height: "26%", background: "#d4562f", clipPath: "polygon(0 0,100% 50%,0 100%)" }} /></>}
      {role === "challenger" && <span style={{ position: "absolute", right: "-22%", top: "-52%", fontWeight: 700, fontSize: size * .52, color: "#d4562f" }}>{screen.montage.bang}</span>}
      {role === "juror" && <><i style={{ ...shape, left: "-8%", right: "-8%", top: "-8%", height: "16%", background: "#1d1c1a", borderRadius: 3 }} /><i style={{ ...shape, left: "30%", right: "30%", top: "-24%", height: "18%", background: "#1d1c1a", borderRadius: "4px 4px 0 0" }} /></>}
      {role === "keeper" && <><i style={{ ...shape, left: "33%", top: "-40%", width: "34%", aspectRatio: "1", border: `${size * .065}px solid ${r.color}`, boxSizing: "border-box", borderRadius: "50%", background: "#f4f1ea" }} /><i style={{ ...shape, left: "48%", top: "-31%", width: "4%", height: "13%", transformOrigin: "50% 100%", transform: `rotate(${Math.floor(t * 4) * 45}deg)` }} /></>}
      {[0, 1].map((i) => <b key={i} style={{ position: "absolute", left: `${28 + i * 28}%`, top: `${35 - 12 * (pose.lookUp ?? 0)}%`, width: "11%", height: "30%", borderRadius: 99, background: "white", transform: `scaleY(${eye}) rotate(${role === "challenger" ? (i ? -24 : 24) : 0}deg)` }} />)}
    </div>
  </div>;
}
