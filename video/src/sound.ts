import { ROLES } from './roles.ts';
import type { ShotId } from './script.ts';

export type Cue = { shot: ShotId; at: number; sound: string };
const words = (shot: ShotId, from: number, n: number): Cue[] => Array.from({ length: n }, (_, i) => ({ shot, at: from + i * .15, sound: 'tick' }));
const cues = (shot: ShotId, entries: readonly (readonly [number, string])[]): Cue[] => entries.map(([at, sound]) => ({ shot, at, sound }));
const jobs: readonly (readonly (readonly [number, string])[])[] = [
  [[.35, 'flip'], [.75, 'ding']], [[.2, 'pop-900'], [.55, 'stamp']], [[.95, 'coinUp']],
  [[.6, 'scribble-0.5'], [1, 'chord']], [[.3, 'flag']], [[.25, 'buzz']],
  [[.3, 'seal'], [.4, 'seal'], [.5, 'seal'], [.9, 'flip'], [1, 'flip'], [1.1, 'flip'], [1.25, 'gavel']],
  [[.35, 'clock'], [.6, 'clock'], [.85, 'clock'], [1, 'ding-2093'], [1.05, 'button']],
];
export const CUES: readonly Cue[] = [
  ...cues('hook', [[0, 'tick'], [1, 'tick'], [1.5, 'scribble-0.3'], [1.9, 'pop-523']]),
  ...ROLES.flatMap((role, i) => { const t = .5 + i * 1.5; return cues('montage', [[t, `pop-${role.pitch}`], ...jobs[i]!.map(([at, sound]) => [t + at, sound] as const), [t + 1.3, `pop-${role.pitch}`]]); }),
  ...words('montage', 12.5, 4), ...cues('montage', [[13.2, 'scribble-0.3']]),
  ...cues('goes-live', [[0, 'whoosh'], [.9, 'pop-523'], [1.5, 'pop-900'], [2.1, 'pop-700'], [2.3, 'ding']]), ...words('goes-live', .3, 3),
  ...cues('trading', [[0, 'whoosh'], [1.8, 'pop-784'], [2.9, 'pop-784'], [.7, 'blips-12-3.2'], [.7, 'sweep-3'], [2.3, 'coinUp'], [3.2, 'coinDown'], [3.3, 'tick']]),
  ...words('dispute', .2, 5), ...cues('dispute', [[.4, 'pop-587'], [.9, 'pop-800'], [1.2, 'pop-494'], [1.8, 'buzz'], [2, 'pop-392'], [2.3, 'pop-392'], [2.6, 'pop-392'], [3.5, 'gavel'], [3.6, 'wah'], [4, 'success'], [4.6, 'tick'], [4.6, 'cascade']]),
  ...cues('human', [[0, 'whoosh'], [.65, 'pop-880'], [2.3, 'pop-523'], [2.35, 'pop-659'], [2.4, 'pop-784']]), ...words('human', .2, 3),
  ...cues('browse', [[0, 'pop-600'], [.3, 'tick'], [.7, 'scroll-2.5'], [3.7, 'tick'], [3.9, 'click'], [4.25, 'pop-700'], [4.7, 'tick'], [4.7, 'sweep-1.6'], [6.6, 'tick'], [6.8, 'note-659'], [7.2, 'note-784'], [7.6, 'note-988'], [8.5, 'tick'], [8.7, 'flip'], [9, 'flip'], [9.8, 'whoosh']]),
  ...cues('free', [[.2, 'pop-523'], [.8, 'pop-659'], [1.4, 'pop-784'], [2, 'scribble-0.3']]),
  ...cues('ending', [...ROLES.map((role, i) => [i * .07, `pop-${role.pitch}`] as const), [2, 'tick'], [1.265, 'click'], [1.595, 'click'], [2.3, 'whoosh'], [2.75, 'shimmer'], ...[523, 587, 659, 784, 880].map((f, i) => [3.35 + i * .08, `note-${f}`] as const), [3.9, 'logo']]),
];
export function musicVolume(t: number): number {
  if (t < 4) return .5;
  if (t < 35) return 1;
  if (t < 35.12) return (35.12 - t) / .12;
  if (t < 38) return 0;
  if (t < 53) return .6;
  if (t < 53.5) return .6 * (53.5 - t) / .5;
  return 0;
}
