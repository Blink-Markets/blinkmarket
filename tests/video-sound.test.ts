import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { CUES, musicVolume } from '../video/src/sound.ts';
import { synth, wav } from '../video/scripts/sfx.ts';
import { shots } from '../video/src/script.ts';
import { CUT_BPM, shotFrames, shotStarts, timeScale } from '../video/src/time.ts';

test('every cue sits inside its shot at each tempo', () => {
  const len = Object.fromEntries(shots.map((s) => [s.id, s.beats * .5]));
  for (const c of CUES) assert.ok(c.at >= 0 && c.at < len[c.shot]!, `${c.shot} ${c.at} ${c.sound}`);
  assert.ok(CUES.some((c) => c.shot === 'ending' && c.sound === 'logo'));
  for (const bpm of [115, 125, 132]) for (const c of CUES) {
    const i = shots.findIndex((s) => s.id === c.shot);
    const shot = shotFrames(30, bpm)[i]!;
    const frame = Math.round((shotStarts()[i]! + c.at) * timeScale(bpm) * 30);
    assert.ok(frame >= shot.from && frame < shot.from + shot.durationInFrames, `${bpm} ${c.shot} ${c.at}`);
  }
});
test('the committed sound files are exactly what the recipes make', () => {
  const ids = [...new Set(CUES.map((c) => c.sound))].sort();
  assert.deepEqual(readdirSync('video/public/sfx').sort(), ids.map((id) => `${id}.wav`).sort());
  for (const id of ids) assert.ok(wav(synth(id)).equals(readFileSync(`video/public/sfx/${id}.wav`)), id);
  assert.ok(wav(synth('pop-523')).equals(wav(synth('pop-523'))));
});
test('the music envelope follows the design shape', () => {
  assert.equal(musicVolume(1), .5); assert.equal(musicVolume(20), 1); assert.equal(musicVolume(34.9), 1);
  assert.equal(musicVolume(36), 0); assert.equal(musicVolume(45), .6); assert.equal(musicVolume(55), 0);
  const near = (t: number, v: number) => assert.ok(Math.abs(musicVolume(t) - v) < 1e-9, `${t}: ${musicVolume(t)}`);
  near(35, 1); near(35.06, .5); near(35.12, 0); near(38, .6); near(53, .6); near(53.25, .3); near(53.5, 0);
});
