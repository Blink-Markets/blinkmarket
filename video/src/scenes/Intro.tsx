import { AbsoluteFill, Html5Audio, Sequence, staticFile, useVideoConfig } from "remotion";
import { FONT_FAMILY } from "../fonts.ts";
import { BASE_BPM, music, shots } from "../script.ts";
import { Hook } from "./Hook.tsx";
import { GoesLive } from "./GoesLive.tsx";
import { Trading } from "./Trading.tsx";
import { Dispute } from "./Dispute.tsx";
import { Human } from "./Human.tsx";
import { Browse } from "./Browse.tsx";
import { Free } from "./Free.tsx";
import { Ending } from "./Ending.tsx";
import { Montage } from "./Montage.tsx";
import { ShotTransition } from "../ui/Transition.tsx";
import { shotFrames, shotStarts, timeScale } from "../time.ts";
import { CUES, musicVolume } from "../sound.ts";

export function Intro() {
  const { fps } = useVideoConfig();
  const bpm = music?.bpm ?? BASE_BPM;
  return (
    <AbsoluteFill style={{ fontFamily: FONT_FAMILY, color: "#1d1c1a", fontWeight: 600, background: "#f4f1ea" }}>
      {CUES.map((cue, i) => <Sequence key={i} from={Math.round((shotStarts()[shots.findIndex(s => s.id === cue.shot)]! + cue.at) * timeScale(bpm) * fps)}><Html5Audio src={staticFile(`sfx/${cue.sound}.wav`)} volume={1} /></Sequence>)}
      {music && <Html5Audio src={staticFile(music.file)} startFrom={Math.round(music.firstBeatSeconds * fps)} volume={f => musicVolume(f / fps / timeScale(music!.bpm)) * music!.gain} />}
      {shotFrames(fps, bpm).map((f, i) => (
        <Sequence key={f.id} from={f.from} durationInFrames={f.durationInFrames}>
          {<ShotTransition in={shots[i]!.in} out={shots[i]!.out} duration={shots[i]!.beats / 2}>{i === 0 ? <Hook /> : i === 1 ? <Montage /> : i === 2 ? <GoesLive /> : i === 3 ? <Trading /> : i === 4 ? <Dispute /> : i === 5 ? <Human /> : i === 6 ? <Browse /> : i === 7 ? <Free /> : <Ending />}</ShotTransition>}
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}
