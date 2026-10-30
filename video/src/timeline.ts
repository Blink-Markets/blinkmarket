import type { Scene } from "./script.ts";
import type { RunRecord } from "./run-record.ts";

export function sceneFrames(scenes: readonly Scene[], fps: number): readonly { id: string; from: number; durationInFrames: number }[] {
  let from = 0;
  return scenes.map((scene) => {
    const durationInFrames = scene.seconds * fps;
    const frame = { id: scene.id, from, durationInFrames };
    from += durationInFrames;
    return frame;
  });
}

export function scenarioCards(run: RunRecord): readonly { name: string; durationSeconds: number; events: readonly string[] }[] {
  const markets: Record<string, string> = { normal: "1", dispute: "2", creation: "4", timeout: "3", suggestion: "5" };
  return run.scenarios.map((scenario) => ({
    name: scenario.name,
    durationSeconds: scenario.durationSeconds,
    // Scenarios ran concurrently, so an event without a market ID cannot be placed on one card.
    events: run.events.filter((event) => event.market === markets[scenario.name]).map((event) => `${event.t}s · ${event.agent} · ${event.event}`),
  }));
}
