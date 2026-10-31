import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { FONT_FAMILY } from "../fonts.ts";
import { BASE_BPM, music, shots } from "../script.ts";
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
    <AbsoluteFill>
      {shotFrames(fps, music?.bpm ?? BASE_BPM).map((f, i) => (
        <Sequence key={f.id} from={f.from} durationInFrames={f.durationInFrames}>
          <Placeholder index={i} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
