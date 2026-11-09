// Offline capture for Shorts. scripts/capture.ts opens capture.html, calls __cine.init(...) once, then __cine.frame() + a screenshot per video frame.
// The battle is a recipe (scenario + seed, bot vs bot), so every frame is deterministic and slow-mo costs nothing: time only moves when we say so.
import { createView } from './render.ts';
import { SCENARIOS, TUNING } from './campaign.ts';
import { createSim, step } from './sim/sim.ts';
import { makeBot } from './sim/bot.ts';
import { DT } from './sim/replay.ts';

type Opts = { scn: string; seed: number; from: number; to: number; fps: number; speed: number; x: number; z: number; dist: number; title?: string; sub?: string };

const view = createView(document.getElementById('view')!);
let g: ReturnType<typeof createSim>, bots: ((dt: number) => void)[], acc = 0, o: Opts;

(window as any).__cine = {
  init(opts: Opts) {
    o = opts;
    const scn = SCENARIOS[o.scn];
    g = createSim(scn, TUNING, { seed: o.seed }); bots = [makeBot(g, 0), makeBot(g, 1)];
    while (g.s.t < o.from && !g.s.over) { step(g, DT); bots[0](DT); bots[1](DT); } // the part before the clip: sim only, no drawing
    g.s.events.length = 0;
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
    view.sync(g.s, dt, 0, g.s.events.splice(0));
    view.render();
    return g.s.t < o.to && !g.s.over;
  },
};
(window as any).__cineReady = true;
