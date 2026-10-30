import { Composition } from "remotion";
import { Intro } from "./scenes/Intro.tsx";
import { scenes } from "./script.ts";
export function Root() {
  return <Composition id="BlinkIntro" component={Intro} width={1920} height={1080} fps={30} durationInFrames={scenes.reduce((sum, scene) => sum + scene.seconds * 30, 0)} />;
}
