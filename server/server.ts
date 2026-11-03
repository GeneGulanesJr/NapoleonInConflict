// Authoritative multiplayer server. Run: node server/server.ts   (PORT env, default 8080)
// One room per scenario. Humans are split across the two sides (team vs team); an empty side is played by a bot.
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { createSim, step, command, type Cmd, type Sim } from '../src/sim/sim.ts';
import { makeBot } from '../src/sim/bot.ts';
import { freshRoster } from '../src/sim/roster.ts';

const j = (f: string) => JSON.parse(readFileSync(new URL(`../src/data/${f}.json`, import.meta.url), 'utf8'));
const tu = j('tuning'), camp = j('campaign');
const scenarios: Record<string, any> = Object.fromEntries(camp.battles.map((id: string) => [id, j(id)]));

type Room = { id: string; sim: Sim; bots: (((dt: number) => void) | null)[]; clients: Map<WebSocket, number>; restartAt: number };
const rooms = new Map<string, Room>();

function newSim(id: string) {
  return createSim(scenarios[id], tu, { seed: (Date.now() & 0x7fffffff) || 1, roster: freshRoster(camp, tu) });
}
function getRoom(id: string): Room {
  let r = rooms.get(id);
  if (!r) { const sim = newSim(id); r = { id, sim, bots: [makeBot(sim, 0), makeBot(sim, 1)], clients: new Map(), restartAt: 0 }; rooms.set(id, r); }
  return r;
}
const humans = (r: Room, side: number) => [...r.clients.values()].filter((s) => s === side).length;
const syncBots = (r: Room) => { for (const side of [0, 1]) r.bots[side] = humans(r, side) ? null : (r.bots[side] ?? makeBot(r.sim, side)); };
/** A room whose sim threw is closed so the other rooms keep running. */
function dropRoom(r: Room, err: unknown) {
  console.error(`room ${r.id} crashed:`, err);
  rooms.delete(r.id);
  for (const ws of r.clients.keys()) ws.close(1011, 'room error');
}

const round = (_: string, v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const ids = (v: unknown): v is number[] => Array.isArray(v) && v.length <= 100 && v.every(num);
const known = (table: object, k: unknown): k is string => typeof k === 'string' && Object.hasOwn(table, k);

/** Rebuilds a client command from scratch, or returns null. Every field the sim reads must be present and valid. */
function clean(c: any): Cmd | null {
  if (!c || typeof c !== 'object') return null;
  switch (c.c) {
    case 'move': return ids(c.ids) && num(c.x) && num(c.z) ? { c: 'move', ids: c.ids, x: c.x, z: c.z, q: c.q === true } : null;
    case 'attack': return ids(c.ids) && num(c.target) ? { c: 'attack', ids: c.ids, target: c.target } : null;
    case 'form': return ids(c.ids) && known(tu.formFire, c.f) ? { c: 'form', ids: c.ids, f: c.f } : null;
    case 'stance': return ids(c.ids) && typeof c.s === 'string' ? { c: 'stance', ids: c.ids, s: c.s } : null;
    case 'garrison': return ids(c.ids) && num(c.vid) ? { c: 'garrison', ids: c.ids, vid: c.vid } : null;
    case 'stop': case 'special': case 'auto': case 'replenish': return ids(c.ids) ? { c: c.c, ids: c.ids } : null;
    case 'ability': return known(tu.abilities, c.name) && num(c.x) && num(c.z) ? { c: 'ability', name: c.name, x: c.x, z: c.z } : null;
    case 'deploy': return known(tu.types, c.type) ? { c: 'deploy', type: c.type } : null;
  }
  return null;
}

const wss = new WebSocketServer({ port: Number(process.env.PORT ?? 8080), maxPayload: 4096, perMessageDeflate: true });
const alive = new WeakSet<WebSocket>();
wss.on('connection', (ws) => {
  let room: Room | null = null;
  alive.add(ws);
  ws.on('pong', () => alive.add(ws));
  ws.on('message', (raw) => {
    try {
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'join' && !room && known(scenarios, m.scenario)) {
        room = getRoom(m.scenario);
        const side = humans(room, 0) <= humans(room, 1) ? 0 : 1;
        room.clients.set(ws, side);
        syncBots(room);
        ws.send(JSON.stringify({ t: 'hello', side, scenario: room.id }));
      } else if (m.t === 'cmd' && room) {
        const c = clean(m.c);
        if (c) command(room.sim, room.clients.get(ws)!, c);
      }
    } catch (err) { console.error('bad message ignored:', err); }
  });
  ws.on('close', () => {
    if (!room) return;
    room.clients.delete(ws);
    if (rooms.get(room.id) !== room) return; // room already replaced after a crash
    syncBots(room);
    if (!room.clients.size) rooms.delete(room.id);
  });
});

// a connection that stops answering pings (dropped wifi) is closed, so its side goes back to the bot
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) { ws.terminate(); continue; }
    alive.delete(ws);
    ws.ping();
  }
}, 30000);

let tick = 0;
setInterval(() => {
  tick++;
  for (const r of rooms.values()) {
    try {
      const s = r.sim.s;
      if (!s.over) { step(r.sim, 0.05); r.bots[0]?.(0.05); r.bots[1]?.(0.05); }
      else if (!r.restartAt) r.restartAt = Date.now() + 12000;
      else if (Date.now() > r.restartAt) {
        r.sim = newSim(r.id); r.restartAt = 0; r.bots = [null, null]; syncBots(r);
        for (const [ws, side] of r.clients) ws.send(JSON.stringify({ t: 'hello', side, scenario: r.id }));
      }
      if (tick % 2 === 0) {
        const msg = JSON.stringify({ t: 'state', s: { ...r.sim.s, out: undefined, seed: undefined } }, round);
        r.sim.s.events.length = 0;
        // skip clients that cannot keep up instead of buffering without limit
        for (const ws of r.clients.keys()) if (ws.readyState === 1 && ws.bufferedAmount < 1_000_000) ws.send(msg);
      }
    } catch (err) { dropRoom(r, err); }
  }
}, 50);
console.log(`Napoleon In Conflict server on ws://localhost:${process.env.PORT ?? 8080}`);
