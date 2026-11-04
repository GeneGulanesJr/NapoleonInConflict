// Headless balance/regression run: bot vs bot for every scenario. Usage: node scripts/headless.ts [seed]
import { readFileSync } from 'node:fs';
import { createSim, step } from '../src/sim/sim.ts';
import { makeBot } from '../src/sim/bot.ts';
import { resolve } from '../src/sim/extend.ts';

const raw = (f: string) => JSON.parse(readFileSync(new URL(`../src/data/${f}.json`, import.meta.url), 'utf8')), j = (f: string) => resolve(raw(f), raw);
const tu = j('tuning'), camp = j('campaign');
const seed = Number(process.argv[2] ?? 1);

for (const id of [...camp.battles, 'hougoumont', 'wavre', 'bridge', 'retreat', 'laststand']) { // the stand-alone battles (EXTRA_BATTLES in src/campaign.ts) are not in the campaign list
  const scn = j(id);
  const sim = createSim(scn, tu, { seed });
  const bots = [makeBot(sim, 0), makeBot(sim, 1)];
  const t0 = Date.now();
  let peak = 0;
  while (!sim.s.over && sim.s.t < scn.duration + 5) {
    step(sim, tu.tick ?? 0.05);
    bots[0](0.05); bots[1](0.05);
    peak = Math.max(peak, sim.s.units.length);
    for (const u of sim.s.units) if (!Number.isFinite(u.x + u.z + u.men + u.morale)) throw new Error(`NaN in ${id}: ${u.name}`);
  }
  const r = sim.s.result;
  console.log(`${id.padEnd(10)} t=${Math.round(sim.s.t)}s winner=${r?.winner} score=${r?.score} lost=${r?.lost} units(end/peak)=${sim.s.units.length}/${peak} ${Date.now() - t0}ms zones=${sim.s.zones.map((z: any) => z.owner ?? '-').join('')}`);
}
