// Offline capture for Shorts. scripts/capture.ts opens capture.html, calls __cine.init(...) once, then __cine.frame() + a screenshot per video frame.
// The battle is a recipe (scenario + seed, bot vs bot), so every frame is deterministic and slow-mo costs nothing: time only moves when we say so.
// A small director reads the battle's own events and cuts the story: wide establishing orbit -> charges followed from behind, volleys pushed in on,
// routs and kills pulled back to in slow motion, flank attacks whipped to -> wide pull-out at the end.
import { createView } from './render.ts';
import { SCENARIOS, TUNING } from './campaign.ts';
import { createSim, step } from './sim/sim.ts';
import { makeBot } from './sim/bot.ts';
import { DT } from './sim/replay.ts';
import { offline, at, playEvents, musicTick, renderOffline } from './audio.ts';

type Opts = { scn: string; seed: number; from: number; to: number; fps: number; speed: number; x: number; z: number; dist: number; title?: string; sub?: string; music?: string; maxSec: number };

const q = new URLSearchParams(location.search);
const view = createView(document.getElementById('view')!, { crowd: Number(q.get('crowd') ?? 2.2), smoke: Number(q.get('smoke') ?? 0.6) });
let g: ReturnType<typeof createSim>, bots: ((dt: number) => void)[], acc = 0, fi = 0, o: Opts;

// ---------------------------------------------------------------- director
const TILT = (35 * Math.PI) / 180, ISO = Math.PI / 4, PI2 = Math.PI * 2;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** a shot: what it frames and how it moves. follow = a unit id the camera tracks; dist/tilt/yaw are targets that eased toward; slow = sim speed factor (1 = normal); prio = what may cut it short */
type Shot = { kind: string; x: number; z: number; follow: number | null; dist: number; tilt: number; yaw: number; rate: number; slow: number; hold: number; prio: number; t: number; drift: number };
let shot: Shot, slowNow = 1, yawBase = 0;
const PRIO: Record<string, number> = { rout: 5, dead: 5, charge: 4, flank: 3, boom: 2, special: 2, shot: 1 };

const unitAt = (x: number, z: number, side?: number) => {
  let best: any = null, bd = 1e9;
  for (const u of g.s.units as any[]) { if (u.dead || (side != null && u.side !== side)) continue; const d = Math.hypot(u.x - x, u.z - z); if (d < bd) { bd = d; best = u; } }
  return best;
};
/** centre of everything fighting: where the establishing shot looks */
const hotCentre = () => {
  const hot = (g.s.units as any[]).filter((u) => !u.dead && (u.eng != null || u.fired < 6));
  return hot.length ? { x: hot.reduce((s, u) => s + u.x, 0) / hot.length, z: hot.reduce((s, u) => s + u.z, 0) / hot.length } : { x: o.x, z: o.z };
};
const mk = (s: Partial<Shot> & { kind: string }): Shot => ({ x: view.cam.x, z: view.cam.z, follow: null, dist: o.dist, tilt: TILT, yaw: view.cam.yaw, rate: 3, slow: 1, hold: 3, prio: 0, t: 0, drift: 0.05, ...s });

/** the shot an event calls for */
function shotFor(e: any): Shot | null {
  const u = e.x != null ? unitAt(e.x, e.z, e.side) : null, fy = u ? u.facing : view.cam.yaw + ISO + Math.PI;
  const side = Math.random() < 0.5 ? 1 : -1; // which shoulder (the render itself is not part of the deterministic sim, so this is free)
  switch (e.k) {
    case 'charge': return u && mk({ kind: 'charge', follow: u.id, x: u.x, z: u.z, dist: o.dist * 0.4, tilt: TILT * 0.62, yaw: fy + Math.PI + side * 0.55 - ISO, rate: 5, slow: 0.7, hold: 3.6, prio: 4, drift: 0.04 });
    case 'rout': case 'dead': return mk({ kind: 'impact', x: e.x, z: e.z, dist: o.dist * 0.72, tilt: TILT * 0.8, yaw: view.cam.yaw + side * 0.35, rate: 2.2, slow: 0.3, hold: 2.6, prio: 5, drift: 0.08 });
    case 'flank': return mk({ kind: 'whip', x: e.x, z: e.z, dist: o.dist * 0.55, tilt: TILT * 0.75, yaw: view.cam.yaw + side * 1.1, rate: 7, slow: 0.8, hold: 2.4, prio: 3, drift: 0.1 });
    case 'boom': case 'special': return mk({ kind: 'blast', x: e.x, z: e.z, dist: o.dist * 0.6, tilt: TILT * 0.9, yaw: view.cam.yaw + side * 0.4, rate: 3, slow: 0.6, hold: 2.2, prio: 2, drift: 0.05 });
    case 'shot': return mk({ kind: 'volley', x: (e.x + (e.tx ?? e.x)) / 2, z: (e.z + (e.tz ?? e.z)) / 2, dist: o.dist * 0.62, tilt: TILT * 0.85, yaw: (u ? u.facing : view.cam.yaw + ISO) + Math.PI / 2 * side - ISO, rate: 1.6, slow: 1, hold: 3.2, prio: 1, drift: 0.03 });
  }
  return null;
}

