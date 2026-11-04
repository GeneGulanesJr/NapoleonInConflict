// Run: npm test   (node --test, no extra dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { applyResult, reinforce, recruit, fillCost, type CampaignState } from '../src/sim/roster.ts';
import { runner, parseReplay, replayFile, type Replay } from '../src/sim/replay.ts';
import { upscale } from '../src/render.ts';
import { readFileSync } from 'node:fs';
import { createSim, step, command, spawn as spawnUnit, SIM_VERSION, manPrice, distToFoot, posted, steady, foot, verdict } from '../src/sim/sim.ts';
import { makeBot } from '../src/sim/bot.ts';
import { heightAt, groundAt, los, deepAt, riverAt } from '../src/sim/world.ts';
import { route } from '../src/sim/path.ts';
import { resolve } from '../src/sim/extend.ts';

// ---------------------------------------------------------------- unit-vs-unit rules
const raw = (f: string) => JSON.parse(readFileSync(new URL(`../src/data/${f}.json`, import.meta.url), 'utf8')), data = (f: string) => resolve(raw(f), raw);
/** a bare quatrebras sim on flat open ground with just these units (French a, Coalition b) plus a far-off foe so the battle doesn't end */
function arena(setup: (fr: any[], co: any[]) => any[], map?: any) {
  const sim = createSim(raw('quatrebras'), data('tuning'), { seed: 1 }); // the unscaled data: unit-rule tests do not depend on the campaign map's stretched geometry
  for (const u of sim.s.units) u.men = u.maxMen = sim.tu.types[u.type].men; // nor on the scenario's strength balance: every regiment at its standard size
  const fr = sim.s.units.filter((u: any) => u.side === 0), co = sim.s.units.filter((u: any) => u.side === 1);
  sim.s.units = setup(fr, co).map((u) => Object.assign(u, { tx: null, tz: null, vet: 0, busy: 0 })); sim.tl = [];
  sim.s.side.forEach((sd: any) => (sd.reserves = {})); // bots must not deploy or call in aid mid-test
  sim.scn = { ...sim.scn, abilities: [[], []], map: map ?? { size: 400 } }; // unit-rule tests must not depend on the scenario's terrain; pass a map to test terrain
  return sim;
}
const run = (sim: any, secs: number, until = () => false, each = () => {}) => { for (let t = 0; t < secs && !until(); t += 0.05) { step(sim, 0.05); each(); } };

test('a regiment marches round a friendly one in its way, without overlapping or shoving it', () => {
  let a: any, b: any, worst = 0;
  const sim = arena((fr, co) => { [a, b] = fr.filter((u) => u.type === 'line'); return [Object.assign(a, { x: 0, z: -40, facing: 0, form: 'column' }), Object.assign(b, { x: 0, z: 0, facing: 0, form: 'line' }), Object.assign(co[0], { x: 170, z: 170 })]; });
  command(sim, 0, { c: 'move', ids: [a.id], x: 0, z: 40 });
  run(sim, 60, () => false, () => { worst = Math.min(worst, distToFoot(b, sim.tu, a.x, a.z) > 0 ? 0 : -1); });
  assert.ok(Math.hypot(a.x, a.z - 40) < 2, `marcher arrived (at ${a.x.toFixed(1)}, ${a.z.toFixed(1)})`);
  assert.equal(worst, 0, 'the marcher never stood inside the other formation');
  assert.ok(Math.hypot(b.x, b.z) < 0.5, 'the standing regiment kept its post');
});

test('a plain move order cannot march through the enemy: the line halts at contact and fights', () => {
  let a: any, e: any;
  const sim = arena((fr, co) => { a = fr.find((u) => u.type === 'line'); e = co.find((u) => u.type === 'line'); return [Object.assign(a, { x: 0, z: -30, facing: 0, form: 'column' }), Object.assign(e, { x: 0, z: 0, facing: Math.PI, form: 'line', stance: 'hold' })]; });
  command(sim, 0, { c: 'move', ids: [a.id], x: 0, z: 40 });
  let met = false;
  run(sim, 25, () => false, () => { met ||= a.eng === e.id; });
  assert.ok(met, 'the two regiments came to blows');
  assert.ok(a.z < e.z, `the marcher is still on its own side of the enemy (z ${a.z.toFixed(1)} vs ${e.z.toFixed(1)})`);
});

test('a square holds against equal cavalry but breaks when badly outnumbered', () => {
  const duel = (sqMen: number, cavMen: number) => {
    let cav: any, sq: any;
    const sim = arena((fr, co) => {
      cav = fr.find((u) => u.type === 'lancer'); sq = co.find((u) => u.type === 'line');
      return [Object.assign(cav, { men: cavMen, maxMen: cavMen, x: 0, z: -22, facing: 0 }), Object.assign(sq, { men: sqMen, maxMen: 540, form: 'square', x: 0, z: 0, facing: Math.PI })];
    });
    command(sim, 0, { c: 'attack', ids: [cav.id], target: sq.id });
    run(sim, 180, () => cav.routed || sq.routed || cav.dead || sq.dead);
    return sq.routed || sq.dead ? 'square' : 'cavalry';
  };
  assert.equal(duel(540, 540), 'cavalry', 'a full square sees off as many horsemen');
  assert.equal(duel(200, 360), 'square', 'a 200-man square swamped by 360 lancers breaks');
});

test('a regiment cannot fire through its own front line', () => {
  let front: any, rear: any;
  const sim = arena((fr, co) => { [front, rear] = fr.filter((u) => u.type === 'line'); return [Object.assign(front, { x: 0, z: -10, facing: 0, form: 'line' }), Object.assign(rear, { x: 0, z: -28, facing: 0, form: 'line' }), Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 4, facing: Math.PI, form: 'line', morale: 9999, maxMorale: 9999 })]; });
  const shots = [0, 0];
  run(sim, 30, undefined, () => { for (const e of sim.s.events) if (e.k === 'shot' && e.side === 0) shots[Math.abs(e.z - front.z) < 3 ? 0 : 1]++; sim.s.events.length = 0; });
  assert.ok(shots[0] > 0, 'the front line fires');
  assert.equal(shots[1], 0, 'the rear line holds its fire');
});

test('a group move lands regiments side by side without overlapping', () => {
  const sim = arena((fr, co) => [...fr.filter((u) => u.type === 'line').slice(0, 4).map((u, i) => Object.assign(u, { x: (i - 1.5) * 26, z: -60, facing: 0, form: 'line' })), Object.assign(co[0], { x: 170, z: 170 })]);
  const ls = sim.s.units.filter((u: any) => u.side === 0);
  command(sim, 0, { c: 'move', ids: ls.map((u: any) => u.id), x: 0, z: 40 });
  const ordered = ls.map((u: any) => [u.tx, u.tz]);
  run(sim, 60);
  ls.forEach((u: any, i: number) => assert.ok(Math.hypot(u.x - ordered[i][0], u.z - ordered[i][1]) < 1, `${u.name} stayed where it was sent`));
  const xs = ls.map((u: any) => u.x).sort((a: number, b: number) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] > 25.5, `lines ${i - 1}/${i} do not overlap (${(xs[i] - xs[i - 1]).toFixed(1)} apart)`);
});

test('bot infantry does not flip-flop formation when cavalry hovers nearby', () => {
  let cav: any, inf: any;
  const sim = arena((fr, co) => [cav = Object.assign(fr.find((u) => u.type === 'lancer'), { x: 0, z: -31, facing: 0, morale: 9999, maxMorale: 9999, men: 9999 }), inf = Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 0, facing: Math.PI, form: 'line' })]);
  const bot = makeBot(sim, 1);
  let changes = 0, last = inf.form; // only square in/out counts: marching in column is fine
  run(sim, 60, undefined, () => { cav.x = inf.x; cav.z = inf.z - 31; bot(0.05); if ((inf.form === 'square') !== (last === 'square')) changes++; last = inf.form; });
  assert.ok(changes <= 1 && inf.form === 'square', `formed square and stayed (${changes} square changes, ends in ${inf.form})`);
});

test('bot cavalry pulls up when its target forms a full square', () => {
  let cav: any, inf: any;
  const sim = arena((fr, co) => [cav = Object.assign(fr.find((u) => u.type === 'lancer'), { x: 0, z: -80, facing: 0, men: 270 }), inf = Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 0, facing: Math.PI, form: 'square', busy: 0, morale: 60 })]);
  sim.scn = { ...sim.scn, bot: ['attack', 'defend'] };
  const bot = makeBot(sim, 0);
  let hit = false, formed = false;
  run(sim, 60, () => cav.routed, () => { bot(0.05); if (inf.form === 'square') formed = true; if (cav.eng === inf.id && inf.form === 'square' && !(inf.busy > 0)) hit = true; });
  assert.ok(formed, 'the target did form square');
  assert.ok(!hit && !cav.routed, 'the cavalry never rode into the square');
});

test('artillery misses more the further it shoots', () => {
  const missRate = (z: number) => {
    let gun: any;
    const sim = arena((fr, co) => [gun = Object.assign(fr.find((u) => u.type === 'artillery'), { x: 0, z: 0, facing: 0 }), Object.assign(co.find((u) => u.type === 'line'), { x: 0, z, facing: Math.PI, form: 'line', morale: 9999, maxMorale: 9999, men: 9999 })]);
    let shots = 0, misses = 0;
    run(sim, 600, () => shots >= 60, () => { for (const e of sim.s.events) { if (e.k === 'shot' && e.side === 0) shots++; if (e.k === 'boom') misses++; } sim.s.events.length = 0; });
    return misses / shots;
  };
  const near = missRate(40), far = missRate(90);
  assert.ok(far > 0.35 && far > near + 0.15, `long range misses more (near ${near.toFixed(2)}, far ${far.toFixed(2)})`);
});

test('replenishing on an objective we hold (a depot) trickles men in at the deploy rate', () => {
  let home: any;
  const sim = arena((fr, co) => [home = fr.find((u) => u.type === 'line'), Object.assign(co[0], { x: 170, z: 170 })]);
  sim.tu.rpPerObjective = 0; sim.s.side[0].rp = 100; // no objective income during the test
  const z = Object.assign(sim.s.zones[0], { owner: 0, p: 1 });
  Object.assign(home, { x: z.x, z: z.z, men: 270 });
  command(sim, 0, { c: 'replenish', ids: [home.id] });
  assert.ok(!sim.s.units.some((u: any) => u.draftFor != null), 'no draft needed at a depot');
  run(sim, 20);
  assert.equal(Math.round(home.men), home.maxMen, 'the regiment on our objective is back to full strength');
  const m = home.maxMen - 270, cost = (30 / home.maxMen) * (m + (sim.tu.refillRise * m * m) / (2 * home.maxMen)); // deploy price (line = 30 pts), rising as the regiment fills
  assert.ok(Math.abs(sim.s.side[0].rp - (100 - cost)) < 0.5, `paid ${cost} pts (rp left ${sim.s.side[0].rp.toFixed(1)})`);
  assert.equal(home.refill, false, 'the order clears itself once full');
});

test('a reserve arrives at the objective we hold nearest our entry, skipping one under attack, else at the map edge', () => {
  const sim = arena((fr, co) => [fr[0], Object.assign(co[0], { x: 170, z: 170 })]);
  const sd = sim.s.side[0], zone = (id: string) => sim.s.zones.find((z: any) => z.id === id);
  sim.s.zones.forEach((z: any) => Object.assign(z, { owner: ['pp', 'pi', 'ge'].includes(z.id) ? 0 : null, contested: false })); // pp is nearest the French entry, then pi, then ge
  sd.reserves = { line: 3 }; sd.rp = 1e6;
  const deployed = () => { command(sim, 0, { c: 'deploy', type: 'line' }); return sim.s.units[sim.s.units.length - 1]; };
  const at = (u: any, z: any) => Math.hypot(u.x - z.x, u.z - z.z) < z.r;
  const a = deployed(); assert.ok(at(a, zone('pp')) && a.tx == null, `at the nearest held objective, standing (${a.x.toFixed(0)}, ${a.z.toFixed(0)})`);
  zone('pp').contested = true;
  const b = deployed(); assert.ok(at(b, zone('pi')), `the contested one is skipped (${b.x.toFixed(0)}, ${b.z.toFixed(0)})`);
  sim.s.zones.forEach((z: any) => (z.owner = null));
  const c = deployed(); assert.ok(c.z === sim.scn.entry[0].z && c.tx != null, 'holding nothing, it marches on from the entry');
});

test('the war chest is finite: RP comes only from objectives held and stops at the cap; the replacement pool runs dry', () => {
  let a: any, b: any;
  const sim = arena((fr, co) => { [a, b] = fr.filter((u) => u.type === 'line'); return [a, b, Object.assign(co[0], { x: 170, z: 170 })]; });
  const sd = sim.s.side[0], z = sim.s.zones[0];
  sim.s.zones.forEach((q: any) => Object.assign(q, { owner: null, p: 0 })); sd.rp = 0;
  run(sim, 10); assert.equal(sd.rp, 0, 'no objectives held, no income');
  Object.assign(z, { owner: 0, p: 1 }); sd.cap = 5;
  run(sim, 200); assert.ok(Math.abs(sd.rp - 5) < 1e-9 && sd.earned === 5, `income from the objective stops at the cap (rp ${sd.rp.toFixed(2)})`);
  Object.assign(a, { x: z.x - 6, z: z.z, men: 300 }); Object.assign(b, { x: z.x + 6, z: z.z, men: 300 }); sd.rp = 1e6; sd.pool = 100;
  command(sim, 0, { c: 'replenish', ids: [a.id, b.id] });
  run(sim, 40);
  assert.ok(Math.round(a.men + b.men) === 700 && sd.pool < 1, `only the 100-man pool came in (${Math.round(a.men + b.men - 600)} men)`);
  assert.ok(sim.tu.refillRise > 0 && Math.abs(manPrice(sim.tu, { type: 'line', maxMen: 540, refilled: 270 }) / manPrice(sim.tu, { type: 'line', maxMen: 540, refilled: 0 }) - 1.5) < 1e-9, 'half a regiment of replacements already in: +50% per man');
});

test('a posted regiment (standing still a while) takes fewer casualties than one that keeps shifting', () => {
  const hit = (settled: boolean) => {
    let tg: any;
    const sim = arena((fr, co) => [Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: -12, facing: 0, form: 'line', morale: 9999, maxMorale: 9999 }), tg = Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 0, facing: Math.PI, form: 'line', morale: 9999, maxMorale: 9999, still: settled ? 99 : 0 })]);
    run(sim, 40, undefined, () => { if (!settled) tg.still = 0; });
    return { cas: tg.maxMen - tg.men, mor: (9999 - tg.morale) / (tg.maxMen - tg.men) }; // men lost, morale lost per man lost
  };
  const p = hit(true), m = hit(false);
  assert.ok(p.cas > 0 && p.cas < m.cas * 0.93, `posted lost ${p.cas.toFixed(0)}, shifting lost ${m.cas.toFixed(0)}`);
  assert.ok(p.mor < m.mor * 0.9, `posted morale per man ${p.mor.toFixed(2)}, shifting ${m.mor.toFixed(2)}`);
});

test('a regiment reforming (busy) or a battery hitching up (limT) loses its posted standing', () => {
  for (const f of ['busy', 'limT']) {
    let u: any;
    const sim = arena((fr, co) => [u = Object.assign(fr.find((q) => q.type === 'line'), { x: 0, z: 100, still: 99 }), Object.assign(co[0], { x: 170, z: -170 })]);
    assert.ok(posted(u, sim.tu));
    u[f] = 3; step(sim, 0.05);
    assert.ok(u.still === 0 && !posted(u, sim.tu), `${f} resets still`);
  }
});

test('a posted regiment steadies against a charge by about hold.shock', () => {
  let d: any, a: any;
  const sim = arena((fr, co) => [a = Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: -12, facing: 0 }), d = Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 0, facing: Math.PI })]);
  sim.tu.shock.spread = 0; // no dice: find the lowest morale at which the line holds
  const floor = (still: number) => { d.still = still; for (let m = 0; m <= 1.001; m += 0.01) { d.morale = m * d.maxMorale; if (steady(sim, d, a)) return m; } return 9; };
  assert.ok(Math.abs(floor(0) - floor(99) - sim.tu.hold.shock) < 0.02, `holds from ${floor(0).toFixed(2)} shifting, ${floor(99).toFixed(2)} posted`);
});

