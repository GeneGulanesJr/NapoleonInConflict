// A "source" gives the UI a battle state and a way to send commands, locally or over a WebSocket.
import { createSim, step, command, type Cmd, type Sim } from './sim/sim.ts';
import { makeBot } from './sim/bot.ts';
import { TUNING, fogOn } from './campaign.ts';

export interface Source {
  mode: 'local' | 'remote';
  side: number;
  state: any;
  speed: number;
  paused: boolean;
  cmd(c: Cmd): void;
  update(dt: number): void;
  drainEvents(): any[];
  close(): void;
}

export function localSource(scn: any, opts: { roster?: any[]; won?: Record<string, boolean>; seed?: number }): Source {
  const sim: Sim = createSim(scn, TUNING, { ...opts, fog: fogOn(), seed: opts.seed ?? (Date.now() & 0x7fffffff) });
  const bot = makeBot(sim, 1);
  let acc = 0;
  const src: Source = {
    mode: 'local', side: 0, speed: 1, paused: false,
    get state() { return sim.s; },
    cmd: (c) => command(sim, 0, c),
    update(dt) {
      if (src.paused || sim.s.over) return;
      acc = Math.min(acc + dt * src.speed, 1);
      while (acc >= 0.05) { step(sim, 0.05); bot(0.05); acc -= 0.05; }
    },
    drainEvents() { const e = sim.s.events.slice(); sim.s.events.length = 0; return e; },
    close() { /* nothing to release */ },
  };
  return src;
}

/** Connects, joins `scenario`, and resolves once the first snapshot arrives. */
export function remoteSource(url: string, scenario: string): Promise<Source> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let pending: any[] = [];
    const src: Source = {
      mode: 'remote', side: 0, speed: 1, paused: false, state: null,
      cmd: (c) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'cmd', c })),
      update() { /* the server drives time */ },
      drainEvents() { const e = pending; pending = []; return e; },
      close: () => ws.close(),
    };
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', scenario }));
    ws.onerror = () => reject(new Error(`Cannot reach ${url}. Is the server running (npm run server)?`));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'hello') src.side = m.side;
      else if (m.t === 'state') {
        pending.push(...m.s.events);
        const first = !src.state;
        src.state = m.s;
        if (first) resolve(src);
      }
    };
    ws.onclose = () => { if (!src.state) reject(new Error('Connection closed')); };
  });
}