function direct(evs: any[], dt: number, p: number) {
  shot.t += dt;
  const phase = p < 0.12 ? 'open' : p > 0.88 ? 'close' : 'mid';
  if (phase === 'open' && shot.kind !== 'establish') { const c = hotCentre(); shot = mk({ kind: 'establish', x: c.x, z: c.z, dist: o.dist * 1.9, tilt: TILT * 1.05, yaw: yawBase, rate: 1.4, hold: 99, prio: 9, drift: 0.14 }); }
  else if (phase === 'close' && shot.kind !== 'outro') { const c = hotCentre(); shot = mk({ kind: 'outro', x: c.x, z: c.z, dist: o.dist * 2.1, tilt: TILT * 1.2, yaw: view.cam.yaw + 0.5, rate: 0.9, slow: 1, hold: 99, prio: 9, drift: 0.1 }); }
  else if (phase === 'mid') {
    if (shot.kind === 'establish' || shot.kind === 'outro' || shot.t >= shot.hold + 4) shot.hold = 0; // leave the opening shot for the first action; any shot goes stale after a few seconds
    if (shot.t >= Math.min(shot.hold, 2) ) { // a shot runs 2 s at least, then the strongest beat that is at least as important cuts to its own
      let best: any = null;
      for (const e of evs) { const pr = PRIO[e.k] ?? 0; if (pr && (!best || pr > PRIO[best.k]) && (pr >= shot.prio || shot.t >= shot.hold)) best = e; }
      const s = best && shotFor(best);
      if (s) { const far = Math.hypot(s.x - view.cam.x, s.z - view.cam.z) > 70; shot = s; if (far) { view.cam.x = s.x; view.cam.z = s.z; view.cam.dist = s.dist * 1.15; } } // across the field: a hard cut, not a flight over the middle
    }
  }
  // move the camera toward the shot
  const k = 1 - Math.exp(-dt * shot.rate);
  const f = shot.follow != null ? (g.s.units as any[]).find((u) => u.id === shot.follow && !u.dead) : null;
  if (f) { shot.x = f.x; shot.z = f.z; } else shot.follow = null;
  const cam = view.cam;
  cam.x += (shot.x - cam.x) * k; cam.z += (shot.z - cam.z) * k; cam.dist += (shot.dist - cam.dist) * k;
  shot.yaw += shot.drift * dt; cam.yaw += wrap(shot.yaw - cam.yaw) * k; view.tilt.v += (shot.tilt - view.tilt.v) * k;
  // time: slow-mo eases in fast and back out slowly, so an impact lands and then the action returns
  const want = shot.t < Math.min(shot.hold, 1.6) ? shot.slow : 1;
  slowNow += (want - slowNow) * (1 - Math.exp(-dt * (want < slowNow ? 9 : 2.2)));
}