test('off our objectives a draft marches in from our map edge at double cost and joins the regiment', () => {
  let reg: any;
  const sim = arena((fr, co) => [reg = Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: 100, men: 270 }), Object.assign(co[0], { x: 170, z: -170 })]);
  sim.s.side[0].rp = 100; sim.s.zones = []; // no depots (and so no income) anywhere
  command(sim, 0, { c: 'replenish', ids: [reg.id] });
  const d = sim.s.units.find((u: any) => u.draftFor === reg.id), cost = (2 * 30 * (reg.maxMen - 270)) / reg.maxMen;
  assert.ok(d && Math.max(Math.abs(d.x), Math.abs(d.z)) > 195 && d.men === reg.maxMen - 270, `a ${d?.men}-man draft sets out from the map edge (${d?.x.toFixed(0)}, ${d?.z.toFixed(0)})`);
  assert.ok(Math.abs(sim.s.side[0].rp - (100 - cost)) < 0.5, `paid ${cost} pts up front (rp left ${sim.s.side[0].rp.toFixed(1)})`);
  assert.equal(reg.men, 270, 'nobody appears out of thin air');
  run(sim, 120, () => d.dead);
  assert.ok(d.dead && Math.round(reg.men) === reg.maxMen, `the draft marched in and joined (${Math.round(reg.men)}/${reg.maxMen})`);
});

test('a dragged line order spreads the group over the drag and wheels it to face the ordered way', () => {
  const sim = arena((fr, co) => [...fr.filter((u) => u.type === 'line').slice(0, 2).map((u, i) => Object.assign(u, { x: -60, z: (i - 0.5) * 30, facing: 0, form: 'line' })), Object.assign(co[0], { x: 170, z: 170 })]);
  const ls = sim.s.units.filter((u: any) => u.side === 0);
  command(sim, 0, { c: 'move', ids: ls.map((u: any) => u.id), x: 0, z: 0, f: Math.PI / 2, w: 100 }); // a 100-wide line along z, facing +x
  run(sim, 40);
  for (const u of ls) assert.ok(Math.abs(u.facing - Math.PI / 2) < 1e-6 && Math.abs(u.x) < 1, `${u.name} stands on the line facing +x (x ${u.x.toFixed(1)}, facing ${u.facing.toFixed(2)})`);
  const [a, b] = ls.map((u: any) => u.z).sort((p: number, q: number) => p - q);
  assert.ok(b - a > 60, `spread over the drag (${(b - a).toFixed(1)} apart)`);
});

test('an attack-moving line stops to fire at an enemy it passes; a plain move marches on', () => {
  const pass = (am: boolean) => {
    let a: any;
    const sim = arena((fr, co) => [a = Object.assign(fr.find((u) => u.type === 'line'), { x: -80, z: 0, facing: Math.PI / 2, form: 'line', morale: 9999, maxMorale: 9999 }), Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 24, facing: Math.PI, form: 'line', morale: 9999, maxMorale: 9999 })]);
    command(sim, 0, { c: 'move', ids: [a.id], x: 80, z: 0, am });
    let shots = 0;
    run(sim, 120, undefined, () => { for (const e of sim.s.events) if (e.k === 'shot' && e.side === 0) shots++; sim.s.events.length = 0; });
    return { shots, x: a.x };
  };
  const am = pass(true), plain = pass(false);
  assert.ok(am.shots > 0 && am.x < 40, `attack-move halted and fired (${am.shots} shots, at x ${am.x.toFixed(1)})`);
  assert.ok(plain.shots === 0 && plain.x > 70, `plain move marched past without firing (${plain.shots} shots, at x ${plain.x.toFixed(1)})`);
});

// ---------------------------------------------------------------- realism pass
test('infantry marches at the real-scale pace (a column covers ~30 units in 10 s)', () => {
  const d = march('line', 'column', 10, { size: 400 });
  assert.ok(d > 24 && d < 36, `column covered ${d.toFixed(1)}`);
});

test('musketry reaches ~15 units: lines 25 apart do nothing, 10 apart trade volleys', () => {
  const lost = (gap: number) => { // front ranks sit 0.91 ahead of the unit position
    const sim = arena((fr, co) => [Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: -gap / 2 - 0.91, facing: 0, form: 'line' }), Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: gap / 2 + 0.91, facing: Math.PI, form: 'line', morale: 9999, maxMorale: 9999 })]);
    run(sim, 20);
    return sim.s.side[1].lost;
  };
  assert.equal(lost(25), 0, 'out of range at 25');
  assert.ok(lost(10) > 0, 'deadly at 10');
});

test('a line wheels slowly before stepping off; a column turns quickly', () => {
  const after = (form: string) => {
    let u: any;
    const sim = arena((fr, co) => [u = Object.assign(fr.find((q) => q.type === 'line'), { x: 0, z: 0, facing: 0, form }), Object.assign(co[0], { x: 170, z: 170 })]);
    command(sim, 0, { c: 'move', ids: [u.id], x: 40, z: 0 });
    run(sim, 2);
    return u;
  };
  const l = after('line'), c = after('column');
  assert.ok(Math.abs(l.x) < 0.01 && l.facing > 0.3 && l.facing < Math.PI / 2 - 0.3, `line still wheeling after 2 s (facing ${l.facing.toFixed(2)}, x ${l.x.toFixed(2)})`);
  assert.ok(c.x > 1.5, `column already marching (x ${c.x.toFixed(2)})`);
});

test('a regiment that lost half its men cannot recover to full morale', () => {
  let u: any;
  const sim = arena((fr, co) => [u = Object.assign(fr.find((q) => q.type === 'line'), { x: 0, z: 0, men: 270, morale: 20 }), Object.assign(co[0], { x: 170, z: 170 })]);
  run(sim, 200);
  assert.ok(u.morale > 50 && u.morale <= 0.75 * u.maxMorale, `recovered to ${u.morale.toFixed(1)} of ${u.maxMorale} (ceiling ${u.mcap.toFixed(1)})`);
});

test('marching tires a regiment, and tired men march slower', () => {
  let u: any;
  const sim = arena((fr, co) => [u = Object.assign(fr.find((q) => q.type === 'line'), { x: -150, z: 0, facing: Math.PI / 2, form: 'column' }), Object.assign(co[0], { x: 170, z: 170 })]);
  command(sim, 0, { c: 'move', ids: [u.id], x: 150, z: 0 });
  run(sim, 60);
  assert.ok(u.fat > 0.04, `fatigue after a 60 s march ${u.fat.toFixed(3)}`);
  const fresh = march('line', 'column', 10, { size: 400 }), tired = march('line', 'column', 10, { size: 400 }, { fat: 0.8 });
  assert.ok(tired < 0.8 * fresh, `tired ${tired.toFixed(1)} vs fresh ${fresh.toFixed(1)}`);
});

test('a bayonet charge breaks a shaken regiment before contact; a steady one gives a closing volley', () => {
  const charge = (morale: number) => {
    let a: any, d: any;
    const sim = arena((fr, co) => [a = Object.assign(fr.find((q) => q.type === 'line'), { x: 0, z: -20, facing: 0, form: 'line' }), d = Object.assign(co.find((q) => q.type === 'line'), { x: 0, z: 0, facing: Math.PI, form: 'line', morale, reload: 1e9 })]); // no ordinary fire: only the closing volley
    command(sim, 0, { c: 'bayonet', ids: [a.id], target: d.id });
    let contact = false, shots = 0;
    run(sim, 30, () => d.routed || a.eng != null || a.chase == null, () => { if (a.eng != null) contact = true; shots += sim.s.events.filter((e: any) => e.k === 'shot' && e.side === 1).length; sim.s.events.length = 0; });
    return { routed: d.routed, contact, shots, lost: a.maxMen - a.men };
  };
  const shaken = charge(15), steadyR = charge(100);
  assert.ok(shaken.routed && !shaken.contact && shaken.shots === 0, `shaken regiment broke before contact (${JSON.stringify(shaken)})`);
  assert.ok(!steadyR.routed && steadyR.shots === 1 && steadyR.lost > 20, `steady regiment stood and fired (${JSON.stringify(steadyR)})`);
});

test('a battery must limber up to move and unlimber before it can fire', () => {
  let g: any;
  const sim = arena((fr, co) => [g = Object.assign(fr.find((q) => q.type === 'artillery'), { x: 0, z: 0, facing: 0, reload: 0 }), Object.assign(co.find((q) => q.type === 'line'), { x: 0, z: 105, facing: Math.PI, form: 'line', morale: 9999, maxMorale: 9999 })]);
  command(sim, 0, { c: 'move', ids: [g.id], x: 0, z: 10 });
  let t = 0, moved = -1, halted = -1, shot = -1;
  run(sim, 40, () => shot >= 0, () => {
    t += 0.05;
    if (moved < 0 && g.z > 0.01) moved = t;
    if (moved >= 0 && halted < 0 && !g.mv) halted = t;
    if (sim.s.events.some((e: any) => e.k === 'shot' && e.side === 0)) shot = t;
    sim.s.events.length = 0;
  });
  const L = sim.tu.limber;
  assert.ok(moved >= L.up - 0.1, `limbered up before moving (moved at ${moved.toFixed(2)} s)`);
  assert.ok(halted > 0 && shot - halted >= L.down - 0.1, `unlimbered before firing (halted ${halted.toFixed(2)}, first shot ${shot.toFixed(2)})`);
});

test('artillery hurts a square about twice as much as a line', () => {
  const hurt = (form: string) => {
    let tg: any;
    const sim = arena((fr, co) => [Object.assign(fr.find((q) => q.type === 'artillery'), { x: 0, z: 0, facing: 0 }), tg = Object.assign(co.find((q) => q.type === 'line'), { x: 0, z: 45, facing: Math.PI, form, morale: 9999, maxMorale: 9999 })]);
    tg.z += 45 - distToFoot(tg, sim.tu, 0, 0); // same gap to the nearest rank whatever the formation
    run(sim, 60);
    return sim.s.side[1].lost;
  };
  const r = hurt('square') / hurt('line');
  assert.ok(r > 1.7 && r < 2.4, `square/line casualty ratio ${r.toFixed(2)}`);
});

// ---------------------------------------------------------------- terrain
const FLAT = { amp: 0, scale: 50, seed: 1 }; // rough ground with no amplitude = a dead-flat board

test('heightAt follows the map schema (rough ground, rotated plateau hills) and its cache equals the analytic value', () => {
  const scn = { map: { size: 500, rough: { amp: 1.2, scale: 60, seed: 7 }, hills: [{ x: 30, z: -40, rx: 80, rz: 20, h: 10, rot: 30, p: 2 }, { x: -100, z: 90, rx: 40, rz: 40, h: -4 }] } };
  let worst = 0;
  for (let x = -250; x <= 250; x += 14) for (let z = -250; z <= 250; z += 14) {
    assert.equal(heightAt(scn, x, z), groundAt(scn.map, x, z), `grid point ${x},${z}`);
    worst = Math.max(worst, Math.abs(heightAt(scn, x + 0.7, z + 1.3) - groundAt(scn.map, x + 0.7, z + 1.3)));
  }
  assert.ok(worst < 0.15, `between grid points the cache stays close (${worst.toFixed(3)})`);
  const ridge = { map: { size: 200, rough: FLAT, hills: [{ x: 0, z: 0, rx: 50, rz: 10, h: 10, rot: 90, p: 2 }] } }; // turned to run north-south
  assert.ok(Math.abs(heightAt(ridge, 0, 30) - 10 * Math.exp(-(0.36 ** 2))) < 0.01, 'a rotated plateau ridge runs along its long axis');
  assert.ok(heightAt(ridge, 30, 0) < 0.01, 'and is narrow across it');
});

test('a ridge between two regiments blocks their fire; open ground does not', () => {
  const shots = (hills: any[]) => {
    const sim = arena((fr, co) => [Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: -8, facing: 0, form: 'line' }), Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 8, facing: Math.PI, form: 'line' })], { size: 400, rough: FLAT, hills });
    let n = 0;
    run(sim, 20, undefined, () => { n += sim.s.events.filter((e: any) => e.k === 'shot').length; sim.s.events.length = 0; });
    return n;
  };
  assert.ok(shots([]) > 0, 'on open ground they trade volleys');
  assert.equal(shots([{ x: 0, z: 0, rx: 300, rz: 5, h: 8, p: 2 }]), 0, 'with a ridge between them nobody fires');
});

/** distance a unit covers in `secs` heading east from x=-60 over the given map */
function march(type: string, form: string, secs: number, map: any, extra = {}) {
  let u: any;
  const sim = arena((fr, co) => [u = Object.assign(fr.find((q) => q.type === type), { x: -60, z: 0, facing: Math.PI / 2, form, ...extra }), Object.assign(co[0], { x: 170, z: 170 })], map);
  command(sim, 0, { c: 'move', ids: [u.id], x: 100, z: 0 });
  run(sim, secs);
  return u.x + 60;
}

test('woods slow cavalry more than infantry', () => {
  const ratio = (type: string, form: string) => march(type, form, 4, { size: 400, rough: FLAT, woods: [{ x: 0, z: 0, r: 120 }] }) / march(type, form, 4, { size: 400, rough: FLAT });
  const cav = ratio('lancer', 'line'), inf = ratio('line', 'line');
  assert.ok(cav < inf - 0.15, `cavalry keeps ${cav.toFixed(2)} of its pace in woods, infantry ${inf.toFixed(2)}`);
});

test('a column marches faster on a road', () => {
  const road = march('line', 'column', 5, { size: 400, rough: FLAT, roads: [{ pts: [[-200, 0], [200, 0]], w: 4 }] }), off = march('line', 'column', 5, { size: 400, rough: FLAT });
  assert.ok(road > off * 1.2, `road ${road.toFixed(1)} vs open ${off.toFixed(1)}`);
});

test('units wade a fordable river instead of detouring, but go round a deep one by the bridge', () => {
  const cross = (ford?: number) => {
    let u: any, wide = 0;
    const sim = arena((fr, co) => [u = Object.assign(fr.find((q) => q.type === 'line'), { x: 0, z: -30, facing: 0, form: 'column' }), Object.assign(co[0], { x: 170, z: 170 })], { size: 400, rough: FLAT, rivers: [{ pts: [[-200, 0], [200, 0]], width: 8, bridges: [[24, 0]], ...(ford ? { ford } : {}) }] });
    command(sim, 0, { c: 'move', ids: [u.id], x: 0, z: 30 });
    run(sim, 30, undefined, () => { wide = Math.max(wide, Math.abs(u.x)); });
    return { wide, there: Math.hypot(u.x, u.z - 30) < 1.5 };
  };
  const ford = cross(0.5), deep = cross();
  assert.ok(ford.there && ford.wide < 3, `waded straight over the ford (strayed ${ford.wide.toFixed(1)})`);
  assert.ok(deep.wide > 15, `went round by the bridge over deep water (strayed ${deep.wide.toFixed(1)})`);
});

test('deep water is impassable without a bridge, and a line crosses a bridge dry', () => {
  const cross = (bridges: number[][], form: string) => {
    let u: any, wet = false;
    const sim = arena((fr, co) => [u = Object.assign(fr.find((q) => q.type === 'line'), { x: -50, z: -30, facing: 0, form }), Object.assign(co[0], { x: 170, z: 170 })], { size: 400, rough: FLAT, rivers: [{ pts: [[-200, 0], [200, 0]], width: 8, bridges }] });
    command(sim, 0, { c: 'move', ids: [u.id], x: 40, z: 40 });
    run(sim, 150, undefined, () => { if (deepAt(sim.scn, u.x, u.z)) wet = true; });
    return { z: u.z, wet };
  };
  const none = cross([], 'column'), line = cross([[0, 0]], 'line');
  assert.ok(none.z < -4 && !none.wet, `held at the bank (z ${none.z.toFixed(1)})`);
  assert.ok(line.z > 38 && !line.wet, `a line crossed by the bridge without wading (z ${line.z.toFixed(1)})`);
});

test('a dragged group order packs regiments side by side, 2 units between their footprints, and the gap is tunable', () => {
  const sim = arena((fr, co) => [...fr.filter((q) => q.type === 'line').slice(0, 3), co[0]]), us = sim.s.units.filter((u: any) => u.side === 0), gap = (tu: any) => {
    const ps = layout(us, { x: 0, z: 0, f: 0 }, tu, 200), w = (u: any) => { const f = foot(u, tu); return f[1] - f[0]; };
    return ps.slice(1).map((p, i) => Math.hypot(p.x - ps[i].x, p.z - ps[i].z) - (w(p.u) + w(ps[i].u)) / 2);
  };
  assert.ok(us.length === 3 && gap(sim.tu).every((g) => Math.abs(g - 2 * sim.tu.groupGap) < 0.01), `neighbours ${gap(sim.tu).map((g) => g.toFixed(2))} apart`);
  assert.ok(gap({ ...sim.tu, groupGap: 3 })[0] > gap(sim.tu)[0] + 3, 'a wider gap in tuning spreads them');
});

