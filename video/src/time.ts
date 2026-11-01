import { useCurrentFrame, useVideoConfig } from "remotion";
import { BASE_BPM, music, shots, type ShotId } from "./script.ts";

const BASE_SECONDS_PER_BEAT = 60 / BASE_BPM;
export const BASE_SECONDS = shots.reduce((sum, s) => sum + s.beats, 0) * BASE_SECONDS_PER_BEAT;

/** The tempo the cut plays at: the track's own BPM times its playback speed (132 for 120 BPM at 1.1x). */
export const CUT_BPM = (music?.bpm ?? BASE_BPM) * (music?.speed ?? 1);

export function timeScale(bpm: number): number {
  return BASE_BPM / bpm;
}

/** Each shot's start in base seconds (one beat is 0.5 s). */
export function shotStarts(): readonly number[] {
  let beat = 0;
  return shots.map((s) => {
    const start = beat * BASE_SECONDS_PER_BEAT;
    beat += s.beats;
    return start;
  });
}

export function shotFrames(fps: number, bpm: number): readonly { id: ShotId; from: number; durationInFrames: number }[] {
  const scale = timeScale(bpm);
  const froms = [...shotStarts().map((start) => Math.round(start * scale * fps)), Math.round(BASE_SECONDS * scale * fps)];
  return shots.map((s, i) => ({ id: s.id, from: froms[i]!, durationInFrames: froms[i + 1]! - froms[i]! }));
}

export function totalFrames(fps: number, bpm: number): number {
  return Math.round(BASE_SECONDS * timeScale(bpm) * fps);
}

/** Base seconds since the current <Sequence> started, so scenes animate on the animatic's timings. */
export function useShotTime(): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return frame / fps / timeScale(CUT_BPM);
}