(window as any).__cine = {
  /** model lab: one regiment of each listed type ('line:fr', 'guard:fr', 'cuirassier:fr', ...) in a row on flat ground, for close-up stills (see scripts/lab.ts) */
  lab(kinds: string[]) {
    const scn = { ...SCENARIOS.quatrebras, map: { size: 400 }, clock: null };
    g = createSim(scn, TUNING, { seed: 1 }); view.setScenario(scn, TUNING);
    const pool = [...g.s.units] as any[], picked: any[] = [];
    kinds.forEach((k, i) => {
      const [type, nat] = k.split(':'), u = pool.find((q) => q.type === type && (!nat || q.nat === nat) && !picked.includes(q)) ?? pool.find((q) => q.type === type && !picked.includes(q)) ?? pool.find((q) => q.type === 'line' && !picked.includes(q)); // a nation or type the scenario lacks: take a unit and dress it as that
      if (u) { Object.assign(u, { type, nat: nat ?? u.nat, x: i * 80 - (kinds.length - 1) * 40, z: 0, facing: 0, form: 'line', tx: null, tz: null, men: u.maxMen, fired: 0.5 }); picked.push(u); }
    });
    g.s.units = picked; g.s.zones = []; g.s.smoke = []; g.s.fx = [];
    for (let i = 0; i < 16; i++) { view.sync(g.s, 0.1, 0, []); view.render(); } // men walk to their slots and settle into their pose
    return picked.map((u) => ({ id: u.id, x: u.x, z: u.z, type: u.type, nat: u.nat }));
  },
  /** one still: camera at (x, z), distance, yaw, tilt (radians) */
  snap(x: number, z: number, dist: number, yaw: number, tilt: number) {
    Object.assign(view.cam, { x, z, dist, yaw }); view.tilt.v = tilt;
    for (let i = 0; i < 3; i++) { view.sync(g.s, 0.05, 0, []); view.render(); }
  },
  init(opts: Opts) {
    o = opts;
    const scn = SCENARIOS[o.scn];
    g = createSim(scn, TUNING, { seed: o.seed }); bots = [makeBot(g, 0), makeBot(g, 1)];
    while (g.s.t < o.from && !g.s.over) { step(g, DT); bots[0](DT); bots[1](DT); } // the part before the clip: sim only, no drawing
    g.s.events.length = 0;
    if (o.music !== 'off') offline(o.maxSec + 2, o.music);
    view.setScenario(scn, TUNING);
    yawBase = 0.5; Object.assign(view.cam, { x: o.x, z: o.z, dist: o.dist * 1.9, yaw: yawBase });
    shot = mk({ kind: 'start', hold: 0 }); slowNow = 1;
    document.getElementById('t')!.textContent = o.title ?? ''; document.getElementById('s')!.textContent = o.sub ?? '';
    view.sync(g.s, 0, 0, []); view.render();
  },
  /** one video frame; false once the clip has run out */
  frame(): boolean {
    const dt = 1 / o.fps, p = Math.max(0, Math.min(1, (g.s.t - o.from) / (o.to - o.from)));
    acc += dt * o.speed * slowNow;
    const evs: any[] = [];
    while (acc >= DT && !g.s.over) { step(g, DT); bots[0](DT); bots[1](DT); acc -= DT; evs.push(...g.s.events.splice(0)); }
    direct(evs, dt, p);
    if (o.music !== 'off') { at(fi * dt); playEvents(evs, view.cam.x, view.cam.z); musicTick(); } // sound is scheduled on the video clock
    fi++;
    view.sync(g.s, dt, 0, evs);
    view.render();
    return g.s.t < o.to && !g.s.over && fi < o.maxSec * o.fps;
  },
  /** the whole soundtrack as a 16-bit stereo WAV, base64 */
  async audio(): Promise<string> {
    const b = await renderOffline(), n = Math.min(b.length, Math.ceil(fi / o.fps * b.sampleRate)), L = b.getChannelData(0), R = b.getChannelData(1);
    const w = new DataView(new ArrayBuffer(44 + n * 4)), s = (p: number, t: string) => [...t].forEach((c, i) => w.setUint8(p + i, c.charCodeAt(0)));
    s(0, 'RIFF'); w.setUint32(4, 36 + n * 4, true); s(8, 'WAVEfmt '); w.setUint32(16, 16, true); w.setUint16(20, 1, true); w.setUint16(22, 2, true);
    w.setUint32(24, b.sampleRate, true); w.setUint32(28, b.sampleRate * 4, true); w.setUint16(32, 4, true); w.setUint16(34, 16, true); s(36, 'data'); w.setUint32(40, n * 4, true);
    const c16 = (x: number) => Math.round(Math.max(-1, Math.min(1, x)) * 32767);
    for (let i = 0; i < n; i++) { w.setInt16(44 + i * 4, c16(L[i]), true); w.setInt16(46 + i * 4, c16(R[i]), true); }
    let bin = ''; const u = new Uint8Array(w.buffer); for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(bin);
  },
};
(window as any).__cineReady = true;