test('a dragged front fills the drag: wider spreads the regiments, narrower packs them, then a second rank forms behind, then column, then single file', () => {
  const sim = arena((fr, co) => [...fr.filter((q) => q.type === 'line').slice(0, 4).map((q, i) => Object.assign(q, { x: -60 + i * 25, z: -80, facing: 0, form: 'line' })), co[0]]), us = sim.s.units.filter((u: any) => u.side === 0);
  const at = (w: number) => {
    const ps = layout(us, { x: 0, z: 0, f: 0, w }, sim.tu, 198), xs = ps.map((p) => p.x).sort((a, b) => a - b), zs = [...new Set(ps.map((p) => Math.round(p.z)))].sort((a, b) => b - a);
    return { form: ps[0].form, rows: zs.length, zs, step: (xs[xs.length - 1] - xs[0]) / (xs.length - 1) };
  };
  const wide = at(300), mid = at(160), tight = at(110), two = at(60), col = at(40), file = at(15);
  assert.equal(us.length, 4);
  assert.ok(wide.form === 'line' && wide.rows === 1 && wide.step > mid.step + 20 && mid.step > tight.step + 5, `wider drag, wider spacing (${wide.step.toFixed(0)} > ${mid.step.toFixed(0)} > ${tight.step.toFixed(0)})`);
  assert.ok(two.form === 'line' && two.rows === 2 && two.zs[0] === 0 && two.zs[1] < -6, `too narrow for four lines abreast: a second rank forms behind the front (${two.zs})`);
  assert.ok(col.form === 'column' && col.rows === 2, 'narrower still: columns, two ranks');
  assert.ok(file.form === 'column' && file.rows === 4 && file.zs.every((z, i) => i === 0 || z < file.zs[i - 1] - 3), 'a tiny drag: a single file');
});

test('the front rank is the regiments already nearest the destination, and a rank never overlaps the one in front', () => {
  const sim = arena((fr, co) => [...fr.filter((q) => q.type === 'line').slice(0, 4).map((q, i) => Object.assign(q, { x: -60 + i * 25, z: -80 + (i === 2 ? 40 : 0), facing: 0, form: 'line' })), co[0]]), us = sim.s.units.filter((u: any) => u.side === 0);
  const ps = layout(us, { x: 0, z: 0, f: 0, w: 60 }, sim.tu, 198), front = ps.filter((p) => Math.abs(p.z) < 1);
  assert.ok(front.length === 2 && front.some((p) => p.u === us[2]), 'the regiment already furthest forward takes the front rank');
  for (const p of ps) for (const q of ps) if (p !== q) { const f = foot({ ...p.u, form: p.form }, sim.tu), g = foot({ ...q.u, form: q.form }, sim.tu), lx = Math.abs(p.x - q.x) - (f[1] - f[0]) / 2 - (g[1] - g[0]) / 2, lz = Math.abs(p.z - q.z) - (f[3] - f[2] + g[3] - g[2]) / 2; assert.ok(lx >= -0.01 || lz >= -0.01, 'no two footprints overlap'); }
});

test('a dragged front orders each regiment into the line or column that fits, and they arrive in it', () => {
  let ls: any[] = [];
  const sim = arena((fr, co) => [...(ls = fr.filter((q) => q.type === 'line').slice(0, 3).map((q, i) => Object.assign(q, { x: -50 + i * 25, z: -60, facing: 0, form: 'line' }))), Object.assign(co[0], { x: 170, z: 170 })]);
  command(sim, 0, { c: 'move', ids: ls.map((u) => u.id), x: 0, z: 0, f: 0, w: 40 }); // too narrow for three lines abreast
  assert.ok(ls.every((u) => u.form === 'column'), 'ordered into column');
  run(sim, 120);
  assert.ok(ls.every((u) => u.form === 'column' && Math.abs(u.z) < 3), 'arrived in column on the line');
});

test('a regiment walks round the end of a river that has no bridge, staying dry', () => {
  let u: any, wet = false;
  const sim = arena((fr, co) => [u = Object.assign(fr.find((q) => q.type === 'line'), { x: -50, z: -30, facing: 0, form: 'column' }), Object.assign(co[0], { x: 170, z: 170 })], { size: 400, rough: FLAT, rivers: [{ pts: [[-200, 0], [40, 0]], width: 8, bridges: [] }] });
  command(sim, 0, { c: 'move', ids: [u.id], x: -50, z: 40 });
  run(sim, 200, () => Math.hypot(u.x + 50, u.z - 40) < 3, () => { if (deepAt(sim.scn, u.x, u.z)) wet = true; });
  assert.ok(Math.hypot(u.x + 50, u.z - 40) < 6 && !wet, `went round the river's end (at ${u.x.toFixed(0)}, ${u.z.toFixed(0)}, wet ${wet})`);
});

test('a regiment near its own general marches faster', () => {
  const trial = (near: boolean) => {
    let u: any, c: any;
    const sim = arena((fr, co) => [u = Object.assign(fr.find((q) => q.type === 'line'), { x: 0, z: 0, facing: 0, form: 'column' }), c = Object.assign(fr.find((q) => q.type === 'commander'), { x: near ? 10 : -150, z: 0 }), Object.assign(co[0], { x: 170, z: 170 })]);
    command(sim, 0, { c: 'move', ids: [u.id], x: 0, z: 200 });
    run(sim, 10);
    return { aura: u.aura, went: u.z };
  };
  const near = trial(true), far = trial(false);
  assert.ok(near.aura && !far.aura, 'the aura follows the general');
  assert.ok(near.went > far.went * 1.03, `marched further under the general's eye (${near.went.toFixed(1)} vs ${far.went.toFixed(1)})`);
});

test('under its general a regiment shoots from further off and reloads faster', () => {
  const trial = (near: boolean, dz: number) => {
    let u: any, e: any;
    const sim = arena((fr, co) => [u = Object.assign(fr.find((q) => q.type === 'line'), { x: 0, z: 0, facing: 0, form: 'line' }), Object.assign(fr.find((q) => q.type === 'commander'), { x: near ? 10 : -150, z: 0 }), e = Object.assign(co.find((q) => q.type === 'line'), { x: 0, z: dz, facing: Math.PI, form: 'line', stance: 'hold' })]);
    const m0 = e.men; run(sim, 8);
    return { lost: m0 - e.men, reload: u.reload };
  };
  const R = data('tuning').types.line.range, ca = data('tuning').commanderAura;
  assert.ok(Math.abs(ca.range * R - 17.25) < 1e-6 || ca.range > 1, 'aura lengthens the range');
  let d = 14; while (trial(false, d).lost === 0 && d < 60) d += 0.5; // nearest the unaided regiment fails to reach...
  let far = d; while (trial(false, far).lost > 0 && far < 60) far += 0.5; // ...farthest it still hits
  assert.equal(trial(false, far).lost, 0);
  assert.ok(trial(true, far).lost > 0, `the general's regiment still hits at a spacing (${far}) beyond the unaided reach`);
});

test('a cavalry charge downhill hits harder than one uphill', () => {
  const charge = (hz: number) => {
    let cav: any, inf: any;
    const sim = arena((fr, co) => [cav = Object.assign(fr.find((u) => u.type === 'lancer'), { x: 0, z: -30, facing: 0 }), inf = Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 0, facing: Math.PI, form: 'line', morale: 9999, maxMorale: 9999, reload: 1e9 })], { size: 400, rough: FLAT, hills: [{ x: 0, z: hz, rx: 1000, rz: 40, h: 14 }] });
    command(sim, 0, { c: 'attack', ids: [cav.id], target: inf.id });
    run(sim, 30, () => cav.eng != null);
    const m0 = inf.men;
    run(sim, 3);
    return m0 - inf.men;
  };
  const down = charge(-28), up = charge(28);
  assert.ok(down > up * 1.4, `downhill charge kills ${down.toFixed(0)}, uphill ${up.toFixed(0)}`);
});

// ---------------------------------------------------------------- campaign roster
test('applyResult drops destroyed regiments, heals survivors, advances the campaign', () => {
  const camp = { battles: ['a', 'b'], healFraction: 0.5 };
  const c: CampaignState = {
    idx: 0, results: {}, ended: null,
    roster: [{ rid: 1, type: 'line', name: 'A', men: 100, maxMen: 100 }, { rid: 2, type: 'line', name: 'B', men: 100, maxMen: 100 }, { rid: 3, type: 'line', name: 'C', men: 60, maxMen: 100 }],
  };
  const out = [{ rid: 1, men: 0, fate: 'dead' }, { rid: 2, men: 50, fate: 'field', xp: 12 }];
  const n1 = applyResult(c, camp, 'a', { result: { winner: 0 }, out });
  assert.deepEqual(n1.roster.map((u) => [u.rid, u.men]), [[2, 75], [3, 80]]); // 50 -> +half of missing; unit 3 did not fight but also rests
  assert.equal(n1.roster[0].xp, 12);
  assert.equal(n1.results.a, 'win');
  assert.equal(n1.idx, 1);
  assert.equal(n1.ended, null);
  assert.equal(c.roster.length, 3, 'input is not mutated');
  const n2 = applyResult(n1, camp, 'b', { result: { winner: 1 }, out: [] });
  assert.equal(n2.ended, 'waterloo_loss');
});

test('glory: earned per result, buys replacements weakest first, raises only destroyed regiments', () => {
  const tu = data('tuning'), camp = { battles: ['a', 'b'], healFraction: 0, glory: { win: 90, draw: 60, loss: 40 }, recruitCost: 1.5, roster: { line: ['A', 'B', 'C'] } };
  const c: CampaignState = { idx: 0, results: {}, ended: null, roster: [{ rid: 1, type: 'line', name: 'A', men: 270, maxMen: 540 }, { rid: 2, type: 'line', name: 'B', men: 405, maxMen: 540 }] };
  const n = applyResult(c, camp, 'a', { result: { winner: 0 }, out: [] });
  assert.equal(n.glory, 90, 'a win earns 90');
  assert.equal(fillCost(n, tu, 'line'), 23, '405 men missing at 30 glory per 540');
  n.glory = 10; // 180 men
  assert.ok(reinforce(n, tu, 'line'));
  assert.deepEqual(n.roster.map((u) => u.men), [450, 405], 'the weakest regiment is topped up first');
  assert.equal(n.glory, 0);
  assert.ok(!recruit(n, camp, tu, 'line'), 'no glory left');
  n.glory = 45;
  assert.ok(recruit(n, camp, tu, 'line'));
  assert.deepEqual(n.roster.map((u) => [u.rid, u.name, u.men]).at(-1), [3, 'C', 540], 'raised under the lost name, at full strength');
  n.glory = 99;
  assert.ok(!recruit(n, camp, tu, 'line'), 'nothing left to raise');
});

// ---------------------------------------------------------------- QoL pass: targeting, replays, bot
test('a regiment ordered to attack one foe fires at it even when another is nearer', () => {
  let a: any, near: any, far: any;
  const sim = arena((fr, co) => { const [c1, c2] = co.filter((u) => u.type === 'line'); return [a = Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: 0, facing: 0, form: 'line', morale: 9999, maxMorale: 9999 }), near = Object.assign(c1, { x: -14, z: 8, facing: Math.PI, morale: 9999, maxMorale: 9999 }), far = Object.assign(c2, { x: 22, z: 11, facing: Math.PI, morale: 9999, maxMorale: 9999 })]; }); // both in musket range (without the order it fires at near)
  command(sim, 0, { c: 'attack', ids: [a.id], target: far.id });
  const at = { near: 0, far: 0 };
  run(sim, 30, undefined, () => { for (const e of sim.s.events) if (e.k === 'shot' && e.side === 0) at[e.tx === near.x ? 'near' : 'far']++; sim.s.events.length = 0; });
  assert.ok(at.far >= 2 && at.near === 0, `volleys at the ordered target ${at.far}, at the nearer one ${at.near}`);
});

test('a recorded battle replays exactly, orders and bot included', () => {
  const scn = data('quatrebras'), tu = data('tuning');
  const rec: Replay = { scn, side: 0, start: JSON.stringify(createSim(scn, tu, { seed: 7 }).s), cmds: [] };
  const live = runner(tu, rec), ids = live.sim.s.units.filter((u: any) => u.side === 0).map((u: any) => u.id);
  for (let n = 0; n < 2400; n++) {
    if (n === 0) live.cmd({ c: 'move', ids, x: 0, z: 0 });
    if (n === 600) live.cmd({ c: 'form', ids, f: 'column' });
    if (n === 900) live.cmd({ c: 'stance', ids, s: 'aggressive' });
    live.tick();
  }
  const again = runner(tu, rec, true);
  for (let n = 0; n < 2400; n++) again.tick();
  assert.equal(rec.cmds.length, 3);
  assert.ok(live.sim.s.side[0].lost > 0 && live.sim.s.side[1].lost > 0, 'there was fighting');
  assert.equal(JSON.stringify(again.sim.s), JSON.stringify(live.sim.s));
});

test('a worn-down bot regiment falls back to an objective it holds and takes on replacements there', () => {
  let r: any;
  const sim = arena((fr, co) => [Object.assign(fr[0], { x: 170, z: 170 }), r = Object.assign(co.find((u) => u.type === 'line'), { x: 60, z: 60, men: 150 })]);
  Object.assign(sim.s.side[1], { rp: 100, pool: 1000 });
  sim.scn = { ...sim.scn, bot: ['defend', 'attack'] }; // attacking, it would otherwise march on the French objective (pi), not back to ge
  const z = sim.s.zones.find((q: any) => q.id === 'ge'), bot = makeBot(sim, 1);
  run(sim, 240, () => r.men >= 0.95 * r.maxMen, () => bot(0.05));
  assert.ok(r.men >= 0.95 * r.maxMen && Math.hypot(r.x - z.x, r.z - z.z) < z.r, `refilled to ${Math.round(r.men)} at (${r.x.toFixed(0)}, ${r.z.toFixed(0)})`);
});

test('bot cavalry rides round to the flank of a foe pinned by its infantry, not into its front', () => {
  let cav: any, foe: any;
  const sim = arena((fr, co) => [foe = Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 0, facing: 0, form: 'line', morale: 9999, maxMorale: 9999 }), Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: 14, facing: Math.PI, form: 'line', morale: 9999, maxMorale: 9999 }), cav = Object.assign(fr.find((u) => u.type === 'lancer'), { x: 0, z: 60, facing: Math.PI })]);
  const bot = makeBot(sim, 0);
  run(sim, 90, () => cav.eng === foe.id, () => bot(0.05));
  const k = ((cav.x - foe.x) * Math.sin(foe.facing) + (cav.z - foe.z) * Math.cos(foe.facing)) / Math.hypot(cav.x - foe.x, cav.z - foe.z);
  assert.ok(cav.eng === foe.id && k <= 0.5, `charged home from the ${k > 0.5 ? 'front' : k < -0.5 ? 'rear' : 'flank'} (cos ${k.toFixed(2)})`);
});

// ---------------------------------------------------------------- render resolution per monitor
test('upscale keeps every monitor near its quality row target', () => {
  // [quality, physical window height, expected upscale]: High rounds, so a browser window on 1080p is not rendered at full res
  for (const [q, H, s] of [[2, 950, 2], [2, 1080, 2], [2, 1300, 2], [2, 912, 2], [2, 960, 2], [2, 1900, 4], [2, 2000, 4], [3, 1440, 1], [3, 2160, 2], [1, 1080, 3], [0, 950, 3], [0, 400, 2]]) assert.equal(upscale(q, H), s, `quality ${q}, ${H}px`);
  for (let H = 540; H <= 2160; H += 7) assert.ok(H / upscale(0, H) >= 270, `guide keeps >= 270 rows at ${H}px`);
});

// ---------------------------------------------------------------- multiplayer server
const PORT = 19000 + Math.floor(Math.random() * 1000);
let server: ChildProcess;
const url = `ws://localhost:${PORT}`;

function startServer() {
  return new Promise<void>((resolve, reject) => {
    server = spawn(process.execPath, ['server/server.ts'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout!.on('data', (d) => { if (String(d).includes('Napoleon In Conflict server')) resolve(); });
    server.on('exit', (code) => reject(new Error(`server exited early (${code})`)));
  });
}
type Client = { ws: WebSocket; side: number; last: any; send(m: unknown): void };
function connect(scenario: string, join = true): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url), cl: Client = { ws, side: -1, last: null, send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)) };
    ws.on('open', () => { if (join) cl.send({ t: 'join', scenario }); else resolve(cl); });
    ws.on('error', reject);
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.t === 'hello') cl.side = m.side;
      if (m.t === 'state') { const first = !cl.last; cl.last = m.s; if (first) resolve(cl); }
    });
  });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const finite = (s: any) => s.units.every((u: any) => [u.x, u.z, u.men, u.morale].every(Number.isFinite));

