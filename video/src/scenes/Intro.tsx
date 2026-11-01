import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { FONT_FAMILY } from "../fonts.ts";
import { BASE_BPM, music, shots } from "../script.ts";
import { Hook } from "./Hook.tsx";
import { Montage } from "./Montage.tsx";
import { ShotTransition } from "../ui/Transition.tsx";
import { shotFrames } from "../time.ts";

// Placeholder: the shot's last line, centred. Tasks 4-6 replace each with the real shot.
function Placeholder({ index }: { index: number }) {
  const line = shots[index]!.lines.at(-1);
  return (
    <AbsoluteFill style={{ background: "#f4f1ea", color: "#1d1c1a", fontFamily: FONT_FAMILY, fontWeight: 600, fontSize: 96, letterSpacing: "-0.02em", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 120 }}>
      {line?.text}
    </AbsoluteFill>
  );
}

export function Intro() {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill style={{ fontFamily: FONT_FAMILY, color: "#1d1c1a", fontWeight: 600 }}>
      {shotFrames(fps, music?.bpm ?? BASE_BPM).map((f, i) => (
        <Sequence key={f.id} from={f.from} durationInFrames={f.durationInFrames}>
          {i < 2 ? <ShotTransition in={shots[i]!.in} out={shots[i]!.out} duration={shots[i]!.beats / 2}>{i === 0 ? <Hook /> : <Montage />}</ShotTransition> : <Placeholder index={i} />}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
