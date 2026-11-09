// Moment finder: runs bot vs bot for a scenario+seed (the recipe is the whole recording: the sim is deterministic) and ranks the most
// action-packed windows. Usage: node scripts/moments.ts [scenario|all] [seed] [windowSec=25] [top=3]
// Prints JSON: [{ scn, seed, from, to, score, x, z, tags }]  (from/to are sim seconds) -> feed one to scripts/capture.ts
import { readFileSync } from 'node:fs';
import { createSim, step } from '../src/sim/sim.ts';
import { makeBot } from '../src/sim/bot.ts';
import { resolve } from '../src/sim/extend.ts';

const raw = (f: string) => JSON.parse(readFileSync(new URL(`../src/data/${f}.json`, import.meta.url), 'utf8')), j = (f: string) => resolve(raw(f), raw);
const tu = j('tuning'), camp = j('campaign');
const [arg = 'all', seedArg = '1', winArg = '25', topArg = '3'] = process.argv.slice(2);
const seed = Number(seedArg), win = Number(winArg), top = Number(topArg);
const W: Record<string, number> = { charge: 4, flank: 3, rout: 6, dead: 8, falter: 2, special: 2, shot: 0.05 }; // what makes a good Short
const ids = arg === 'all' ? [...camp.battles, 'hougoumont', 'wavre', 'bridge', 'retreat', 'laststand'] : [arg];

const out: any[] = [];
for (const id of ids) {
  const scn = j(id), sim = createSim(scn, tu, { seed }), bots = [makeBot(sim, 0), makeBot(sim, 1)];
  const bins: { score: number; x: number; z: number; n: number; tags: Record<string, number> }[] = [];
  while (!sim.s.over && sim.s.t < scn.duration + 5) {
    step(sim, tu.tick ?? 0.05); bots[0](0.05); bots[1](0.05);
    const b = (bins[Math.floor(sim.s.t / 5)] ??= { score: 0, x: 0, z: 0, n: 0, tags: {} }); // 5 s bins, summed into windows below
    for (const e of sim.s.events) {
      const w = W[e.k]; if (!w) continue;
      b.score += w; b.tags[e.k] = (b.tags[e.k] ?? 0) + 1;
      if (e.k !== 'shot' && Number.isFinite(e.x)) { b.x += e.x; b.z += e.z; b.n++; }
    }
    sim.s.events.length = 0;
  }
  const k = Math.round(win / 5), cand: any[] = [];
  for (let i = 0; i + k <= bins.length; i++) {
    const w = bins.slice(i, i + k); let sc = 0, x = 0, z = 0, n = 0; const tags: Record<string, number> = {};
    for (const b of w) { if (!b) continue; sc += b.score; x += b.x; z += b.z; n += b.n; for (const t in b.tags) tags[t] = (tags[t] ?? 0) + b.tags[t]; }
    if (n) cand.push({ scn: id, seed, from: i * 5, to: (i + k) * 5, score: Math.round(sc), x: Math.round(x / n), z: Math.round(z / n), tags });
  }
  cand.sort((a, b) => b.score - a.score);
  for (const c of cand) if (out.filter((o) => o.scn === id).length < top && !out.some((o) => o.scn === id && c.from < o.to && c.to > o.from)) out.push(c); // best windows that don't overlap
}
out.sort((a, b) => b.score - a.score);
console.log(JSON.stringify(out, null, 1));