test('server survives malformed packets and keeps state finite', async () => {
  await startServer();
  try {
    const a = await connect('quatrebras');
    const u = a.last.units.find((x: any) => x.side === a.side && x.type === 'line');
    const bad = [
      'null', '5', '[]', 'not json',
      { t: 'cmd' }, { t: 'cmd', c: null }, { t: 'cmd', c: { c: 'move' } },
      { t: 'cmd', c: { c: 'move', ids: [u.id] } }, { t: 'cmd', c: { c: 'move', ids: [u.id], x: 'a', z: 1 } },
      { t: 'cmd', c: { c: 'form', ids: [u.id], f: 'constructor' } },
      { t: 'cmd', c: { c: 'deploy', type: 'constructor' } },
      { t: 'cmd', c: { c: 'ability', name: 'barrage' } },
      { t: 'cmd', c: { c: 'attack', ids: [u.id] } }, { t: 'cmd', c: { c: 'bayonet', ids: [u.id], target: 'x' } },
      { t: 'cmd', c: { c: 'move', ids: [u.id], x: 1, z: 1, run: 'yes', keep: {} } }, { t: 'cmd', c: { c: 'face', ids: [u.id], x: 'a', z: 1 } }, { t: 'cmd', c: { c: 'face', ids: 'all', x: 1, z: 1 } },
    ];
    for (const m of bad) a.send(m);
    const evil = await connect('', false);
    for (const scenario of ['constructor', '__proto__', 5]) evil.send({ t: 'join', scenario });
    evil.send('null');
    await wait(600);
    assert.equal(server.exitCode, null, 'server is still running');
    assert.ok(finite(a.last), 'no NaN in the battle state');
    const b = await connect('quatrebras');
    assert.ok(b.last.t > 0, 'a new client still gets state');
    evil.ws.close(); b.ws.close(); a.ws.close();
  } finally { server.removeAllListeners('exit'); server.kill(); }
});

test('server applies valid move and stance commands', async () => {
  await startServer();
  try {
    const a = await connect('quatrebras');
    const u = a.last.units.find((x: any) => x.side === a.side && x.type === 'line');
    const v = a.last.units.find((x: any) => x.side === a.side && x.type === 'line' && x.id !== u.id);
    a.send({ t: 'cmd', c: { c: 'move', ids: [u.id], x: u.x + 30, z: u.z - 30, run: true, col: true, keep: false, pace: 0 } }); // pace is the sim's own: a client's is dropped
    a.send({ t: 'cmd', c: { c: 'stance', ids: [u.id], s: 'aggressive' } });
    a.send({ t: 'cmd', c: { c: 'face', ids: [v.id], x: v.x + 40, z: v.z } });
    await wait(4500);
    const u2 = a.last.units.find((x: any) => x.id === u.id), v2 = a.last.units.find((x: any) => x.id === v.id);
    assert.ok(Math.hypot(u2.x - u.x, u2.z - u.z) > 3 && u2.run === true, 'unit moved at double time');
    assert.equal(u2.stance, 'aggressive');
    assert.ok(Math.abs(v2.facing - v.facing) > 0.5 && Math.hypot(v2.x - v.x, v2.z - v.z) < 1, 'the other wheeled in place');
    a.ws.close();
  } finally { server.removeAllListeners('exit'); server.kill(); }
});

test('a scripted reinforcement keeps to its historical route until it arrives, then the bot takes over', () => {
  const sim = arena((fr, co) => [Object.assign(fr[0], { x: -170, z: 170 }), Object.assign(co.find((u) => u.type === 'line'), { x: 170, z: -170 })]);
  sim.tl = [{ t: 0.1, type: 'reinforce', side: 1, units: [{ type: 'line', n: 1, name: 'Bülow', x: 0, z: 0 }], entry: { x: 150, z: 100 }, go: { x: 150, z: -60 } }];
  const bot = makeBot(sim, 1);
  run(sim, 20, undefined, () => bot(0.05));
  const b = sim.s.units.find((u: any) => u.name === 'Bülow');
  assert.ok(b && b.tz === -60 && b.z < 100 - 30, `still marching on its route (z ${b?.z.toFixed(1)}, target z ${b?.tz})`);
});

test('a regiment hit on the flank wheels into contact at a limited rate, not in one tick', () => {
  let cav: any, inf: any;
  const sim = arena((fr, co) => {
    cav = fr.find((u) => u.type === 'lancer'); inf = co.find((u) => u.type === 'line');
    return [Object.assign(cav, { x: -80, z: 0, facing: Math.PI / 2, form: 'line' }), Object.assign(inf, { x: 0, z: 0, facing: Math.PI, form: 'line', stance: 'hold' }), Object.assign(co.find((u) => u !== inf), { x: 170, z: 170 })];
  });
  command(sim, 0, { c: 'attack', ids: [cav.id], target: inf.id });
  let worst = 0, last = inf.facing;
  run(sim, 16, () => inf.routed, () => { worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(inf.facing - last), Math.cos(inf.facing - last)))); last = inf.facing; }); // until it breaks: a routing line turns at the faster rout rate
  assert.ok(inf.facing !== Math.PI, 'the line turned to face the horse');
  assert.ok(worst <= sim.tu.turn.engage * 0.05 + 1e-6, `facing changed ${worst.toFixed(3)} rad in one tick (cap ${(sim.tu.turn.engage * 0.05).toFixed(3)})`);
});

test('a routing regiment turns to flee at the rout rate, not in one tick', () => {
  let a: any;
  const sim = arena((fr, co) => { a = fr.find((u) => u.type === 'line'); return [Object.assign(a, { x: 0, z: 0, facing: 0, form: 'line', routed: true, morale: 0 }), Object.assign(co[0], { x: 30, z: -10 })]; });
  let worst = 0, last = a.facing;
  run(sim, 4, () => false, () => { worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(a.facing - last), Math.cos(a.facing - last)))); last = a.facing; });
  assert.ok(worst > 0 && worst <= sim.tu.turn.rout * 0.05 + 1e-6, `facing changed ${worst.toFixed(3)} rad in one tick`);
});

test('cavalry ordered away from a melee breaks contact in a couple of seconds and keeps its nerve', () => {
  let cav: any, inf: any;
  const sim = arena((fr, co) => {
    cav = fr.find((u) => u.type === 'lancer'); inf = co.find((u) => u.type === 'line');
    return [Object.assign(cav, { x: 0, z: -60, facing: 0, form: 'line' }), Object.assign(inf, { x: 0, z: 0, facing: Math.PI, form: 'line', stance: 'hold' }), Object.assign(co.find((u) => u !== inf), { x: 170, z: 170 })];
  });
  command(sim, 0, { c: 'attack', ids: [cav.id], target: inf.id });
  run(sim, 30, () => cav.eng != null && sim.s.t > 8);
  assert.ok(cav.eng != null, 'the lancers are locked in melee');
  command(sim, 0, { c: 'move', ids: [cav.id], x: 0, z: -90 });
  let t = 0; run(sim, 3, () => cav.eng == null, () => { t += 0.05; });
  assert.ok(cav.eng == null && !cav.routed, `broke contact within 3 s (took ${t.toFixed(1)} s)`);
  assert.ok(cav.morale / cav.maxMorale > 0.5, `kept its nerve (morale ${Math.round((cav.morale / cav.maxMorale) * 100)}%)`);
});

/** lancers locked in melee with a steady line in hold stance (charged from 60 away, flat ground); charge: with the Charge special */
function lancersInMelee(infMen = 540, charge = false, setup = (_sim: any) => {}) {
  let cav: any, inf: any;
  const sim = arena((fr, co) => {
    cav = fr.find((u) => u.type === 'lancer'); inf = co.find((u) => u.type === 'line');
    return [Object.assign(cav, { x: 0, z: -60, facing: 0 }), Object.assign(inf, { x: 0, z: 0, facing: Math.PI, form: 'line', stance: 'hold', men: infMen, morale: 9999, maxMorale: 9999 }), Object.assign(co.find((u) => u !== inf), { x: 170, z: 170 })];
  });
  setup(sim);
  command(sim, 0, { c: 'attack', ids: [cav.id], target: inf.id });
  if (charge) command(sim, 0, { c: 'special', ids: [cav.id] });
  run(sim, 30, () => cav.eng != null);
  return { sim, cav, inf };
}

test('horse breaking off a melee takes only a parting blow (no rear bonus) and strikes none', () => {
  const cost = (leave: boolean) => {
    const { sim, cav, inf } = lancersInMelee(), m = cav.men, mo = cav.morale, im = inf.men;
    if (leave) command(sim, 0, { c: 'move', ids: [cav.id], x: 0, z: -90 });
    run(sim, 1.5);
    return { men: m - cav.men, morale: mo - cav.morale, dealt: im - inf.men };
  };
  const off = cost(true), stay = cost(false);
  assert.ok(off.men < 0.6 * stay.men && off.morale < 0.6 * stay.morale, `breaking off cost ${off.men.toFixed(1)} men / ${off.morale.toFixed(1)} morale; standing ${stay.men.toFixed(1)} / ${stay.morale.toFixed(1)}`);
  assert.equal(off.dealt, 0, 'no blows struck while riding away');
});

test('foot hit by a cavalry charge is stunned: it cannot reform until the stun wears off', () => {
  const { sim, inf } = lancersInMelee();
  assert.ok(inf.stun > 2 && inf.busy >= inf.stun, `stunned for ${inf.stun.toFixed(1)} s`);
  command(sim, 1, { c: 'form', ids: [inf.id], f: 'square' });
  assert.equal(inf.form, 'line', 'cannot form square while stunned');
  run(sim, 10, () => inf.stun <= 0 || inf.routed);
  assert.ok(inf.stun <= 0 && !inf.routed, 'the stun wears off');
  inf.shaken = 0; // (the lancers' blows may have rattled it too)
  command(sim, 1, { c: 'form', ids: [inf.id], f: 'square' });
  assert.equal(inf.form, 'square', 'and it can reform again');
});

test('the stun is in proportion to the impact: a worn regiment longer, a true Charge longer, a faltering one shorter', () => {
  const full = lancersInMelee().inf.stun, worn = lancersInMelee(200).inf.stun;
  assert.ok(worn > 1.8 * full, `360 lancers stun 200 men ${worn.toFixed(1)} s, 540 men ${full.toFixed(1)} s`);
  const steadyHorse = (sim: any) => (sim.tu.shock.pass = -9); // every charge morale test passes (never thrown back): this is about the impact, not their nerve
  const wornCharge = lancersInMelee(200, true, steadyHorse).inf.stun; // the size factor is at its cap either way, so only the Charge special differs
  assert.ok(Math.abs(wornCharge / worn - 1.5) < 0.05, `the Charge special stuns ${wornCharge.toFixed(1)} s against ${worn.toFixed(1)} s`);
  const charge = lancersInMelee(540, true, (sim) => { steadyHorse(sim); sim.tu.falter.share = 9; }).inf.stun; // never faltering
  const shot = lancersInMelee(540, true, steadyHorse); // the full line's closing volley takes over 10%
  assert.ok(shot.cav.falter != null && shot.cav.spUntil <= shot.sim.s.t, 'the closing volley took the momentum out of the charge');
  assert.ok(shot.inf.stun < 0.6 * charge, `a faltering charge stuns ${shot.inf.stun.toFixed(1)} s`);
});

// ---------------------------------------------------------------- fire effects: shaken, plough, screen, routers
/** a French battery at the origin facing +z, the given Coalition regiments (steady, standard size); returns hits on `tg` as share-of-men bites */
function battery(place: (co: any[]) => any[], secs: number, tg: () => any, order = true) {
  let gun: any;
  const sim = arena((fr, co) => [gun = Object.assign(fr.find((u) => u.type === 'artillery'), { x: 0, z: 0, facing: 0, morale: 9999, maxMorale: 9999 }), ...place(co).map((u) => Object.assign(u, { facing: Math.PI, morale: 9999, maxMorale: 9999, stance: 'hold' }))]);
  if (order) command(sim, 0, { c: 'attack', ids: [gun.id], target: tg().id });
  const bites: { bite: number; shaken: number }[] = [];
  run(sim, secs, undefined, () => { const t = tg(); if (t.men < (t._m ?? t.maxMen)) bites.push({ bite: ((t._m ?? t.maxMen) - t.men) / (t._m ?? t.maxMen), shaken: t.shaken }); t._m = t.men; });
  return { sim, gun, bites };
}

test('round shot shakes what it hits in proportion to the bite: a square far longer than a line; shaken men cannot reform but can move', () => {
  const first = (form: string) => { let t: any; const b = battery((co) => [t = Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 50, form })], 60, () => t); return { ...b.bites[0], t, sim: b.sim }; };
  const line = first('line'), square = first('square');
  assert.ok(Math.abs(line.shaken - line.bite * 40) < 0.2, `a ${(line.bite * 100).toFixed(1)}% bite shakes a line ${line.shaken.toFixed(1)} s`);
  assert.ok(square.shaken > 1.5 * line.shaken, `a square ${square.shaken.toFixed(1)} s`);
  let t: any;
  const sim = arena((fr, co) => [t = Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 50, form: 'square', shaken: 5, facing: Math.PI }), Object.assign(fr.find((u) => u.type === 'line'), { x: 170, z: -170 })]); // no guns: this half is only about what shaken men may do
  command(sim, 1, { c: 'form', ids: [t.id], f: 'line' });
  assert.equal(t.form, 'square', 'no reforming while shaken');
  command(sim, 1, { c: 'move', ids: [t.id], x: 0, z: 90 }); const z0 = t.z; run(sim, 8); // a square wheels round first
  assert.ok(t.z > z0 + 0.5, 'but it can still march out of the fire');
});

test('round shot ploughs on into the regiment standing behind its target', () => {
  const behind = (x: number) => { let a: any, b: any; battery((co) => { const [l1, l2] = co.filter((u) => u.type === 'line'); return [a = Object.assign(l1, { x: 0, z: 50 }), b = Object.assign(l2, { x, z: 62 })]; }, 40, () => a); return { a, b }; };
  const inLine = behind(0), aside = behind(60);
  assert.ok(inLine.a.men < inLine.a.maxMen && inLine.b.men < inLine.b.maxMen, `the second line behind lost ${Math.round(inLine.b.maxMen - inLine.b.men)} men`);
  assert.equal(aside.b.men, aside.b.maxMen, 'a regiment off the line of fire is untouched');
});

test('a skirmish screen soaks up fire at the line behind it; skirmishers pick off gun crews', () => {
  const avgBite = (screen: boolean) => { let t: any; const { bites } = battery((co) => [t = Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 60 }), Object.assign(co.find((u) => u.type === 'skirmisher'), screen ? { x: 0, z: 38 } : { x: 170, z: 170 })], 120, () => t); return bites.reduce((a, b) => a + b.bite, 0) / bites.length; };
  const open = avgBite(false), screened = avgBite(true);
  assert.ok(screened < 0.85 * open, `average bite ${(screened * 100).toFixed(1)}% behind the screen, ${(open * 100).toFixed(1)}% in the open`);
  const crewLoss = (guns: number) => { let gun: any; const sim = arena((fr, co) => [Object.assign(co.find((u) => u.type === 'skirmisher'), { x: 0, z: 0, facing: 0, morale: 9999, maxMorale: 9999 }), gun = Object.assign(fr.find((u) => u.type === 'artillery'), { x: 0, z: 20, facing: Math.PI, morale: 9999, maxMorale: 9999, limbered: true })]); sim.tu.screen.guns = guns; run(sim, 20); return gun.maxMen - gun.men; };
  const sharp = crewLoss(2), plain = crewLoss(1);
  assert.ok(sharp > 1.6 * plain, `skirmishers took ${Math.round(sharp)} gunners, ${Math.round(plain)} without the bonus`);
});

test('broken men running through a formed regiment shake it', () => {
  let line: any, router: any;
  const sim = arena((fr, co) => { const [l1, l2] = co.filter((u) => u.type === 'line'); return [line = Object.assign(l1, { x: 0, z: 0, facing: 0 }), router = Object.assign(l2, { x: 0, z: 0, routed: true, morale: 0 }), Object.assign(fr[0], { x: 170, z: 170 })]; });
  step(sim, 0.05);
  assert.ok(line.shaken > 2.5, `shaken for ${line.shaken.toFixed(1)} s by ${Math.round(router.men)} fugitives`);
});

