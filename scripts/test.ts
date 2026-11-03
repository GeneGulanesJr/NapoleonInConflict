// Run: npm test   (node --test, no extra dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { applyResult, reinforce, recruit, fillCost, type CampaignState } from '../src/sim/roster.ts';
import { runner, type Replay } from '../src/sim/replay.ts';
import { upscale } from '../src/render.ts';
import { readFileSync } from 'node:fs';
import { createSim, step, command, manPrice, distToFoot, posted, steady } from '../src/sim/sim.ts';
import { makeBot } from '../src/sim/bot.ts';
import { heightAt, groundAt } from '../src/sim/world.ts';

// ---------------------------------------------------------------- unit-vs-unit rules
const data = (f: string) => JSON.parse(readFileSync(new URL(`../src/data/${f}.json`, import.meta.url), 'utf8'));
/** a bare quatrebras sim on flat open ground with just these units (French a, Coalition b) plus a far-off foe so the battle doesn't end */
function arena(setup: (fr: any[], co: any[]) => any[], map?: any) {
  const sim = createSim(data('quatrebras'), data('tuning'), { seed: 1 });
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
  const sim = arena((fr, co) => [cav = Object.assign(fr.find((u) => u.type === 'lancer'), { x: 0, z: -80, facing: 0, men: 270 }), inf = Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 0, facing: Math.PI, form: 'line', auto: true, morale: 60 })]);
  sim.scn = { ...sim.scn, bot: ['attack', 'defend'] };
  const bot = makeBot(sim, 0);
  let hit = false, formed = false;
  run(sim, 60, () => cav.routed, () => { bot(0.05); if (inf.form === 'square') formed = true; if (cav.eng === inf.id && inf.form === 'square') hit = true; });
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
    a.send({ t: 'cmd', c: { c: 'move', ids: [u.id], x: u.x + 30, z: u.z - 30 } });
    a.send({ t: 'cmd', c: { c: 'stance', ids: [u.id], s: 'aggressive' } });
    await wait(4500);
    const u2 = a.last.units.find((x: any) => x.id === u.id);
    assert.ok(Math.hypot(u2.x - u.x, u2.z - u.z) > 3, 'unit moved');
    assert.equal(u2.stance, 'aggressive');
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
  const { t, sim } = square;
  t.shaken = 5; command(sim, 1, { c: 'form', ids: [t.id], f: 'line' });
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
  assert.ok(b.x === bx && b.tx == null, 'a spot outside the zone: it stays put, with no order');
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
  assert.ok(s.t > 59, 'the battle ran after the start');
  assert.equal(JSON.stringify(again.sim.s), JSON.stringify(s));
});
