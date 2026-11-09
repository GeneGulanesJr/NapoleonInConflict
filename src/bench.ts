// Render benchmark: mid-battle Hougoumont, fixed camera, 2 sim ticks per frame; times sync + render + a GPU finish. Kept free of newer view options so it runs on older commits too.
import { createView } from './render.ts';
import { SCENARIOS, TUNING } from './campaign.ts';
import { createSim, step } from './sim/sim.ts';
import { makeBot } from './sim/bot.ts';
import { DT } from './sim/replay.ts';

const view = createView(document.getElementById('view')!, { crowd: Number(new URLSearchParams(location.search).get('crowd') ?? 1.4) } as any);
(window as any).__bench = {
  run(frames: number, dist: number) {
    const scn = SCENARIOS.hougoumont, g = createSim(scn, TUNING, { seed: 1 }), bots = [makeBot(g, 0), makeBot(g, 1)];
    while (g.s.t < 100 && !g.s.over) { step(g, DT); bots[0](DT); bots[1](DT); }
    g.s.events.length = 0; view.setScenario(scn, TUNING);
    Object.assign(view.cam, { x: 7, z: -13, dist, yaw: 0.5 });
    const gl = view.dom.getContext('webgl2') as WebGL2RenderingContext, px = new Uint8Array(4), ms: number[] = [];
    for (let f = 0; f < frames + 30; f++) {
      for (let k = 0; k < 2; k++) { step(g, DT); bots[0](DT); bots[1](DT); }
      const t0 = performance.now();
      view.sync(g.s, 1 / 30, 0, g.s.events.splice(0)); view.render();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // forces the GPU to finish
      if (f >= 30) ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { mean: ms.reduce((s, v) => s + v, 0) / ms.length, p95: ms[Math.floor(ms.length * 0.95)], max: ms[ms.length - 1], units: g.s.units.length, gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '?' };
  },
};
(window as any).__benchReady = true;