// ---------------------------------------------------------------- WS4b deployment & tutorial
test('deployment: a placed regiment stands on its spot at once, facing the enemy, but only inside its zone; the clock waits for the start', () => {
  const sim = createSim(data('quatrebras'), data('tuning'), { seed: 2, deploy: true }), s = sim.s;
  const [a, b] = s.units.filter((u: any) => u.side === 0 && u.type === 'line'), z = s.deploy[0][0], co = s.units.filter((u: any) => u.side === 1);
  command(sim, 0, { c: 'place', ids: [a.id], x: z.x + 10, z: z.z });
  assert.ok(Math.hypot(a.x - z.x - 10, a.z - z.z) < 0.01 && a.tx == null, `placed at once (${a.x.toFixed(1)}, ${a.z.toFixed(1)}), no march left over`);
  const cx = co.reduce((t: number, u: any) => t + u.x, 0) / co.length, cz = co.reduce((t: number, u: any) => t + u.z, 0) / co.length;
  assert.ok(Math.abs(a.facing - Math.atan2(cx - a.x, cz - a.z)) < 0.01, 'facing the enemy army');
  command(sim, 0, { c: 'place', ids: [a.id], x: z.x + 10, z: z.z, f: Math.atan2(cx - a.x, cz - a.z) + Math.PI, w: 30 });
  assert.ok(Math.cos(a.facing - Math.atan2(cx - a.x, cz - a.z)) > 0.99, 'a line dragged facing away still fronts the enemy');
  const far = co[0], bx = b.x;
  assert.ok(!s.deploy[0].some((d: any) => Math.hypot(far.x - d.x, far.z - d.z) < d.r), 'the test spot lies outside the French zone');
  command(sim, 0, { c: 'place', ids: [b.id], x: far.x, z: far.z });
  const edge = s.deploy[0].reduce((m: number, d: any) => Math.min(m, Math.hypot(b.x - d.x, b.z - d.z) - d.r), 1e9);
  assert.ok(b.x !== bx && edge <= 0 && b.tx == null, `a spot outside the zone: pulled in to its edge (${edge.toFixed(2)} inside), with no order`);
  for (let i = 0; i < 20; i++) step(sim, 0.05);
  assert.equal(s.t, 0, 'time stands still while deploying');
  command(sim, 0, { c: 'start' });
  step(sim, 0.05);
  assert.ok(s.phase === 'battle' && s.t > 0, 'the start sets the clock going');
  const ax = a.x;
  command(sim, 0, { c: 'place', ids: [a.id], x: z.x - 10, z: z.z });
  assert.ok(a.x === ax && a.tx == null, 'no placing once the battle is on');
  const plain = createSim(data('quatrebras'), data('tuning'), { seed: 2 }), u = plain.s.units[0], ux = u.x;
  command(plain, 0, { c: 'place', ids: [u.id], x: ux + 5, z: u.z }); command(plain, 0, { c: 'start' });
  assert.ok(u.x === ux && plain.s.phase === undefined, 'a battle without deployment refuses both');
});

test('a replay reproduces the deployment exactly', () => {
  const scn = data('quatrebras'), tu = data('tuning');
  const rec: Replay = { scn, side: 0, start: JSON.stringify(createSim(scn, tu, { seed: 5, deploy: true }).s), cmds: [] };
  const live = runner(tu, rec), s = live.sim.s, ids = s.units.filter((u: any) => u.side === 0 && u.type === 'line').map((u: any) => u.id), z = s.deploy[0][1];
  live.cmd({ c: 'place', ids, x: z.x, z: z.z, f: 0.3, w: 60 });
  live.tick(); live.tick(); // ticks while deploying (the battle UI pauses instead, but a replay must not depend on it)
  live.cmd({ c: 'place', ids: ids.slice(0, 1), x: z.x + 8, z: z.z + 8 });
  live.cmd({ c: 'start' });
  for (let n = 0; n < 1200; n++) live.tick();
  const again = runner(tu, rec, true);
  for (let n = 0; n < 1202; n++) again.tick();
  assert.equal(rec.cmds.length, 3);
  assert.ok(live.sim.s.t > 59, 'the battle ran after the start'); // live.sim.s, not s: the runner carries on from a fresh copy at each keyframe
  assert.equal(JSON.stringify(again.sim.s), JSON.stringify(live.sim.s));
});

// ---------------------------------------------------------------- WS4a campaign & music
import { freshRoster, fieldRoster, grouchyDue } from '../src/sim/roster.ts';
import { expandForces } from '../src/sim/sim.ts';

test("Grouchy's orders change who fights at Waterloo and when the Prussians, or Gérard, arrive", () => {
  const camp = data('campaign'), tu = data('tuning'), wl = data('waterloo');
  const at = (grouchy?: string) => {
    const c: CampaignState = { idx: 4, results: {}, roster: freshRoster(camp, tu), ended: null, grouchy };
    const sim = createSim(wl, tu, { roster: fieldRoster(c, camp, 'waterloo'), won: { ligny: true }, grouchy, seed: 1 });
    const wave = (side: number, name: string) => sim.tl.find((e) => e.type === 'reinforce' && e.side === side && e.units.some((u: any) => (u.names ?? [u.name]).join().includes(name)));
    return { french: sim.s.units.filter((u: any) => u.side === 0).length, bulow: wave(1, 'Bülow').t, prussians: expandForces(wave(1, 'Bülow').units).length, zieten: wave(1, 'Zieten').t, gerard: wave(0, 'Gérard')?.t };
  };
  assert.deepEqual(at(), { french: 28, bulow: 1000, prussians: 8, zieten: 1170, gerard: undefined }, 'no orders (quick battle, old save): as before');
  assert.deepEqual(at('pursue'), { french: 25, bulow: 1120, prussians: 6, zieten: 1350, gerard: undefined }, 'pursue: 2 line + 1 lancer away; Prussians 40/60 min later, without Tippelskirch and the uhlans');
  assert.deepEqual(at('screen'), { french: 27, bulow: 1060, prussians: 8, zieten: 1260, gerard: undefined }, 'screen: 1 lancer away (the spare line absorbs Pécheux); Prussians 20/30 min later');
  assert.deepEqual(at('march'), { french: 28, bulow: 1000, prussians: 8, zieten: 1170, gerard: 1260 }, 'march: everyone fights, Prussians on time, Gérard at six');
  const c: CampaignState = { idx: 3, results: {}, roster: freshRoster(camp, tu), ended: null, grouchy: 'pursue' };
  assert.equal(fieldRoster(c, camp, 'genappe'), c.roster, 'the detachment only misses Waterloo');
  const rec: Replay = { scn: wl, grouchy: 'march', side: 0, start: JSON.stringify(createSim(wl, tu, { grouchy: 'march' }).s), cmds: [] };
  assert.ok(runner(tu, rec).sim.tl.some((e) => e.ifGrouchy === 'march'), 'a replay rebuilds the timeline under the same orders');
});

test('Grouchy: a save from before the choice still loads, fights Waterloo as before, and is asked once, after Ligny', () => {
  const camp = data('campaign'), tu = data('tuning');
  const old: CampaignState = JSON.parse(JSON.stringify({ idx: 4, results: { charleroi: 'win', quatrebras: 'draw', ligny: 'win', genappe: 'win' }, roster: freshRoster(camp, tu), ended: null }));
  assert.equal(fieldRoster(old, camp, 'waterloo').length, old.roster.length, 'nobody is away');
  assert.ok(grouchyDue(old, camp), 'the campaign screen asks');
  assert.ok(!grouchyDue({ ...old, idx: 2 }, camp), 'not before Ligny is fought');
  assert.ok(!grouchyDue({ ...old, grouchy: 'march' }, camp), 'only once');
  assert.ok(!grouchyDue({ ...old, ended: 'waterloo_win' }, camp), 'not after the campaign');
});

// ---------------------------------------------------------------- WS3 combat & AI
/** men a steady Coalition line loses to the first volley of a French line `gap` off (front rank to front rank) within 20 s, or 0 */
function firstVolley(gap: number, stance = 'hold', setup = (_sim: any) => {}) {
  let a: any, e: any;
  const sim = arena((fr, co) => [a = Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: -gap / 2 - 0.91, facing: 0, form: 'line', reload: 0 }), e = Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: gap / 2 + 0.91, facing: Math.PI, form: 'line', morale: 9999, maxMorale: 9999, reload: 1e9 })]);
  setup(sim);
  command(sim, 0, { c: 'stance', ids: [a.id], s: stance });
  let lost = 0;
  run(sim, 20, () => lost > 0, () => { lost = e.maxMen - e.men; });
  return lost;
}

test('hold fire: no volley until the foe is close, then a heavier first volley', () => {
  assert.equal(firstVolley(10, 'holdfire'), 0, 'holding fire, a line 10 off draws no volley');
  assert.ok(firstVolley(10) > 0, 'without the order it fires at 10');
  const r = firstVolley(4, 'holdfire') / firstVolley(4);
  assert.ok(Math.abs(r - data('tuning').holdFire.first) < 0.01, `the first volley after holding fire does ${r.toFixed(2)}x`);
});

test('night falls by the scenario clock: sight closes in and fire weakens', () => {
  const night = (sim: any) => (sim.scn = { ...sim.scn, clock: { start: '23:00', hours: 1 } });
  const spotted = (dark: boolean) => {
    const sim = arena((fr, co) => [Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: 0 }), Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 60 })]);
    sim.s.fog = true; if (dark) night(sim);
    step(sim, 0.05);
    return sim.s.seen[0].length;
  };
  assert.equal(spotted(false), 1, 'by day a line 60 off is seen');
  assert.equal(spotted(true), 0, 'at night it is not');
  const r = firstVolley(10, 'hold', night) / firstVolley(10);
  assert.ok(Math.abs(r - (1 - data('tuning').night.fire)) < 0.01, `a volley in the dark does ${r.toFixed(2)}x`);
});

test('a defending bot line holds its fire as a column comes on', () => {
  let line: any;
  const sim = arena((fr, co) => { const col = Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: -45, facing: 0, form: 'column' }); line = Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 0, facing: Math.PI, form: 'line' }); return [col, line]; });
  const col = sim.s.units[0]; col.tx = 0; col.tz = -2; // (arena clears orders as it places units)
  const bot = makeBot(sim, 1);
  let held = false;
  run(sim, 15, () => held, () => { bot(0.05); held = line.stance === 'holdfire'; });
  assert.ok(held, 'the line was ordered to hold its fire');
});

test('bot cavalry rides at a shaken line (it cannot form square) before a nearer steady one', () => {
  let cav: any, shaken: any;
  const sim = arena((fr, co) => { const [l1, l2] = co.filter((u) => u.type === 'line'); return [cav = Object.assign(fr.find((u) => u.type === 'lancer'), { x: 0, z: 0 }), Object.assign(l1, { x: -30, z: 30, morale: 60 }), shaken = Object.assign(l2, { x: 40, z: 45, morale: 60, shaken: 30 })]; });
  const bot = makeBot(sim, 0);
  run(sim, 5, () => cav.chase != null, () => bot(0.05));
  assert.equal(cav.chase, shaken.id);
});

test('bot cavalry sounds the Charge ~25-35 out from its target', () => {
  let cav: any, gun: any, d = -1;
  const sim = arena((fr, co) => [cav = Object.assign(fr.find((u) => u.type === 'lancer'), { x: 0, z: 90 }), gun = Object.assign(co.find((u) => u.type === 'artillery'), { x: 0, z: 0, reload: 1e9 })]);
  sim.s.t = 30; // the bot keeps its specials for after the opening 20 s
  const bot = makeBot(sim, 0);
  run(sim, 30, () => d >= 0, () => { bot(0.05); if (cav.spKind === 'charge' && cav.spUntil > sim.s.t) d = Math.hypot(cav.x - gun.x, cav.z - gun.z); });
  assert.ok(d > 20 && d < 36, `charged from ${d.toFixed(1)}`);
});

test('attacking, the bot keeps one regiment of horse back to counter-charge enemy horse in among its foot', () => {
  let a: any, b: any, line: any, foe: any, gun: any;
  const sim = arena((fr, co) => [a = Object.assign(fr.find((u) => u.type === 'lancer'), { x: 0, z: 40 }), b = Object.assign(fr.find((u) => u.type === 'cuirassier'), { x: 15, z: 40 }), line = Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: 0, facing: Math.PI, morale: 9999, maxMorale: 9999 }), foe = Object.assign(co.find((u) => u.type === 'skirmisher'), { type: 'lancer', x: 0, z: -40 }), gun = Object.assign(co.find((u) => u.type === 'artillery'), { x: 40, z: -30, reload: 1e9 })]); // (the Coalition has no horse here: its skirmishers stand in)
  command(sim, 1, { c: 'attack', ids: [foe.id], target: line.id });
  run(sim, 20, () => foe.eng === line.id);
  assert.equal(foe.eng, line.id, 'the enemy horse is in among our foot');
  const bot = makeBot(sim, 0);
  run(sim, 3, () => a.chase != null && b.chase != null, () => bot(0.05));
  assert.ok(a.chase === foe.id && b.chase === gun.id, `the reserve counter-charges (${a.chase}), the other rides at the guns (${b.chase})`);
});

test('bot guns lay on a column rather than a nearer line', () => {
  let line: any, col: any;
  const sim = arena((fr, co) => { const [l1, l2] = fr.filter((u) => u.type === 'line'); return [line = Object.assign(l1, { x: -20, z: -50, form: 'line', morale: 9999, maxMorale: 9999 }), col = Object.assign(l2, { x: 25, z: -65, form: 'column', morale: 9999, maxMorale: 9999 }), Object.assign(co.find((u) => u.type === 'artillery'), { x: 0, z: 0, facing: Math.PI, morale: 9999, maxMorale: 9999, reload: 2 })]; }); // loaded after the bot's first look
  const bot = makeBot(sim, 1), at = { line: 0, col: 0 };
  run(sim, 40, () => col.dead, () => { bot(0.05); for (const e of sim.s.events) if (e.k === 'shot' && e.side === 1) at[e.tx === col.x ? 'col' : 'line']++; sim.s.events.length = 0; }); // until round shot destroys the column
  assert.ok(at.col >= 2 && at.line === 0, `rounds at the column ${at.col}, at ${line.name} ${at.line}`);
});

test('a defending bot line steps back off the forward slope to a spot in its zone the enemy guns cannot see', () => {
  let line: any, gun: any;
  const sim = arena((fr, co) => [gun = Object.assign(fr.find((u) => u.type === 'artillery'), { x: 0, z: -70, reload: 1e9 }), line = Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 0, facing: Math.PI, form: 'line' })], { size: 400, rough: FLAT, hills: [{ x: 0, z: 5, rx: 400, rz: 5, h: 5, p: 2 }] }); // a ridge across the zone, crest at z 5
  sim.s.zones = [{ id: 'z', name: 'Z', x: 0, z: 0, r: 30, value: 1, owner: 1, p: -1 }];
  assert.ok(los(sim.scn, gun.x, gun.z, 2, line.x, line.z, 2), 'the guns see the line at first');
  const bot = makeBot(sim, 1);
  run(sim, 40, undefined, () => bot(0.05));
  assert.ok(!los(sim.scn, gun.x, gun.z, 2, line.x, line.z, 2) && Math.hypot(line.x, line.z) < 30, `behind the crest, in the zone (${line.x.toFixed(1)}, ${line.z.toFixed(1)})`);
});

// ---------------------------------------------------------------- WS5 UI/UX
const { unitStatus, hudScale } = await import('../src/render.ts');

test('status marks: a rout says only that; otherwise every mark that applies, most urgent first', () => {
  const tu = data('tuning'), u = (o: any) => ({ type: 'line', morale: 100, maxMorale: 100, fat: 0, stun: 0, shaken: 0, bay: null, spUntil: 0, still: 0, ...o });
  assert.deepEqual(unitStatus(u({ routed: true, stun: 3, fat: 0.9 }), 0, tu), ['routed']);
  assert.deepEqual(unitStatus(u({ stun: 2, shaken: 1, morale: 20, fat: 0.6, still: tu.hold.after }), 0, tu), ['stun', 'shaken', 'waver', 'tired', 'posted']);
  assert.deepEqual(unitStatus(u({ bay: 7 }), 0, tu), ['charge']);
  assert.deepEqual(unitStatus(u({ type: 'lancer', chase: 3, still: 99 }), 0, tu), ['charge'], 'charging horse, and cavalry is never posted');
  assert.deepEqual(unitStatus(u({ spUntil: 5, spKind: 'charge' }), 6, tu), [], 'the Charge has worn off');
});

test('interface size steps the HUD scale up only while the 640x360 layout still fits', () => {
  assert.deepEqual([0, 1, 2].map((ui) => hudScale(1, 1280, 720, ui)), [2, 2, 2], '1280x720: no room to grow');
  assert.deepEqual([0, 1, 2].map((ui) => hudScale(2, 1920, 1080, ui)), [2, 3, 3]);
  assert.deepEqual([0, 1, 2].map((ui) => hudScale(1, 1920, 1080, ui)), [2, 3, 3], 'from the auto scale, not the world pixel');
  assert.deepEqual([0, 1, 2].map((ui) => hudScale(4, 3840, 2160, ui)), [4, 5, 6]);
  assert.equal(hudScale(1, 1920, 700, 2), 2, 'wide enough but too short for a bigger layout');
});

