// Run: npm test   (node --test, no extra dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { applyResult, type CampaignState } from '../src/sim/roster.ts';

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
