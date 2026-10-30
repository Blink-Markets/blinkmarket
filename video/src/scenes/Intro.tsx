import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import runData from "../../data/drill-run.json";
import type { RunRecord } from "../run-record.ts";
import { scenes } from "../script.ts";
import { scenarioCards, sceneFrames } from "../timeline.ts";

const run = runData as RunRecord;
const cards = scenarioCards(run);
const style = { background: "#101b1a", color: "#f2eee2", padding: "90px 120px", fontFamily: "Arial, sans-serif", justifyContent: "center" } as const;

function SceneContent({ index }: { index: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scene = scenes[index]!;
  const seconds = frame / fps;
  let content: React.ReactNode;
  if (index === 1) {
    const groups = [[0], [1, 2], [3, 4], [5, 6], [7, 8], [9], [10]];
    const group = groups[Math.min(Math.floor(seconds / (scene.seconds / groups.length)), groups.length - 1)]!;
    content = group.map((i) => <p key={i} style={{ fontSize: scene.lines[i]!.startsWith("Source:") ? 30 : 56, lineHeight: 1.22 }}>{scene.lines[i]}</p>);
  } else if (index === 2) {
    const events = run.events.filter((e) => e.event === "joined_role" || e.event === "juror_staked");
    content = seconds < 9 ? <><h1>{scene.lines[0]}</h1><p style={{ fontSize: 36, lineHeight: 1.5 }}>{scene.lines[1]}</p></> : <><h1>{scene.lines[2]}</h1><div style={{ fontSize: 35, columns: 2 }}>{events.map((e, i) => <p key={i}>{e.t}s · {e.agent} · {e.event}</p>)}</div></>;
  } else if (index === 3) {
    const cardIndex = Math.min(Math.floor(seconds / 7), cards.length - 1);
    const card = cards[cardIndex]!;
    const events = card.events;
    const page = Math.floor((seconds % 7) / 7 * Math.ceil(events.length / 12));
    content = <><h1>{card.name} — pass — {card.durationSeconds} s</h1><p style={{ fontSize: 34 }}>{scene.lines[cardIndex * 2 + 1]}</p><div style={{ fontSize: 30, lineHeight: 1.35 }}>{events.slice(page * 12, page * 12 + 12).map((e, i) => <div key={i}>{e}</div>)}</div></>;
  } else if (index === 6) {
    content = <>{scene.lines.slice(0, 2).map((line) => <p key={line} style={{ fontSize: 48 }}>{line}</p>)}<p style={{ fontSize: 35 }}>Data: a `{run.source}` run on {run.capturedOn}, commit {run.commit.slice(0, 7)}, local chain {run.chainId}. Not a public deployment.</p></>;
  } else {
    content = scene.lines.map((line, i) => <p key={i} style={{ fontSize: index === 0 && (i === 0 || i === 2) ? 34 : 53, lineHeight: 1.25 }}>{line}</p>);
  }
  return <AbsoluteFill style={style}>{scene.source === "illustration" && <div style={{ position: "absolute", top: 48, right: 80, fontSize: 26, color: "#a7c9ac" }}>Illustration</div>}{content}</AbsoluteFill>;
}
export function Intro() {
  return <AbsoluteFill>{sceneFrames(scenes, 30).map((f, i) => <Sequence key={f.id} from={f.from} durationInFrames={f.durationInFrames}><SceneContent index={i} /></Sequence>)}</AbsoluteFill>;
}
