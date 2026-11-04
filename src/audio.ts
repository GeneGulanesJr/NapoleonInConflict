// Procedural WebAudio: no asset files. SFX fall off with distance from the camera and share a small reverb;
// a drum-and-fife march (each nation its own tune) plays during battles and the drums swell with the amount of shooting.
import { pref, setPref, prefNum, setPrefNum } from './campaign.ts';
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let sfx: GainNode | null = null;
let mus: GainNode | null = null;
let noise: AudioBuffer | null = null;
export let muted = pref('nic-mute', false);
/** music and effects volume, 0..1 (settings) */
export const vol = { mus: prefNum('nic-vol-mus', 1), sfx: prefNum('nic-vol-sfx', 1) };
export function setVolume(k: 'mus' | 'sfx', v: number) {
  vol[k] = v; setPrefNum(`nic-vol-${k}`, v);
  if (k === 'mus' && mus) mus.gain.value = 0.6 * v;
  if (k === 'sfx' && sfx) sfx.gain.value = v;
}

function init() {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
    master = ctx.createGain(); master.gain.value = muted ? 0 : 0.5; master.connect(ctx.destination);
    sfx = ctx.createGain(); sfx.gain.value = vol.sfx; sfx.connect(master);
    mus = ctx.createGain(); mus.gain.value = 0.6 * vol.mus; mus.connect(master);
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    // cheap reverb: decaying noise impulse, mixed in low so shots sound like they are across open fields
    const len = Math.floor(ctx.sampleRate * 1.6), imp = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const ch = imp.getChannelData(c); for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3; }
    const verb = ctx.createConvolver(), wet = ctx.createGain();
    verb.buffer = imp; wet.gain.value = 0.22; sfx.connect(verb); verb.connect(wet); wet.connect(master);
  } catch { ctx = null; }
  return ctx;
}
/** Call from a user gesture so the browser allows audio. */
export function unlock() { init()?.resume(); }
export function toggleMute() { muted = !muted; setPref('nic-mute', muted); if (master) master.gain.value = muted ? 0 : 0.5; return muted; }

function burst(vol: number, dur: number, freq: number, q = 0.7, type: BiquadFilterType = 'lowpass', thump = 0, delay = 0) {
  if (!ctx || !sfx || !noise || muted || vol < 0.01) return;
  const t = ctx.currentTime + delay, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = noise; src.playbackRate.value = 0.8 + Math.random() * 0.4;
  f.type = type; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f); f.connect(g); g.connect(sfx);
  src.start(t, Math.random()); src.stop(t + dur);
  if (thump) {
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.frequency.setValueAtTime(thump, t); o.frequency.exponentialRampToValueAtTime(30, t + dur);
    og.gain.setValueAtTime(vol * 0.9, t); og.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(og); og.connect(sfx); o.start(t); o.stop(t + dur);
  }
}

const att = (d: number) => 1 / (1 + (d / 70) ** 2);
let intensity = 0; // 0..1, rises with gunfire, decays on its own

export function playEvents(events: any[], camX: number, camZ: number) {
  if (!ctx || muted) return;
  let shots = 0;
  for (const e of events) {
    const a = att(Math.hypot((e.x ?? camX) - camX, (e.z ?? camZ) - camZ));
    if (e.k === 'shot') {
      intensity = Math.min(1, intensity + 0.004);
      if (e.a) { burst(0.75 * a, 1.1, 380, 0.7, 'lowpass', 90); burst(0.3 * a, 0.25, 3000, 0.6, 'bandpass', 0, 0.01); }
      else if (shots++ < 6) { burst(0.22 * a, 0.3, 2600, 0.5, 'bandpass'); burst(0.12 * a, 0.5, 500, 0.6, 'lowpass', 0, 0.05); }
    } else if (e.k === 'boom') { intensity = Math.min(1, intensity + 0.02); burst(0.9 * a, 1.3, 280, 0.7, 'lowpass', 70); burst(0.4 * a, 0.4, 1200, 0.6, 'bandpass', 0, 0.03); }
    else if (e.k === 'charge') { burst(0.35 * a, 0.7, 160, 0.6, 'lowpass', 0); burst(0.2 * a, 0.5, 900, 0.5, 'bandpass', 0, 0.08); } // hoof thunder
    else if (e.k === 'rout') burst(0.3 * a, 0.7, 500, 0.5, 'bandpass');
  }
}

/** Short UI cues: kind = 'capture' | 'arrive' | 'alert' */
export function cue(kind: string) {
  if (!init() || !ctx || !sfx || muted) return;
  const t = ctx.currentTime;
  const notes = kind === 'capture' ? [392, 523, 659] : kind === 'arrive' ? [330, 392] : [220, 196];
  notes.forEach((f, i) => {
    const o = ctx!.createOscillator(), g = ctx!.createGain();
    o.type = 'triangle'; o.frequency.value = f;
    g.gain.setValueAtTime(0, t + i * 0.12); g.gain.linearRampToValueAtTime(0.18, t + i * 0.12 + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.5);
    o.connect(g); g.connect(sfx!); o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.55);
  });
}

