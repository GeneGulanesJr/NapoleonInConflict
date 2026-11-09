// Offline capture for Shorts. scripts/capture.ts opens capture.html, calls __cine.init(...) once, then __cine.frame() + a screenshot per video frame.
// The battle is a recipe (scenario + seed, bot vs bot), so every frame is deterministic and slow-mo costs nothing: time only moves when we say so.
import { createView } from './render.ts';
import { SCENARIOS, TUNING } from './campaign.ts';
import { createSim, step } from './sim/sim.ts';
import { makeBot } from './sim/bot.ts';
import { DT } from './sim/replay.ts';
import { offline, at, playEvents, musicTick, renderOffline } from './audio.ts';

type Opts = { scn: string; seed: number; from: number; to: number; fps: number; speed: number; x: number; z: number; dist: number; title?: string; sub?: string; music?: string };

const view = createView(document.getElementById('view')!);
let g: ReturnType<typeof createSim>, bots: ((dt: number) => void)[], acc = 0, fi = 0, o: Opts;

(window as any).__cine = {
  init(opts: Opts) {
    o = opts;
    const scn = SCENARIOS[o.scn];
    g = createSim(scn, TUNING, { seed: o.seed }); bots = [makeBot(g, 0), makeBot(g, 1)];
    while (g.s.t < o.from && !g.s.over) { step(g, DT); bots[0](DT); bots[1](DT); } // the part before the clip: sim only, no drawing
    g.s.events.length = 0;
    if (o.music !== 'off') offline(Math.ceil((o.to - o.from) / o.speed) + 2, o.music);
    view.setScenario(scn, TUNING);
    Object.assign(view.cam, { x: o.x, z: o.z, dist: o.dist, yaw: 0.5 });
    document.getElementById('t')!.textContent = o.title ?? ''; document.getElementById('s')!.textContent = o.sub ?? '';
    view.sync(g.s, 0, 0, []); view.render();
  },
  /** one video frame; false once the clip has run out */
  frame(): boolean {
    const dt = 1 / o.fps;
    acc += dt * o.speed;
    while (acc >= DT && !g.s.over) { step(g, DT); bots[0](DT); bots[1](DT); acc -= DT; }
    // follow the fighting near the camera (units engaged or just fired); far-off skirmishes don't drag the shot away
    const us: any[] = g.s.units, hot = us.filter((u) => !u.dead && (u.eng != null || u.fired < 4) && Math.hypot(u.x - view.cam.x, u.z - view.cam.z) < 70), k = Math.min(1, dt * 1.2);
    if (hot.length) { view.cam.x += (hot.reduce((s, u) => s + u.x, 0) / hot.length - view.cam.x) * k; view.cam.z += (hot.reduce((s, u) => s + u.z, 0) / hot.length - view.cam.z) * k; }
    view.cam.yaw += dt * 0.05;
    const evs = g.s.events.splice(0);
    if (o.music !== 'off') { at(fi++ * dt); playEvents(evs, view.cam.x, view.cam.z); musicTick(); } // sound is scheduled on the video clock
    view.sync(g.s, dt, 0, evs);
    view.render();
    return g.s.t < o.to && !g.s.over;
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
