import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUES } from '../src/sound.ts';

const rate = 44100;
type Tone = { f?: number; f2?: number; type?: 'sine' | 'triangle' | 'square'; a?: number; d?: number; v?: number };
type Noise = { d?: number; v?: number; type?: 'bandpass' | 'highpass' | 'lowpass'; f?: number; f2?: number; q?: number };
export function synth(id: string): Float32Array {
  const parts: { at: number; samples: Float32Array }[] = [];
  let seed = 1;
  const random = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const envelope = (t: number, a: number, d: number, v: number) => t < a ? .0001 * (v / .0001) ** (t / a) : t < a + d ? v * (.0001 / v) ** ((t - a) / d) : .0001;
  const tone = (at: number, { f = 440, f2 = 0, type = 'sine', a = .005, d = .15, v = .3 }: Tone = {}) => {
    const samples = new Float32Array(Math.ceil((a + d + .05) * rate)); let phase = 0;
    for (let i = 0; i < samples.length; i++) { const t = i / rate; const freq = f2 ? f * (f2 / f) ** Math.min(1, t / (a + d * .6)) : f; const p = phase % 1; const wave = type === 'sine' ? Math.sin(2 * Math.PI * p) : type === 'square' ? (p < .5 ? 1 : -1) : 1 - 4 * Math.abs(p - .25 - Math.floor(p + .25)); samples[i] = wave * envelope(t, a, d, v); phase += freq / rate; }
    parts.push({ at, samples });
  };
  const noise = (at: number, { d = .1, v = .2, type = 'bandpass', f = 2000, f2 = 0, q = 1 }: Noise = {}) => {
    const samples = new Float32Array(Math.ceil((d + .05) * rate)); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const t = i / rate, freq = f2 ? f * (f2 / f) ** Math.min(1, t / d) : f, w = 2 * Math.PI * freq / rate, c = Math.cos(w), alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
      const b0 = type === 'bandpass' ? alpha : type === 'lowpass' ? (1 - c) / 2 : (1 + c) / 2;
      const b1 = type === 'bandpass' ? 0 : type === 'lowpass' ? 1 - c : -(1 + c);
      const b2 = type === 'bandpass' ? -alpha : b0;
      const x = random() * 2 - 1, y = (b0 * x + b1 * x1 + b2 * x2 + 2 * c * y1 - (1 - alpha) * y2) / a0;
      samples[i] = y * envelope(t, .005, d, v); x2 = x1; x1 = x; y2 = y1; y1 = y;
    }
    parts.push({ at, samples });
  };
  const [name, arg1, arg2] = id.split('-'); const p = Number(arg1), n = Number(arg2);
  switch (name) {
    case 'pop': tone(0, { f: p, f2: p * 1.9, d: .12, v: .35 }); break;
    case 'tick': tone(0, { f: 1800, type: 'triangle', d: .03, v: .1 }); break;
    case 'whoosh': noise(0, { d: .32, v: .25, f: 400, f2: 3500, q: .8 }); break;
    case 'coinUp': case 'coinDown': tone(0, { f: name === 'coinUp' ? 988 : 1319, type: 'square', d: .06, v: .07 }); tone(.06, { f: name === 'coinUp' ? 1319 : 988, type: 'square', d: .18, v: .07 }); break;
    case 'stamp': tone(0, { f: 140, f2: 55, d: .18, v: .5 }); noise(0, { d: .05, v: .25, type: 'highpass', f: 1500 }); break;
    case 'ding': { const f = p || 1568; tone(0, { f, d: .9, v: .18 }); tone(0, { f: f * 2, d: .5, v: .05 }); break; }
    case 'scribble': for (let i = 0; i < 6; i++) noise(i * p / 6, { d: p / 7, v: .08, f: 3000 + (i * 977) % 2000, q: 4 }); break;
    case 'chord': [523, 659, 784].forEach(f => tone(0, { f, a: .04, d: .7, v: .07 })); break;
    case 'flag': noise(0, { d: .2, v: .18, f: 800, f2: 2500 }); tone(.18, { f: 200, f2: 90, d: .12, v: .35 }); break;
    case 'buzz': tone(0, { f: 220, type: 'square', d: .09, v: .1 }); tone(.14, { f: 220, type: 'square', d: .12, v: .1 }); break;
    case 'seal': noise(0, { d: .12, v: .15, type: 'lowpass', f: 1200 }); break;
    case 'flip': noise(0, { d: .04, v: .2, type: 'highpass', f: 2500 }); tone(0, { f: 1200, type: 'triangle', d: .04, v: .08 }); break;
    case 'gavel': tone(0, { f: 190, f2: 120, type: 'triangle', d: .22, v: .5 }); noise(0, { d: .03, v: .3, type: 'highpass', f: 2000 }); break;
    case 'clock': tone(0, { f: 1250, d: .03, v: .2 }); break;
    case 'button': tone(0, { f: 900, type: 'square', d: .02, v: .07 }); tone(.02, { f: 300, f2: 180, d: .08, v: .25 }); break;
    case 'blips': for (let i = 0; i < p; i++) tone(i * n / p, { f: 700 + i * 60, type: 'triangle', d: .04, v: .07 }); break;
    case 'sweep': tone(0, { f: 300, f2: 1100, a: .05, d: p, v: .05 }); break;
    case 'success': [523, 659, 784, 1047].forEach((f, i) => tone(i * .07, { f, type: 'triangle', d: .25, v: .12 })); break;
    case 'cascade': for (let i = 0; i < 7; i++) tone(i * .09, { f: 1200 + (i * 373) % 600, type: 'square', d: .08, v: .045 }); break;
    case 'wah': tone(0, { f: 440, f2: 180, type: 'triangle', d: .45, v: .15 }); break;
    case 'scroll': for (let x = 0; x < p; x += .11) tone(x, { f: 2400, type: 'triangle', d: .012, v: .04 }); break;
    case 'click': noise(0, { d: .02, v: .25, type: 'highpass', f: 3000 }); tone(0, { f: 1500, d: .02, v: .06 }); break;
    case 'note': tone(0, { f: p, type: 'triangle', d: .3, v: .1 }); break;
    case 'shimmer': [1047, 1319, 1568, 2093].forEach((f, i) => tone(i * .05, { f, d: .8, v: .05 })); break;
    case 'logo': tone(0, { f: 784, type: 'triangle', d: .14, v: .22 }); tone(1 / 3, { f: 1175, type: 'triangle', d: .6, v: .22 }); break;
    default: throw new Error(`Unknown sound: ${id}`);
  }
  const result = new Float32Array(Math.max(...parts.map(part => Math.round(part.at * rate) + part.samples.length)));
  for (const part of parts) { const start = Math.round(part.at * rate); for (let i = 0; i < part.samples.length; i++) result[start + i] = result[start + i]! + part.samples[i]!; }
  return result;
}
export function wav(samples: Float32Array): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2); b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i]!)); b.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), 44 + i * 2); } return b;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = 'video/public/sfx'; mkdirSync(dir, { recursive: true }); const ids = [...new Set(CUES.map(c => c.sound))];
  for (const file of readdirSync(dir)) if (!ids.some(id => file === `${id}.wav`)) unlinkSync(`${dir}/${file}`);
  for (const id of ids) writeFileSync(`${dir}/${id}.wav`, wav(synth(id)));
}