// ---------------------------------------------------------------- music: drum and fife march
const BPM = 104, S = 60 / BPM / 4;
const SNARE = [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1];
const KICK = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
const SEMI: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
/** A tune as text: a note letter C-B (lower case an octave up), then its length in 16ths (none: a quarter); z rests. Laid out per 16th: [semitones, length] where a note starts. */
const score = (notes: string) => [...notes.matchAll(/([A-Ga-gz])(\d*)/g)].flatMap(([, n, d]) => [n === 'z' ? null : [SEMI[n.toLowerCase()] + (n >= 'a' ? 12 : 0), +d || 4], ...Array((+d || 4) - 1).fill(null)]);
/** Each army marches to its own public-domain tune (bar: 16ths per bar, for the drums). Written in C, the fife plays it a tone higher, in D. */
const MARCH: Record<string, { bar: number; seq: any[] }> = {
  // La Marseillaise (Rouget de Lisle, 1792), sung again in the Hundred Days: "Allons enfants de la Patrie, le jour de gloire est arrivé!"
  fr: { bar: 16, seq: score('z12 G3G1 | G c c d | d g6 e2 c3c1 | e3c1 A f d3B1 | c8 z8') },
  // God Save the King (first printed 1744). Anyone else marches to it too: Prussia's anthem since 1795, Heil dir im Siegerkranz, is the same tune.
  gb: { bar: 12, seq: score('c c d | B6c2 d | e e f | e6d2 c | d c B | c12 | g g g | g6f2 e | f f f | f6e2 d | e f2e2d2c2 | e6f2 g | a2f2 e d | c12') },
};
let timer = 0, nextT = 0, step = 0, march = MARCH.fr;

function drum(t: number, kind: 'snare' | 'kick', v: number) {
  if (!ctx || !mus || !noise) return;
  if (kind === 'snare') {
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noise; f.type = 'highpass'; f.frequency.value = 1800;
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    src.connect(f); f.connect(g); g.connect(mus); src.start(t, Math.random()); src.stop(t + 0.1);
  } else {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.18);
    g.gain.setValueAtTime(v * 1.6, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g); g.connect(mus); o.start(t); o.stop(t + 0.25);
  }
}
function fife(t: number, semis: number, len: number, v: number) {
  if (!ctx || !mus) return;
  const f = 293.66 * 2 ** (semis / 12), d = S * len, o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(), lfo = ctx.createOscillator(), lg = ctx.createGain();
  o.type = 'sine'; o2.type = 'sine'; o.frequency.value = f; o2.frequency.value = f * 2;
  lfo.frequency.value = 5.5; lg.gain.value = f * 0.006; lfo.connect(lg); lg.connect(o.frequency);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.03); g.gain.setValueAtTime(v, t + d * 0.6); g.gain.exponentialRampToValueAtTime(0.001, t + d * 0.95);
  const g2 = ctx.createGain(); g2.gain.value = 0.25; o2.connect(g2); g2.connect(g);
  o.connect(g); g.connect(mus); [o, o2, lfo].forEach((n) => { n.start(t); n.stop(t + d); });
}
function tick() {
  if (!ctx || !mus) return;
  intensity *= 0.992;
  while (nextT < ctx.currentTime + 0.25) {
    const i = step % march.bar, n = march.seq[step % march.seq.length];
    const dv = 0.05 + 0.1 * intensity;
    if (SNARE[i]) { if (i % 4 === 0) drum(nextT - 0.025, 'snare', dv * 0.5); drum(nextT, 'snare', dv * (i % 4 === 0 ? 1 : 0.7)); }
    if (KICK[i]) drum(nextT, 'kick', dv * 0.9);
    if (n && Math.floor(step / march.seq.length) % 2 === 0) fife(nextT, n[0], n[1], 0.07 * (1 - 0.5 * intensity)); // the tune, then a turn of drums alone
    nextT += S; step++;
  }
}
/** Start or stop the march of nation `nat` (scenario nat code). Safe to call before the user has interacted (it simply stays silent until unlock). */
export function music(on: boolean, nat = 'fr') {
  if (!on) { clearInterval(timer); timer = 0; try { speechSynthesis.cancel(); } catch { /* no speech */ } return; }
  if (!init() || !ctx || timer) return;
  march = MARCH[nat] ?? MARCH.gb;
  ctx.resume(); nextT = ctx.currentTime + 0.1; step = 0; intensity = 0;
  timer = window.setInterval(tick, 50);
}

// ---------------------------------------------------------------- officer radio (browser voice; swap for recorded clips later)
export let radioOn = pref('nic-radio', true);
export const toggleRadio = () => { radioOn = !radioOn; setPref('nic-radio', radioOn); return radioOn; };
let lastSay = 0;
/** prio 2 interrupts whatever is being said; otherwise lines are dropped if the radio is busy. */
export function say(text: string, prio = 0) {
  if (!radioOn || muted || typeof speechSynthesis === 'undefined') return;
  const now = performance.now();
  if ((speechSynthesis.speaking || now - lastSay < 2500) && prio < 2) return;
  if (prio >= 2) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text), vs = speechSynthesis.getVoices();
  u.rate = 1.08; u.pitch = 0.8; u.volume = 0.9;
  const v = vs.find((q) => /en-GB/i.test(q.lang)) ?? vs.find((q) => /^en/i.test(q.lang));
  if (v) u.voice = v;
  speechSynthesis.speak(u); lastSay = now;
}
