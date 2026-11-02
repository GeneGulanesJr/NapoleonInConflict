// Authoritative multiplayer server. Run: node server/server.ts   (PORT env, default 8080)
// One room per scenario. Humans are split across the two sides (team vs team); an empty side is played by a bot.
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { createSim, step, command, type Sim } from '../src/sim/sim.ts';
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

const round = (_: string, v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
const COMMANDS = new Set(['move', 'attack', 'form', 'stop', 'special', 'ability', 'deploy']);
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

const wss = new WebSocketServer({ port: Number(process.env.PORT ?? 8080), maxPayload: 4096 });
wss.on('connection', (ws) => {
  let room: Room | null = null;
  ws.on('message', (raw) => {
    let m: any;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.t === 'join' && !room && scenarios[m.scenario]) {
      room = getRoom(m.scenario);
      const side = humans(room, 0) <= humans(room, 1) ? 0 : 1;
      room.clients.set(ws, side);
      syncBots(room);
      ws.send(JSON.stringify({ t: 'hello', side, scenario: room.id }));
    } else if (m.t === 'cmd' && room && m.c && COMMANDS.has(m.c.c)) {
      const c = m.c;
      if (c.ids && (!Array.isArray(c.ids) || c.ids.length > 100 || !c.ids.every(num))) return;
      if (('x' in c && !num(c.x)) || ('z' in c && !num(c.z)) || ('target' in c && !num(c.target))) return;
      if (typeof c.name === 'string' ? c.name.length > 20 : false) return;
      command(room.sim, room.clients.get(ws)!, c);
    }
  });
  ws.on('close', () => { if (room) { room.clients.delete(ws); syncBots(room); if (!room.clients.size) rooms.delete(room.id); } });
});

let tick = 0;
setInterval(() => {
  tick++;
  for (const r of rooms.values()) {
    const s = r.sim.s;
    if (!s.over) { step(r.sim, 0.05); r.bots[0]?.(0.05); r.bots[1]?.(0.05); }
    else if (!r.restartAt) r.restartAt = Date.now() + 12000;
    else if (Date.now() > r.restartAt) {
      r.sim = newSim(r.id); r.restartAt = 0; r.bots = [null, null]; syncBots(r);
      for (const [ws, side] of r.clients) ws.send(JSON.stringify({ t: 'hello', side, scenario: r.id }));
    }
    if (tick % 2 === 0) {
      const msg = JSON.stringify({ t: 'state', s: { ...r.sim.s, out: undefined, seed: undefined } }, round);
      s.events.length = 0;
      for (const ws of r.clients.keys()) if (ws.readyState === 1) ws.send(msg);
    }
  }
}, 50);
console.log(`Napoleon In Conflict server on ws://localhost:${process.env.PORT ?? 8080}`);