// ---------------------------------------------------------------- WS2 orders & movement
import { layout } from '../src/sim/sim.ts';

test('march in column: a line sent far forms column and deploys on arrival, or early once a foe is within musket range', () => {
  const go = (foe: boolean, col = true) => {
    let a: any;
    const sim = arena((fr, co) => [a = Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: -120, facing: 0, form: 'line', morale: 9999, maxMorale: 9999 }), Object.assign(co.find((u) => u.type === 'line'), foe ? { x: 0, z: 0, facing: Math.PI, form: 'line', stance: 'hold', morale: 9999, maxMorale: 9999, reload: 1e9 } : { x: 170, z: 170 })]);
    command(sim, 0, { c: 'move', ids: [a.id], x: 0, z: -20, col });
    const forms: string[] = [];
    let at: any = null; // where it was when it formed line again, and whether it was still marching
    run(sim, 90, undefined, () => { if (forms.at(-1) !== a.form) { forms.push(a.form); if (a.form === 'line' && forms.length > 1) at = { z: a.z, marching: a.tx != null }; } });
    return { forms, at, a };
  };
  const open = go(false), near = go(true), off = go(false, false);
  assert.deepEqual(open.forms, ['column', 'line'], 'formed column for the march, line again at the end');
  assert.ok(!open.at.marching && Math.abs(open.a.z + 20) < 1, `deployed on arrival (z ${open.at.z.toFixed(1)})`);
  assert.ok(near.at?.marching && near.at.z < -24, `deployed early with the foe in musket range (z ${near.at?.z.toFixed(1)})`);
  assert.deepEqual(off.forms, ['line'], 'with the setting off it marches in line');
});

test('a group order marches at its slowest member\'s pace until it arrives', () => {
  const march2 = (both: boolean) => {
    let col: any, gun: any;
    const sim = arena((fr, co) => [col = Object.assign(fr.find((u) => u.type === 'line'), { x: -20, z: -80, facing: 0, form: 'column' }), gun = Object.assign(fr.find((u) => u.type === 'artillery'), { x: 20, z: -80, facing: 0 }), Object.assign(co[0], { x: 170, z: 170 })]);
    command(sim, 0, { c: 'move', ids: both ? [col.id, gun.id] : [col.id], x: 0, z: 40 });
    const d0 = Math.hypot(col.tx - col.x, col.tz - col.z);
    run(sim, 10);
    return { sim, col, covered: d0 - Math.hypot(col.tx - col.x, col.tz - col.z) };
  };
  const alone = march2(false), group = march2(true);
  assert.ok(alone.covered > 25 && group.covered < 16.5, `the column alone covered ${alone.covered.toFixed(1)} in 10 s, with the guns ${group.covered.toFixed(1)}`);
  run(group.sim, 120);
  assert.equal(group.col.pace, null, 'the pace ends on arrival');
});

test('keep the shape: a block move keeps each regiment\'s offset and facing; a dragged facing turns the whole block', () => {
  let a: any, b: any;
  const sim = arena((fr, co) => { [a, b] = fr.filter((u) => u.type === 'line'); return [Object.assign(a, { x: -30, z: 0, facing: 0 }), Object.assign(b, { x: 30, z: 10, facing: 0.5 }), Object.assign(co[0], { x: 170, z: 170 })]; });
  command(sim, 0, { c: 'move', ids: [a.id, b.id], x: 0, z: 100, keep: true });
  run(sim, 120);
  assert.ok(Math.hypot(a.x + 30, a.z - 95) < 1.5 && Math.hypot(b.x - 30, b.z - 105) < 1.5, `kept their offsets (${a.x.toFixed(1)}, ${a.z.toFixed(1)}) (${b.x.toFixed(1)}, ${b.z.toFixed(1)})`);
  assert.ok(Math.abs(a.facing) < 1e-6 && Math.abs(b.facing - 0.5) < 1e-6, `kept their facings (${a.facing.toFixed(2)}, ${b.facing.toFixed(2)})`);
  const p = layout([{ x: -30, z: 0, facing: 0 }, { x: 30, z: 0, facing: 0 }], { x: 0, z: 0, f: Math.PI / 2, keep: true }, sim.tu, 200);
  assert.ok(Math.hypot(p[0].x, p[0].z - 30) < 1e-9 && Math.hypot(p[1].x, p[1].z + 30) < 1e-9 && p.every((q) => Math.abs(q.f! - Math.PI / 2) < 1e-9), 'turned a quarter round as a block');
});

test('with the enemy close, a regiment ordered a short way to its rear falls back facing it at half pace; a longer way, or with no enemy near, it wheels round', () => {
  const back = (dist: number, foeZ: number) => { let a: any; const sim = arena((fr, co) => [a = Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: 0, facing: 0, form: 'line' }), Object.assign(co[0], { x: 170, z: 170 })]); Object.assign(sim.s.units.find((u: any) => u.side === 1), { x: 0, z: foeZ }); command(sim, 0, { c: 'move', ids: [a.id], x: 0, z: -dist }); run(sim, 6); return a; };
  const near = back(15, 30), far = back(60, 30), alone = back(15, 170);
  assert.ok(near.facing === 0 && near.z < -3 && near.z > -6.5, `stepped back ${(-near.z).toFixed(1)} still facing the front`);
  assert.ok(Math.abs(far.facing) > 1 && Math.abs(far.z) < 0.5, `a long way: wheeling round first (facing ${far.facing.toFixed(2)}, z ${far.z.toFixed(1)})`);
  assert.ok(Math.abs(alone.facing) > 1 && Math.abs(alone.z) < 0.5, `no enemy near: wheeling round first (facing ${alone.facing.toFixed(2)}, z ${alone.z.toFixed(1)})`);
});

test('a face order halts a regiment and wheels it toward the point without moving', () => {
  let a: any;
  const sim = arena((fr, co) => [a = Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: 0, facing: 0, form: 'line' }), Object.assign(co[0], { x: 170, z: 170 })]);
  command(sim, 0, { c: 'move', ids: [a.id], x: 0, z: 80 }); run(sim, 1);
  const x = a.x, z = a.z;
  command(sim, 0, { c: 'face', ids: [a.id], x: 40, z: a.z });
  run(sim, 10);
  assert.ok(Math.abs(a.facing - Math.PI / 2) < 1e-6 && Math.hypot(a.x - x, a.z - z) < 1e-6 && a.tx == null, `faces +x (${a.facing.toFixed(2)}) where it stood`);
});

test('double time marches 1.4x as fast, tires at the run rate, and ends on arrival', () => {
  const go = (r: boolean) => { let a: any; const sim = arena((fr, co) => [a = Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: -100, facing: 0, form: 'column' }), Object.assign(co[0], { x: 170, z: 170 })]); command(sim, 0, { c: 'move', ids: [a.id], x: 0, z: 100, run: r }); run(sim, 10); return { sim, a }; };
  const walk = go(false), dbl = go(true), k = (dbl.a.z + 100) / (walk.a.z + 100);
  assert.ok(k > 1.3 && k < 1.42 && dbl.a.fat > 5 * walk.a.fat, `covered ${k.toFixed(2)}x, fatigue ${dbl.a.fat.toFixed(3)} vs ${walk.a.fat.toFixed(3)}`);
  run(dbl.sim, 120);
  assert.equal(dbl.a.run, false, 'double time ends on arrival');
});

test('courier orders: a distant regiment gets its order (its place in the group kept) after the ride; near ones at once; aids are not delayed', () => {
  let g: any, a: any, b: any;
  const sim = arena((fr, co) => { [a, b] = fr.filter((u) => u.type === 'line'); return [g = Object.assign(fr.find((u) => u.type === 'commander'), { x: 0, z: 0 }), Object.assign(a, { x: 20, z: 0, facing: 0 }), Object.assign(b, { x: 140, z: 0, facing: 0 }), Object.assign(co[0], { x: 170, z: 170 })]; });
  sim.s.courier = true;
  const c: any = { c: 'move', ids: [a.id, b.id], x: 80, z: 60 }, want = layout([a, b], c, sim.tu, sim.scn.map.size / 2 - 2).find((p) => p.u === b)!;
  command(sim, 0, c);
  assert.ok(a.tx != null && b.tx == null && sim.s.orders.length === 1, 'the near regiment marches at once, the far one waits for the courier');
  run(sim, (140 - 40) / sim.tu.courier.speed - 0.5);
  assert.equal(b.tx, null, 'still waiting just before the courier arrives');
  run(sim, 1);
  assert.ok(Math.abs(b.tx - want.x) < 1e-9 && Math.abs(b.tz - want.z) < 1e-9, `the order arrived with b's place in the group (${b.tx.toFixed(1)}, ${b.tz.toFixed(1)})`);
  command(sim, 0, { c: 'move', ids: [b.id], x: 0, z: 100 }); command(sim, 0, { c: 'attack', ids: [b.id], target: sim.s.units.find((u: any) => u.side === 1).id });
  assert.ok(sim.s.orders.length === 1 && sim.s.orders[0].c.c === 'attack', 'a new order countermands the one still on the road');
  g.dead = true; sim.s.units = sim.s.units.filter((u: any) => !u.dead); // the general has fallen: orders ride from the entry point
  const e = sim.scn.entry[0], t = (Math.hypot(a.x - e.x, a.z - e.z) - 40) / sim.tu.courier.speed;
  command(sim, 0, { c: 'stop', ids: [a.id] });
  const o = sim.s.orders.find((q: any) => q.c.ids[0] === a.id);
  assert.ok(t > 0 && Math.abs(o.t - sim.s.t - t) < 1e-9, `from the entry point it takes ${t.toFixed(1)} s`);
});

// ---------------------------------------------------------------- integration (the workstreams together)
test('with courier orders on, deployment still places regiments at once (the clock is stopped, so a rider would never arrive)', () => {
  const sim = createSim(data('quatrebras'), data('tuning'), { seed: 2, deploy: true, courier: true }), s = sim.s;
  const a = s.units.find((u: any) => u.side === 0 && u.type === 'line'), z = s.deploy[0][0];
  command(sim, 0, { c: 'place', ids: [a.id], x: z.x + 10, z: z.z });
  assert.ok(Math.hypot(a.x - z.x - 10, a.z - z.z) < 0.01 && !s.orders.length, `placed at once (${a.x.toFixed(1)}, ${a.z.toFixed(1)}), nothing on the road`);
  command(sim, 0, { c: 'start' });
  command(sim, 0, { c: 'move', ids: [a.id], x: a.x + 200, z: a.z });
  assert.ok(s.orders.length === 1, 'once the battle is on, distant orders ride by courier again');
});

// ---------------------------------------------------------------- WS1 pathfinding
/** one French regiment of `type` marches from `a` to `b` over `map`: the track it took and how long it was on the way */
function trek(type: string, form: string, a: number[], b: number[], map: any, secs = 150) {
  let u: any;
  const sim = arena((fr, co) => [u = Object.assign(fr.find((q) => q.type === type), { x: a[0], z: a[1], facing: Math.atan2(b[0] - a[0], b[1] - a[1]), form }), Object.assign(co[0], { x: 170, z: 170 })], map);
  command(sim, 0, { c: 'move', ids: [u.id], x: b[0], z: b[1] });
  const track: number[][] = [];
  run(sim, secs, () => u.tx == null, () => track.push([u.x, u.z]));
  return { track, t: track.length * 0.05, there: Math.hypot(u.x - b[0], u.z - b[1]) < 2, near: (x: number, z: number) => Math.min(...track.map((p) => Math.hypot(p[0] - x, p[1] - z))) };
}

test('a march over two deep rivers finds a bridge on each, taking the nearer of two', () => {
  const r = trek('line', 'column', [0, -30], [0, 70], { size: 400, rough: FLAT, rivers: [{ pts: [[-200, 0], [200, 0]], width: 8, bridges: [[40, 0], [-150, 0]] }, { pts: [[-200, 40], [200, 40]], width: 8, bridges: [[-40, 40]] }] });
  assert.ok(r.there, 'arrived');
  assert.ok(r.near(40, 0) < 6 && r.near(-40, 40) < 6, `crossed by the near bridge (${r.near(40, 0).toFixed(1)} off) and the second river's (${r.near(-40, 40).toFixed(1)} off)`);
});

test('horse and guns go round a dense wood; skirmishers, slowed less, go straight through', () => {
  const map = { size: 400, rough: FLAT, woods: [{ x: 0, z: 0, r: 25, dense: true }] }, wide = (r: any) => Math.max(...r.track.map((p: number[]) => Math.abs(p[1])));
  const cav = trek('lancer', 'line', [-70, 0], [70, 0], map), guns = trek('artillery', 'line', [-70, 0], [70, 0], map), skir = trek('skirmisher', 'line', [-70, 0], [70, 0], map);
  assert.ok(cav.there && guns.there && skir.there, 'all arrived');
  assert.ok(wide(cav) > 20 && wide(guns) > 20, `horse strayed ${wide(cav).toFixed(1)}, guns ${wide(guns).toFixed(1)} round the wood`);
  assert.ok(wide(skir) < 3, `skirmishers kept straight (${wide(skir).toFixed(1)})`);
});

test('a column takes the road when that is quicker overall; a line, which the road does not speed, marches straight', () => {
  const road = { size: 400, rough: FLAT, roads: [{ pts: [[-200, 0], [200, 0]], w: 4 }] };
  const col = trek('line', 'column', [-100, 14], [100, 14], road), off = trek('line', 'column', [-100, 14], [100, 14], { size: 400, rough: FLAT }), line = trek('line', 'line', [-100, 14], [100, 14], road);
  assert.ok(col.there && line.there, 'arrived');
  const onRoad = col.track.filter((p) => Math.abs(p[1]) < 4 * 0.7).length / col.track.length; // featureAt's road band
  assert.ok(onRoad > 0.6, `the column marched ${Math.round(onRoad * 100)}% of the way on the road`);
  assert.ok(col.t < off.t * 0.95, `and got there sooner: ${col.t.toFixed(0)} s vs ${off.t.toFixed(0)} s across the fields`);
  assert.ok(Math.max(...line.track.map((p) => Math.abs(p[1] - 14))) < 2, 'the line kept straight');
});

test('routing every regiment across the biggest maps stays within a few ms', () => {
  const tu = data('tuning'), tt = tu.terrain, sp = (f: any) => (f.wood ? tt.wood.infantry : 1) * (f.village ? tt.village.infantry : 1) * (f.river ? f.river.ford ?? tt.river : 1) * (f.road ? tt.road : 1); // a column: the road-loving class searches widest
  for (const id of ['ligny', 'waterloo']) {
    const sim = createSim(data(id), tu, { seed: 1 }), all = () => sim.s.units.map((u: any) => route(sim.scn, tu, 'linecolumn', sp, u.x, u.z, -u.x * 0.9, -u.z * 0.9));
    all(); // bake the grid and warm up
    const t0 = performance.now(), n = all().filter(Boolean).length, ms = performance.now() - t0;
    assert.ok(ms < 40, `${id}: ${sim.s.units.length} cross-map routes (${n} off the straight line) in ${ms.toFixed(1)} ms`);
  }
});

// ---------------------------------------------------------------- WS6 replays & worker
test('a battle continued from a snapshot plays on exactly, bot memory included', () => {
  const scn = data('quatrebras'), tu = data('tuning');
  const go = (sim: any, bots: any[], n: number) => { for (let i = 0; i < n; i++) { step(sim, 0.05); bots[0](0.05); bots[1](0.05); } };
  const a = createSim(scn, tu, { seed: 3 }), ba = [makeBot(a, 0), makeBot(a, 1)];
  go(a, ba, 1210); // not on a 2 s bot beat
  const b = createSim(scn, tu);
  b.s = JSON.parse(JSON.stringify(a.s));
  go(a, ba, 2400); go(b, [makeBot(b, 0), makeBot(b, 1)], 2400);
  assert.equal(JSON.stringify(b.s), JSON.stringify(a.s));
});

/** a recorded quatrebras battle with two orders, `steps` long */
function recorded(steps: number, seed = 5) {
  const scn = { ...data('quatrebras'), strength: [1, 0.8] }, tu = data('tuning');
  const rec: Replay = { scn, v: SIM_VERSION, ref: { id: 'quatrebras', strength: [1, 0.8], skill: 1 }, side: 0, start: JSON.stringify(createSim(scn, tu, { seed }).s), cmds: [] };
  const live = runner(tu, rec), ids = live.sim.s.units.filter((u: any) => u.side === 0).map((u: any) => u.id);
  for (let n = 0; n < steps; n++) { if (n === 100) live.cmd({ c: 'move', ids, x: 0, z: 0 }); if (n === 1500) live.cmd({ c: 'form', ids, f: 'column' }); live.tick(); }
  live.sim.s.events.length = 0;
  return { rec, tu, live };
}

