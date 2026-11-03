// Run: npm test   (node --test, no extra dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { applyResult, type CampaignState } from '../src/sim/roster.ts';
import { upscale } from '../src/render.ts';
import { readFileSync } from 'node:fs';
import { createSim, step, command } from '../src/sim/sim.ts';
import { makeBot } from '../src/sim/bot.ts';
import { heightAt, groundAt } from '../src/sim/world.ts';

// ---------------------------------------------------------------- unit-vs-unit rules
const data = (f: string) => JSON.parse(readFileSync(new URL(`../src/data/${f}.json`, import.meta.url), 'utf8'));
/** a bare quatrebras sim on flat open ground with just these units (French a, Coalition b) plus a far-off foe so the battle doesn't end */
function arena(setup: (fr: any[], co: any[]) => any[], map?: any) {
  const sim = createSim(data('quatrebras'), data('tuning'), { seed: 1 });
  const fr = sim.s.units.filter((u: any) => u.side === 0), co = sim.s.units.filter((u: any) => u.side === 1);
  sim.s.units = setup(fr, co).map((u) => Object.assign(u, { tx: null, tz: null, vet: 0, busy: 0 })); sim.tl = [];
  sim.s.side.forEach((sd: any) => (sd.reserves = {})); // bots must not deploy or call in aid mid-test
  sim.scn = { ...sim.scn, abilities: [[], []], map: map ?? { size: 400 } }; // unit-rule tests must not depend on the scenario's terrain; pass a map to test terrain
  return sim;
}
const run = (sim: any, secs: number, until = () => false, each = () => {}) => { for (let t = 0; t < secs && !until(); t += 0.05) { step(sim, 0.05); each(); } };

test('friendly regiments march through each other without shoving', () => {
  let a: any, b: any;
  const sim = arena((fr, co) => { [a, b] = fr.filter((u) => u.type === 'line'); return [Object.assign(a, { x: 0, z: -40, facing: 0, form: 'column' }), Object.assign(b, { x: 0, z: 0, facing: 0, form: 'line' }), Object.assign(co[0], { x: 170, z: 170 })]; });
  command(sim, 0, { c: 'move', ids: [a.id], x: 0, z: 40 });
  run(sim, 20);
  assert.ok(Math.hypot(a.x, a.z - 40) < 2, `marcher arrived (at ${a.x.toFixed(1)}, ${a.z.toFixed(1)})`);
  assert.ok(Math.hypot(b.x, b.z) < 0.5, 'the standing regiment kept its post');
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
  sim.scn = { ...sim.scn, rpRate: [0, 0] }; sim.s.side[0].rp = 100;
  const z = Object.assign(sim.s.zones[0], { owner: 0, p: 1 });
  Object.assign(home, { x: z.x, z: z.z, men: 270 });
  command(sim, 0, { c: 'replenish', ids: [home.id] });
  assert.ok(!sim.s.units.some((u: any) => u.draftFor != null), 'no draft needed at a depot');
  run(sim, 20);
  assert.equal(Math.round(home.men), home.maxMen, 'the regiment on our objective is back to full strength');
  const cost = (30 * (home.maxMen - 270)) / home.maxMen; // line infantry deploys for 30 pts
  assert.ok(Math.abs(sim.s.side[0].rp - (100 - cost)) < 0.5, `paid ${cost} pts (rp left ${sim.s.side[0].rp.toFixed(1)})`);
  assert.equal(home.refill, false, 'the order clears itself once full');
});

test('off our objectives a draft marches in from our map edge at double cost and joins the regiment', () => {
  let reg: any;
  const sim = arena((fr, co) => [reg = Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: 100, men: 270 }), Object.assign(co[0], { x: 170, z: -170 })]);
  sim.scn = { ...sim.scn, rpRate: [0, 0] }; sim.s.side[0].rp = 100; sim.s.zones = []; // no depots anywhere
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
    const sim = arena((fr, co) => [a = Object.assign(fr.find((u) => u.type === 'line'), { x: -120, z: 0, facing: Math.PI / 2, form: 'line', morale: 9999, maxMorale: 9999 }), Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 30, facing: Math.PI, form: 'line', morale: 9999, maxMorale: 9999 })]);
    command(sim, 0, { c: 'move', ids: [a.id], x: 120, z: 0, am });
    let shots = 0;
    run(sim, 120, undefined, () => { for (const e of sim.s.events) if (e.k === 'shot' && e.side === 0) shots++; sim.s.events.length = 0; });
    return { shots, x: a.x };
  };
  const am = pass(true), plain = pass(false);
  assert.ok(am.shots > 0 && am.x < 60, `attack-move halted and fired (${am.shots} shots, at x ${am.x.toFixed(1)})`);
  assert.ok(plain.shots === 0 && plain.x > 110, `plain move marched past without firing (${plain.shots} shots, at x ${plain.x.toFixed(1)})`);
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
    const sim = arena((fr, co) => [Object.assign(fr.find((u) => u.type === 'line'), { x: 0, z: -14, facing: 0, form: 'line' }), Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 14, facing: Math.PI, form: 'line' })], { size: 400, rough: FLAT, hills });
    let n = 0;
    run(sim, 20, undefined, () => { n += sim.s.events.filter((e: any) => e.k === 'shot').length; sim.s.events.length = 0; });
    return n;
  };
  assert.ok(shots([]) > 0, 'on open ground they trade volleys');
  assert.equal(shots([{ x: 0, z: 0, rx: 300, rz: 5, h: 8, p: 2 }]), 0, 'with a ridge between them nobody fires');
});

/** distance a unit covers in `secs` heading east from x=-60 over the given map */
function march(type: string, form: string, secs: number, map: any) {
  let u: any;
  const sim = arena((fr, co) => [u = Object.assign(fr.find((q) => q.type === type), { x: -60, z: 0, facing: Math.PI / 2, form }), Object.assign(co[0], { x: 170, z: 170 })], map);
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
      { t: 'cmd', c: { c: 'attack', ids: [u.id] } },
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
    await wait(2500);
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
  run(sim, 12, undefined, () => bot(0.05));
  const b = sim.s.units.find((u: any) => u.name === 'Bülow');
  assert.ok(b && b.tz === -60 && b.z < 100 - 30, `still marching on its route (z ${b?.z.toFixed(1)}, target z ${b?.tz})`);
});
