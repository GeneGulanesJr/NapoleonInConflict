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

// ---------------------------------------------------------------- unit-vs-unit rules
const data = (f: string) => JSON.parse(readFileSync(new URL(`../src/data/${f}.json`, import.meta.url), 'utf8'));
/** a bare quatrebras sim with just these units (French a, Coalition b) plus a far-off foe so the battle doesn't end */
function arena(setup: (fr: any[], co: any[]) => any[]) {
  const sim = createSim(data('quatrebras'), data('tuning'), { seed: 1 });
  const fr = sim.s.units.filter((u: any) => u.side === 0), co = sim.s.units.filter((u: any) => u.side === 1);
  sim.s.units = setup(fr, co).map((u) => Object.assign(u, { tx: null, tz: null, vet: 0, busy: 0 })); sim.tl = [];
  sim.s.side.forEach((sd: any) => (sd.reserves = {})); sim.scn = { ...sim.scn, abilities: [[], []] }; // bots must not deploy or call in aid mid-test
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
  const sim = arena((fr, co) => [cav = Object.assign(fr.find((u) => u.type === 'lancer'), { x: 0, z: -31, facing: 0 }), inf = Object.assign(co.find((u) => u.type === 'line'), { x: 0, z: 0, facing: Math.PI, form: 'line' })]);
  const bot = makeBot(sim, 1);
  let changes = 0, last = inf.form;
  run(sim, 60, undefined, () => { cav.x = 0; cav.z = -31; bot(0.05); if (inf.form !== last) { changes++; last = inf.form; } });
  assert.ok(changes <= 1, `formed square and stayed (${changes} changes)`);
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

test('replenishing refills a regiment on held objective ground at the deploy rate, and only there', () => {
  let home: any, away: any;
  const sim = arena((fr, co) => { [home, away] = fr.filter((u) => u.type === 'line'); return [home, away, Object.assign(co[0], { x: 170, z: 170 })]; });
  sim.scn = { ...sim.scn, rpRate: [0, 0] }; sim.s.side[0].rp = 100;
  const z = Object.assign(sim.s.zones[0], { owner: 0, p: 1 });
  Object.assign(home, { x: z.x, z: z.z, men: 270 }); Object.assign(away, { x: -170, z: -170, men: 270 });
  command(sim, 0, { c: 'replenish', ids: [home.id, away.id] });
  run(sim, 20);
  assert.equal(Math.round(home.men), home.maxMen, 'the regiment on our objective is back to full strength');
  assert.equal(away.men, 270, 'the one off our ground waited');
  const cost = (30 * (home.maxMen - 270)) / home.maxMen; // line infantry deploys for 30 pts
  assert.ok(Math.abs(sim.s.side[0].rp - (100 - cost)) < 0.5, `paid ${cost} pts (rp left ${sim.s.side[0].rp.toFixed(1)})`);
  assert.equal(home.refill, false, 'the order clears itself once full');
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