test('a replay seeks from its keyframes to exactly where playing it through gets', () => {
  const { rec, tu, live } = recorded(3000);
  assert.deepEqual(rec.keys!.map((k) => k[0]), [1200, 2400], 'a keyframe each minute');
  const through = (m: number) => { const p = runner(tu, rec, true); while (p.n < m) p.tick(); p.sim.s.events.length = 0; return JSON.stringify(p.sim.s); };
  const p = runner(tu, rec, true);
  for (const m of [2000, 1300, 2999, 50]) { p.seek(m); assert.equal(JSON.stringify(p.sim.s), through(m), `seek to step ${m}`); }
  p.seek(3000);
  assert.equal(JSON.stringify(p.sim.s), JSON.stringify(live.sim.s), 'the end of the replay is the battle as played');
});

test('a replay file round-trips; a doctored one is turned away', () => {
  const { rec, tu, live } = recorded(1300), scenarios = { quatrebras: data('quatrebras') };
  rec.end = 1300; rec.chron = live.sim.s.chron;
  const f = JSON.parse(replayFile(rec)), back = parseReplay(JSON.stringify({ ...f, scn: { title: 'not ours' } }), scenarios);
  assert.equal(replayFile(back), replayFile(rec));
  assert.deepEqual([back.scn.title, back.scn.strength], [scenarios.quatrebras.title, [1, 0.8]], 'the scenario is ours, at the recorded strength');
  const p = runner(tu, back, true); p.seek(1300);
  assert.equal(JSON.stringify(p.sim.s), JSON.stringify(live.sim.s), 'it plays back the battle');
  assert.equal(parseReplay(JSON.stringify({ ...f, ref: { id: 'skirmish', seed: 42, strength: [1, 1.5] } }), scenarios).scn.date, 'Seed 42', 'a random skirmish is rebuilt from its seed');
  const bad = (why: RegExp, edit: (g: any) => void) => { const g = structuredClone(f); edit(g); assert.throws(() => parseReplay(JSON.stringify(g), scenarios), why); };
  assert.throws(() => parseReplay('{"ref":', scenarios), /not a replay/);
  bad(/another version/, (g) => (g.v = SIM_VERSION + 1));
  bad(/another version/, (g) => delete g.v);
  bad(/unknown battle/, (g) => (g.ref.id = 'waterloo'));
  bad(/unknown battle/, (g) => (g.ref.id = '__proto__'));
  bad(/strength/, (g) => (g.ref.strength = [1, 1e9]));
  bad(/orders/, (g) => (g.cmds[0][1].x = { y: 1 }));
  bad(/orders/, (g) => (g.cmds[0][0] = -1));
  bad(/orders/, (g) => (g.cmds[0][1].ids = Array(101).fill(1)));
  bad(/start state/, (g) => (g.start = JSON.stringify({ ...JSON.parse(g.start), zones: [{ id: 'x', name: '<img src=x onerror=alert(1)>' }] })));
  bad(/keyframes/, (g) => (g.keys[0][1] = g.keys[0][1].replace('{"t":', '{"t":1e999,"t0":')));
});

test("a replay file keeps Grouchy's orders (they shape Waterloo's timeline), and refuses any other value", () => {
  const scn = data('waterloo'), tu = data('tuning'), camp = data('campaign'), ids = camp.grouchy.options.map((o: any) => o.id);
  const rec: Replay = { scn, v: SIM_VERSION, ref: { id: 'waterloo', strength: [1, 1] }, grouchy: 'pursue', side: 0, start: JSON.stringify(createSim(scn, tu, { seed: 3, grouchy: 'pursue' }).s), cmds: [] };
  const live = runner(tu, rec);
  for (let n = 0; n < 40; n++) live.tick();
  Object.assign(rec, { end: 40, chron: [] }); // what a finished battle records
  const f = replayFile(rec), back = parseReplay(f, { waterloo: scn }, ids);
  assert.equal(back.grouchy, 'pursue');
  assert.deepEqual(runner(tu, back, true).sim.tl.map((e: any) => e.t), live.sim.tl.map((e: any) => e.t), 'the same timeline as the battle');
  for (const g of ['constructor', '__proto__', 'nonsense']) assert.throws(() => parseReplay(JSON.stringify({ ...JSON.parse(f), grouchy: g }), { waterloo: scn }, ids), /Grouchy/, g);
});

test('halt leaves a garrison manned; a move order turns the men out', () => {
  const sim = createSim(data('hougoumont'), data('tuning'), { seed: 3 }), vi = (sim.scn.map.villages ?? []).findIndex((v: any) => v.garrison), v = sim.scn.map.villages[vi];
  const u = sim.s.units.find((q: any) => q.side === 0 && q.type === 'line');
  Object.assign(u, { x: v.x, z: v.z, garrison: vi, gTarget: null, tx: null, tz: null });
  command(sim, 0, { c: 'stop', ids: [u.id] });
  assert.equal(u.garrison, vi, 'still in the farm after a halt');
  command(sim, 0, { c: 'move', ids: [u.id], x: v.x + 40, z: v.z });
  assert.equal(u.garrison, null, 'a move order releases it');
});

test('a regiment sent to a spot a friend holds stands on the free ground beside it instead of giving up short', () => {
  let a: any, b: any;
  const sim = arena((fr, co) => { [a, b] = fr.filter((u) => u.type === 'line'); return [Object.assign(a, { x: 0, z: -50, facing: 0, form: 'line' }), Object.assign(b, { x: 0, z: 0, facing: 0, form: 'line' }), Object.assign(co[0], { x: 170, z: 170 })]; });
  command(sim, 0, { c: 'move', ids: [a.id], x: 0, z: 2 });
  run(sim, 90, () => a.tx == null);
  const fa = foot(a, sim.tu), fb = foot(b, sim.tu), clear = Math.abs(a.x - b.x) > (fa[1] - fa[0] + fb[1] - fb[0]) / 2 || a.z + fa[3] < b.z + fb[2] || b.z + fb[3] < a.z + fa[2]; // side by side or end to end, not overlapping
  assert.ok(a.tx == null && Math.hypot(a.x, a.z - 2) > 8 && Math.hypot(a.x, a.z) < 60 && clear, `stood beside the occupied spot (at ${a.x.toFixed(0)}, ${a.z.toFixed(0)})`);
});

test('a dragged front two ranks deep arrives: the rear rank files through to its place', () => {
  let ls: any[] = [];
  const sim = arena((fr, co) => [...(ls = fr.filter((q) => q.type === 'line').slice(0, 4).map((q, i) => Object.assign(q, { x: -50 + i * 25, z: -70, facing: 0, form: 'line' }))), Object.assign(co[0], { x: 170, z: 170 })]);
  command(sim, 0, { c: 'move', ids: ls.map((u) => u.id), x: 0, z: 0, f: 0, w: 60 });
  const goals = ls.map((u) => [u.tx, u.tz]);
  run(sim, 200, () => ls.every((u) => u.tx == null));
  assert.ok(ls.every((u, i) => Math.hypot(u.x - goals[i][0], u.z - goals[i][1]) < 6), `every regiment reached its place (${ls.map((u, i) => Math.hypot(u.x - goals[i][0], u.z - goals[i][1]).toFixed(1))})`);
});

test('two regiments on one foe settle: nobody flips between targets, wheels back and forth or is shoved out of the melee', () => {
  let a: any, b: any, e: any;
  const sim = arena((fr, co) => { [a, b] = fr.filter((u) => u.type === 'line'); e = co.filter((u) => u.type === 'line')[0]; return [Object.assign(a, { x: -14, z: -30, facing: 0, form: 'line' }), Object.assign(b, { x: 14, z: -30, facing: 0, form: 'line' }), Object.assign(e, { x: 0, z: 30, facing: Math.PI, form: 'line', stance: 'aggressive' }), Object.assign(co[co.length - 1], { x: 170, z: 170 })]; });
  for (const u of [a, b, e]) Object.assign(u, { morale: 9999, maxMorale: 9999 });
  command(sim, 0, { c: 'bayonet', ids: [a.id, b.id], target: e.id }); command(sim, 1, { c: 'bayonet', ids: [e.id], target: a.id });
  run(sim, 25); // the approach and the walk round to a free piece of the foe
  let changes = 0, flips = 0, last = e.eng, lastF = e.facing, lastSign = 0, moved = 0;
  const px = [a.x, a.z];
  run(sim, 8, undefined, () => {
    if (e.eng !== last) changes++; last = e.eng;
    const d = Math.atan2(Math.sin(e.facing - lastF), Math.cos(e.facing - lastF)), s = Math.abs(d) > 1e-4 ? Math.sign(d) : 0; if (s && lastSign && s !== lastSign) flips++; if (s) lastSign = s; lastF = e.facing;
  });
  moved = Math.hypot(a.x - px[0], a.z - px[1]);
  assert.ok(changes <= 1 && flips <= 1, `the foe changed opponent ${changes} times and reversed its wheel ${flips} times`);
  assert.ok(moved < 1, `the regiment locked with the foe held its ground (moved ${moved.toFixed(1)})`);
});

// ---------------------------------------------------------------- cavalry formations
const horse = (fr: any[]) => fr.filter((u) => u.type === 'lancer' || u.type === 'cuirassier')[0];
test('horse have their own formations: squadron and wedge; foot formations do not apply to them, nor theirs to foot', () => {
  let h: any, l: any;
  const sim = arena((fr, co) => [h = Object.assign(horse(fr), { x: 0, z: 0, facing: 0 }), l = Object.assign(fr.filter((u) => u.type === 'line')[0], { x: 40, z: 0, facing: 0, form: 'line' }), Object.assign(co[0], { x: 170, z: 170 })]);
  assert.equal(h.form, 'squadron', 'horse start in squadron');
  command(sim, 0, { c: 'form', ids: [h.id, l.id], f: 'square' }); assert.ok(h.form === 'squadron' && l.form === 'square', 'horse cannot form square');
  command(sim, 0, { c: 'form', ids: [h.id, l.id], f: 'wedge' }); assert.ok(h.form === 'wedge' && l.form === 'square' && h.busy > 2, 'the wedge forms up (busy for formChangeTime); foot ignore it');
  h.busy = 0; h.shaken = 3; command(sim, 0, { c: 'form', ids: [h.id], f: 'squadron' }); assert.equal(h.form, 'wedge', 'shaken horse cannot reform');
  const fw = foot(h, sim.tu), fs = foot({ ...h, form: 'squadron' }, sim.tu);
  assert.ok(fw[1] - fw[0] < (fs[1] - fs[0]) * 0.7 && fw[3] - fw[2] > (fs[3] - fs[2]) * 2, 'the wedge is narrower and deeper than the squadron');
});

test('a wedge hits and shocks harder once formed, wheels slowly; still forming, it has no edge', () => {
  const fight = (form: string, busy: number) => {
    let h: any, e: any;
    const sim = arena((fr, co) => [h = Object.assign(horse(fr), { x: 0, z: 0, facing: 0, form, busy, morale: 9999, maxMorale: 9999 }), e = Object.assign(co.filter((u) => u.type === 'line')[0], { x: 0, z: 3, facing: Math.PI, form: 'line', stance: 'hold', morale: 9999, maxMorale: 9999 })]);
    command(sim, 0, { c: 'attack', ids: [h.id], target: e.id });
    run(sim, 6, undefined, () => { h.busy = busy; });
    return { dealt: e.maxMen - e.men, took: h.maxMen - h.men };
  };
  const sq = fight('squadron', 0), wd = fight('wedge', 0), forming = fight('wedge', 3);
  assert.ok(wd.dealt > sq.dealt * 1.15, `wedge dealt ${wd.dealt.toFixed(1)} against the squadron's ${sq.dealt.toFixed(1)}`);
  assert.ok(Math.abs(forming.dealt - sq.dealt) < sq.dealt * 0.1 + 0.5, 'a wedge still forming up has no edge');
  const turn = (form: string) => { let h: any; const sim = arena((fr, co) => [h = Object.assign(horse(fr), { x: 0, z: 0, facing: 0, form }), Object.assign(co[0], { x: 170, z: 170 })]); command(sim, 0, { c: 'move', ids: [h.id], x: 0, z: -80 }); h.busy = 0; run(sim, 2); return Math.abs(h.facing); };
  assert.ok(turn('wedge') < turn('squadron') * 0.8, 'the wedge wheels slower');
});

test('replenishing needs calm: refused in combat or with the enemy near, paused while one comes close, resumed when it leaves', () => {
  let home: any, foe: any;
  const sim = arena((fr, co) => [home = fr.filter((u) => u.type === 'line')[0], foe = co.filter((u) => u.type === 'line')[0]]);
  sim.tu.rpPerObjective = 0; sim.s.side[0].rp = 100;
  const z = Object.assign(sim.s.zones[0], { owner: 0, p: 1 }), dz = z.z > 0 ? -1 : 1, at = (d: number) => Object.assign(foe, { x: z.x, z: z.z + dz * d, facing: Math.PI, stance: 'hold', morale: 9999, maxMorale: 9999 });
  Object.assign(home, { x: z.x, z: z.z, men: 270, facing: 0 });
  at(40); command(sim, 0, { c: 'replenish', ids: [home.id] });
  assert.equal(home.refill, false, 'refused with the enemy 40 units away');
  at(sim.tu.refillClear + 50); command(sim, 0, { c: 'replenish', ids: [home.id] });
  assert.equal(home.refill, true, 'allowed with the enemy well off'); run(sim, 3); const m = home.men;
  assert.ok(m > 270, 'men trickle in');
  at(40); run(sim, 3);
  assert.ok(Math.abs(home.men - m) < 1e-6 && home.refill === true, 'paused while the enemy is near, the order kept');
  at(sim.tu.refillClear + 50); run(sim, 3);
  assert.ok(home.men > m, 'resumes when the enemy goes');
  command(sim, 0, { c: 'replenish', ids: [home.id] }); assert.equal(home.refill, false, 'switching it off always works');
  const far = arena((fr, co) => [fr.filter((u) => u.type === 'line')[0], co.filter((u) => u.type === 'line')[0]]), h2 = far.s.units[0], f2 = far.s.units[1];
  far.s.zones.forEach((q: any) => Object.assign(q, { owner: null, p: 0 })); far.s.side[0].rp = 100;
  Object.assign(h2, { x: 0, z: 0, men: 270 }); Object.assign(f2, { x: 0, z: 40, facing: Math.PI, stance: 'hold' });
  command(far, 0, { c: 'replenish', ids: [h2.id] });
  assert.ok(!far.s.units.some((u: any) => u.draftFor != null), 'no draft is sent into a fight');
});

test('a square marches slowly, and one caught by horse while still forming suffers far more than a formed square or a line', () => {
  const foot = (form: string) => { let u: any; const sim = arena((fr, co) => [u = Object.assign(fr.filter((q) => q.type === 'line')[0], { x: 0, z: -60, facing: 0, form }), Object.assign(co[0], { x: 170, z: 170 })]); command(sim, 0, { c: 'move', ids: [u.id], x: 0, z: 60 }); run(sim, 10); return u.z + 60; };
  assert.ok(foot('square') < 4.5 && foot('square') > 0.5 && foot('square') < foot('column') / 4, `a square covered ${foot('square').toFixed(1)} in 10 s`);
  const charged = (form: string, busy: number) => {
    let h: any, e: any;
    const sim = arena((fr, co) => [h = Object.assign(fr.filter((u) => u.type === 'lancer' || u.type === 'cuirassier')[0], { x: 0, z: 0, facing: 0, morale: 9999, maxMorale: 9999 }), e = Object.assign(co.filter((u) => u.type === 'line')[0], { x: 0, z: 3, facing: Math.PI, form, busy, stance: 'hold', morale: 9999, maxMorale: 9999 }), Object.assign(co[co.length - 1], { x: 170, z: 170 })]);
    e.busy = busy; // the arena clears it: forming from the first tick
    command(sim, 0, { c: 'attack', ids: [h.id], target: e.id });
    let stun = 0;
    run(sim, 5, undefined, () => { stun = Math.max(stun, e.stun ?? 0); if (busy > 0) e.busy = busy; });
    return { lost: e.maxMen - e.men, stun };
  };
  const line = charged('line', 0), formed = charged('square', 0), forming = charged('square', 3);
  assert.ok(formed.lost < line.lost * 0.6, `a formed square holds (${formed.lost.toFixed(0)} lost against a line's ${line.lost.toFixed(0)})`);
  assert.ok(forming.lost > line.lost * 1.4 && forming.lost > formed.lost * 3, `still forming it is slaughtered (${forming.lost.toFixed(0)} lost)`);
  assert.ok(forming.stun > 0 && formed.stun === 0, 'caught forming it is stunned by the charge; a formed square is not');
});

