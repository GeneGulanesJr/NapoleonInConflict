// Smoke test: start `npm run server`, then `node scripts/mp-test.ts`. Two clients join, one orders a move.
import { WebSocket } from 'ws';
const mk = (name: string) => new Promise<{ ws: WebSocket; side: number; snaps: any[] }>((res) => {
  const ws = new WebSocket('ws://localhost:8089'); const o: any = { ws, side: -1, snaps: [] };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', scenario: 'quatrebras' })));
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.t === 'hello') o.side = m.side; if (m.t === 'state') { o.snaps.push(m.s); if (o.snaps.length === 1) res(o); } });
});
const a = await mk('a'), b = await mk('b');
console.log('sides', a.side, b.side);
const u = a.snaps[0].units.find((x: any) => x.side === a.side && x.type === 'line');
const x0 = u.x, z0 = u.z;
a.ws.send(JSON.stringify({ t: 'cmd', c: { c: 'move', ids: [u.id], x: u.x + 30, z: u.z - 30 } }));
a.ws.send(JSON.stringify({ t: 'cmd', c: { c: 'move', ids: ['bad'], x: 'nope' } })); // must be ignored
b.ws.send(JSON.stringify({ t: 'cmd', c: { c: 'move', ids: [u.id], x: 0, z: 0 } })); // wrong side: ignored by sim
await new Promise((r) => setTimeout(r, 2500));
const last = b.snaps[b.snaps.length - 1];
const u2 = last.units.find((x: any) => x.id === u.id);
console.log('snapshots', b.snaps.length, 't=', last.t, 'moved', Math.round(u2.x - x0), Math.round(u2.z - z0));
process.exit(u2.x > x0 + 3 ? 0 : 1);
