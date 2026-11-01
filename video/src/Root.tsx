import { Composition } from "remotion";
import { Intro } from "./scenes/Intro.tsx";
import { CUT_BPM, totalFrames } from "./time.ts";

const FPS = 30;

export function Root() {
  return <Composition id="BlinkIntro" component={Intro} width={1920} height={1080} fps={FPS} durationInFrames={totalFrames(FPS, CUT_BPM)} />;
}