test('there is no auto-square: foot form square only on an order, and the bot does it by hand when horse close in', () => {
  let inf: any, cav: any;
  const sim = arena((fr, co) => [cav = Object.assign(fr.filter((u) => u.type === 'lancer')[0], { x: 0, z: -45, facing: 0 }), inf = Object.assign(co.filter((u) => u.type === 'line')[0], { x: 0, z: 0, facing: Math.PI, form: 'line', stance: 'hold' }), Object.assign(co[co.length - 1], { x: 170, z: 170 })]);
  assert.ok(!('auto' in inf), 'the regiment has no auto-square flag');
  run(sim, 5);
  assert.equal(inf.form, 'line', 'horse close by: nothing happens by itself');
  const bot = makeBot(sim, 1);
  run(sim, 6, () => inf.form === 'square', () => bot(0.05));
  assert.equal(inf.form, 'square', 'the bot, thinking every 2 s, orders the square');
  assert.ok(inf.busy > 0 || inf.form === 'square', 'it takes formChangeTime to form');
  Object.assign(cav, { x: 0, z: -200 });
  run(sim, 15, () => inf.form === 'line', () => bot(0.05));
  assert.equal(inf.form, 'line', 'and breaks it up when the horse are gone');
});

test('a short order to the rear steps back facing the enemy only when one is near; otherwise the regiment turns and marches', () => {
  const order = (foe: [number, number], to: [number, number]) => {
    let inf: any;
    const sim = arena((fr, co) => [inf = Object.assign(fr.filter((u) => u.type === 'line')[0], { x: 0, z: 0, facing: Math.PI / 2, form: 'line' }), Object.assign(co[0], { x: foe[0], z: foe[1] }), Object.assign(co[co.length - 1], { x: 170, z: 170 })]);
    command(sim, 0, { c: 'move', ids: [inf.id], x: to[0], z: to[1] });
    return inf;
  };
  assert.ok(order([0, -35], [-15, 0]).back, 'enemy within 45: it steps back, keeping its front');
  assert.ok(!order([0, -100], [-15, 0]).back, 'no enemy near: it turns round and marches');
  assert.ok(!order([0, -35], [-30, 0]).back, 'a march of 30 is no step back: it turns and marches');
  assert.ok(!order([0, -35], [15, 0]).back, 'ahead of it is never a step back');
});

test('ammunition: a dry regiment cannot fire, a spent one counts its rounds, and a depot refills it', () => {
  let a: any, e: any;
  const sim = arena((fr, co) => { a = fr.find((u) => u.type === 'line'); e = co.find((u) => u.type === 'line'); return [Object.assign(a, { x: 0, z: -12, facing: 0 }), Object.assign(e, { x: 0, z: 0, facing: Math.PI }), Object.assign(co.find((u) => u !== e), { x: 170, z: 170 })]; });
  a.ammo = 0; e.ammo = 5;
  run(sim, 30);
  assert.ok(a.fired > 20, `the dry regiment never fired (last shot ${a.fired.toFixed(0)} s ago)`);
  assert.ok(e.ammo < 5 && e.fired < 10, 'its foe, with powder, kept firing and spent rounds');
  const sim2 = arena((fr, co) => { a = fr.find((u) => u.type === 'line'); return [Object.assign(a, { x: 0, z: 0 }), Object.assign(co[0], { x: 170, z: 170 })]; });
  Object.assign(sim2.s.zones[0], { x: 0, z: 0, r: 20, owner: 0, p: 1 }); a.ammo = 0;
  run(sim2, 40);
  assert.ok(a.ammo >= 3 && a.ammo <= 5, `resting on our objective it took on ~0.1 round a second (${a.ammo.toFixed(1)})`);
});

test('the army wavers once the men still fighting fall under the break point', () => {
  let a: any, e: any;
  const sim = arena((fr, co) => { a = fr.find((u) => u.type === 'line'); e = co.find((u) => u.type === 'line'); return [Object.assign(a, { x: 0, z: 0 }), Object.assign(e, { x: 170, z: 170 })]; });
  run(sim, 1);
  assert.equal(sim.s.side[0].broken, 0, 'a fresh army is steady');
  sim.s.side[0].lost = 10 * a.men; // ten regiments' worth already gone
  run(sim, 1);
  assert.ok(sim.s.side[0].broken > 0.5, 'the army is far under the break point');
  assert.ok(sim.s.log.some((l: any) => /army wavers/.test(l.msg)), 'it says so');
});

test('horse ride down broken men harder than they hit a formed line', () => {
  const ride = (mult: number) => {
    let cav: any, ln: any;
    const sim = arena((fr, co) => { cav = fr.find((u) => u.type === 'lancer'); ln = co.find((u) => u.type === 'line'); return [Object.assign(cav, { x: 0, z: -10, facing: 0 }), Object.assign(ln, { x: 0, z: 0, facing: Math.PI, routed: true, morale: 0 }), Object.assign(co.find((u) => u !== ln), { x: 170, z: 170 })]; });
    sim.tu.pursuit.mult = mult;
    command(sim, 0, { c: 'attack', ids: [cav.id], target: ln.id });
    run(sim, 12);
    return ln.maxMen - ln.men;
  };
  assert.ok(ride(2.4) > ride(1.5) * 1.2, 'pursuit multiplies the cut-down');
});

test('a general up with the fighting lends his regiments an edge; one far behind the line does not', () => {
  const lead = (cz: number) => {
    let a: any, cmd: any;
    const sim = arena((fr, co) => { a = fr.find((u) => u.type === 'line'); cmd = fr.find((u) => u.type === 'commander'); return [Object.assign(a, { x: 0, z: 0 }), Object.assign(cmd, { x: 0, z: cz }), Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 30, facing: Math.PI }), Object.assign(co.filter((u) => u.type !== 'commander')[1], { x: 170, z: 170 })]; });
    run(sim, 0.2);
    return a.lead;
  };
  assert.equal(lead(-5), true, 'the general stands close to the enemy');
  assert.equal(lead(-120), false, 'the general is out of touch with the line');
});

test('a scenario can build on another: the derived JSON keeps the base map and zones and overrides only what it names', () => {
  const b = data('bridge'), g = data('genappe');
  assert.deepEqual(b.zones, g.zones, 'zones come from the base');
  assert.equal(JSON.stringify(b.map), JSON.stringify(g.map), 'so does the map');
  assert.equal(b.id, 'bridge');
  assert.deepEqual(b.hold, { zone: 'br', side: 1, t: 300 });
  assert.equal(b.extends, undefined, 'the link itself is not carried');
});

test('a timed objective: held at the deadline the day is won there and then; lost, the battle carries on', () => {
  const play = (owned: boolean) => {
    const sim = createSim(data('bridge'), data('tuning'), { seed: 1 }), z = sim.s.zones.find((q: any) => q.id === 'br');
    Object.assign(z, owned ? { owner: 1, p: -1 } : { owner: 0, p: 1 });
    sim.s.t = 298;
    run(sim, 6);
    return sim.s;
  };
  const won = play(true), lost = play(false);
  assert.ok(won.over && won.result.winner === 1 && !won.result.decisive, 'the Coalition held the bridge and win');
  assert.ok(!lost.over, 'the French took it: the clock runs on');
  assert.ok(won.log.some((l: any) => /Hold Genappe Bridge/.test(l.msg)), 'the countdown was announced');
});

test('a rearguard wins by keeping its strength to the deadline, and loses by not', () => {
  const play = (lost: number) => {
    const sim = createSim(data('retreat'), data('tuning'), { seed: 1 });
    sim.s.side[1].lost = lost; sim.s.t = sim.scn.duration - 1;
    run(sim, 3);
    return sim.s;
  };
  assert.equal(play(0).result.winner, 1, 'the Coalition kept all its men');
  assert.equal(play(1e6).result.winner, 0, 'the Coalition was ground down');
  const sim = createSim(data('retreat'), data('tuning'), { seed: 1 });
  assert.ok(verdict(sim.s, sim.tu) < 0.5, 'the bar leans to the rearguard while it stands whole');
});

test('the bot in a retreat stance falls back toward its own edge instead of holding ground', () => {
  const sim = createSim(data('retreat'), data('tuning'), { seed: 1 }), bots = [makeBot(sim, 0), makeBot(sim, 1)];
  const mine = sim.s.units.filter((u: any) => u.side === 1 && u.type !== 'commander'), z0 = mine.reduce((a: number, u: any) => a + u.z, 0) / mine.length;
  for (let i = 0; i < 1600; i++) { step(sim, 0.05); bots[0](0.05); bots[1](0.05); }
  const alive = mine.filter((u: any) => !u.dead), z1 = alive.reduce((a: number, u: any) => a + u.z, 0) / Math.max(1, alive.length);
  assert.ok(alive.length && z1 < z0 - 25, `the rearguard moved north (mean z ${z0.toFixed(0)} -> ${z1.toFixed(0)})`);
});

test('guns are poor at long range: far shots land far less often, and a battery that keeps firing at one target ranges in', () => {
  const shoot = (d: number, secs = 150) => {
    let g: any, e: any;
    const sim = arena((fr, co) => { g = fr.find((u) => u.type === 'artillery'); e = co.find((u) => u.type === 'line'); return [Object.assign(g, { x: 0, z: 0, facing: Math.PI, limbered: false, limT: 0, ammo: 999 }), Object.assign(e, { x: 0, z: -d, facing: 0, men: 5400, maxMen: 5400, morale: 1e9, maxMorale: 1e9, stance: 'hold' }), Object.assign(co.find((u) => u !== e), { x: 170, z: 170 })]; });
    g.facing = 0;
    run(sim, secs);
    return { lost: 5400 - e.men, g, e };
  };
  const near = shoot(45), far = shoot(88);
  assert.ok(far.lost < near.lost * 0.5, `long range does far less: ${far.lost.toFixed(0)} vs ${near.lost.toFixed(0)}`);
  assert.ok(far.g.zero?.n >= 4, 'the battery ranged in on its target');
  const sim = arena((fr, co) => [Object.assign(fr.find((u) => u.type === 'artillery'), { x: 0, z: 0 }), Object.assign(co[0], { x: 170, z: 170 })]);
  const gun = sim.s.units.find((u: any) => u.type === 'artillery');
  gun.zero = { id: 99, n: 5 }; gun.tx = 0; gun.tz = 30; run(sim, 3);
  assert.equal(gun.zero, null, 'moving loses the range');
});

test('a wide bridge keeps a broader strip of the river dry than a narrow one', () => {
  const g = data('genappe'), narrow = { ...g, map: structuredClone(g.map) }, wide = { ...g, map: structuredClone(g.map) };
  wide.map.rivers[0].bridges = [[-5, 16, 12], ...wide.map.rivers[0].bridges.slice(1)];
  narrow.map.rivers[0].bridges = [[-5, 16], ...narrow.map.rivers[0].bridges.slice(1)];
  let gained = 0, lostGround = 0;
  for (let a = 0; a < 360; a += 5) for (const r of [8, 9, 10, 11]) {
    const x = -5 + r * Math.cos((a * Math.PI) / 180), z = 16 + r * Math.sin((a * Math.PI) / 180), n = !!riverAt(narrow, x, z), w = !!riverAt(wide, x, z);
    if (n && !w) gained++;
    if (!n && w) lostGround++;
  }
  assert.ok(gained > 0 && lostGround === 0, `wide bridge: ${gained} more dry cells, none lost`);
  assert.equal(data('genappe').map.rivers[0].bridges[1].length, 3, 'the Ways bridge is a wide one in the data');
});

test('endless waves: a bigger group every half minute, the besieged side never wins by killing, and its fall ends the stand', () => {
  const sim = createSim(data('laststand'), data('tuning'), { seed: 1 });
  const size = (k: number) => sim.scn.waves.kinds.reduce((a: number, w: any) => a + (k >= (w.from ?? 0) ? Math.max(0, Math.floor(w.base + w.per * k)) : 0), 0);
  assert.ok(size(10) > size(0) && size(20) > size(10), 'each wave is larger');
  run(sim, 100);
  assert.equal(sim.s.wave, 3, 'three waves by 100 s (at 20, 50 and 80)');
  for (const u of sim.s.units) if (u.side === 0) u.men = 1;
  for (const u of sim.s.units) if (u.side === 0) u.morale = 0;
  run(sim, 40);
  assert.ok(sim.s.over && sim.s.result.winner === 1, 'with the Guard gone the stand is over');
});

test('campaign battles start with the objectives neutral unless a side stands on them', () => {
  for (const id of ['charleroi', 'quatrebras', 'ligny']) assert.ok(data(id).zones.every((z: any) => z.owner == null || z.owner === 0), `${id}: the Coalition holds nothing at the start`);
  assert.deepEqual(data('genappe').zones.filter((z: any) => z.owner === 1).map((z: any) => z.id).sort(), ['br', 'ne', 'rc'], 'the rearguard holds the ground it stands on');
});

test('the Old Guard is stronger than the line: one regiment beats two, but not three', () => {
  const fight = (n: number) => {
    let ls: any[] = [], g: any;
    const sim = arena((fr, co) => {
      ls = co.filter((u) => u.type === 'line').slice(0, n);
      ls.forEach((l, i) => Object.assign(l, { x: (i - (n - 1) / 2) * 26, z: 0, facing: Math.PI, stance: 'aggressive', morale: l.maxMorale }));
      return [Object.assign(fr.find((u) => u.type === 'line'), { x: 190, z: -190 }), ...ls];
    });
    g = spawnUnit(sim, 0, { type: 'guard', name: 'Guard', x: 0, z: -40 });
    Object.assign(g, { facing: 0, stance: 'aggressive' });
    command(sim, 0, { c: 'attack', ids: [g.id], target: ls[0].id });
    for (const l of ls) command(sim, 1, { c: 'attack', ids: [l.id], target: g.id });
    run(sim, 300, () => g.dead || g.routed || ls.every((l) => l.dead || l.routed));
    return { guard: g.dead || g.routed ? 0 : g.men, lines: ls.reduce((a, l) => a + (l.dead || l.routed ? 0 : l.men), 0) };
  };
  const two = fight(2), three = fight(3);
  assert.ok(two.guard > two.lines, `1 v 2: the Guard keeps ${Math.round(two.guard)} men, the lines ${Math.round(two.lines)}`);
  assert.ok(three.guard < three.lines, `1 v 3: the Guard keeps ${Math.round(three.guard)} men, the lines ${Math.round(three.lines)}`);
});

test('golden: the sim plays out as it did when SIM_VERSION was last bumped (saves and replay files are only valid within one version)', () => {
  const sim = createSim(data('ligny'), data('tuning'), { seed: 1 }), bots = [makeBot(sim, 0), makeBot(sim, 1)];
  for (let i = 0; i < 1200; i++) { step(sim, 0.05); bots[0](0.05); bots[1](0.05); }
  let h = 2166136261; // FNV-1a over every regiment's place and strength after a minute of bot against bot
  for (const ch of JSON.stringify(sim.s.units.map((u: any) => [u.id, Math.round(u.x * 10), Math.round(u.z * 10), Math.round(u.men)]))) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  assert.equal(`${SIM_VERSION}:${h >>> 0}`, '3:734255717', 'the sim changed: bump SIM_VERSION in src/sim/sim.ts, then put this value in the test');
});

test('the server drops orders from a client that floods it, and still obeys one that keeps to a normal pace', async () => {
  await startServer();
  try {
    const a = await connect('quatrebras');
    const u = a.last.units.find((x: any) => x.side === a.side && x.type === 'line');
    a.send({ t: 'cmd', c: { c: 'stance', ids: [u.id], s: 'aggressive' } });
    for (let i = 0; i < 300; i++) a.send({ t: 'cmd', c: { c: 'face', ids: [u.id], x: 1, z: 1 } });
    a.send({ t: 'cmd', c: { c: 'stance', ids: [u.id], s: 'hold' } }); // the 302nd order in a burst: dropped
    await wait(500);
    assert.equal(a.last.units.find((x: any) => x.id === u.id).stance, 'aggressive', 'the flood used the allowance up, so the last order never arrived');
    await wait(1500); // the allowance refills (30 a second)
    a.send({ t: 'cmd', c: { c: 'stance', ids: [u.id], s: 'hold' } });
    await wait(500);
    assert.equal(a.last.units.find((x: any) => x.id === u.id).stance, 'hold', 'an ordinary order goes through again');
    a.ws.close();
  } finally { server.removeAllListeners('exit'); server.kill(); }
});
