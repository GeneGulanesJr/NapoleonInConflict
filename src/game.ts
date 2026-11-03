// A "source" gives the UI a battle state and a way to send commands, locally or over a WebSocket.
import { createSim, type Cmd } from './sim/sim.ts';
import { runner, DT, type Replay } from './sim/replay.ts';
import { TUNING, fogOn, difficulty } from './campaign.ts';

export interface Source {
  mode: 'local' | 'remote';
  side: number;
  state: any;
  speed: number;
  paused: boolean;
  /** local battles: the recording so far (start state + commands), to watch back */
  rec?: Replay;
  /** this source plays a recording back: orders are ignored */
  replay?: boolean;
  cmd(c: Cmd): void;
  update(dt: number): void;
  drainEvents(): any[];
  close(): void;
}

/** Fixed-step driver shared by live battles and replays. */
function drive(tu: any, r: Replay, play: boolean): Source {
  const run = runner(tu, r, play);
  let acc = 0;
  const src: Source = {
    mode: 'local', side: r.side, speed: 1, paused: false, rec: r, replay: play,
    get state() { return run.sim.s; },
    cmd: (c) => run.cmd(c),
    update(dt) {
      if (src.paused || run.sim.s.over) return;
      acc = Math.min(acc + dt * src.speed, 1);
      while (acc >= DT && !run.sim.s.over) { run.tick(); acc -= DT; }
    },
    drainEvents() { const e = run.sim.s.events.slice(); run.sim.s.events.length = 0; return e; },
    close() { /* nothing to release */ },
  };
  return src;
}

/**
 * A battle against the bot. side: which army you command (the bot gets the other, at the chosen difficulty's strength).
 * resume: a saved sim state to carry on from. The campaign roster only fills the French side.
 */
export function localSource(scn: any, opts: { roster?: any[]; won?: Record<string, boolean>; grouchy?: string; seed?: number; side?: number; resume?: any }): Source {
  const side = opts.side ?? 0, strength = [...(scn.strength ?? [1, 1])];
  strength[1 - side] *= TUNING.difficulty.enemyStrength[difficulty()];
  const s2 = { ...scn, strength };
  const s0 = opts.resume ?? createSim(s2, TUNING, { roster: opts.roster, won: opts.won, grouchy: opts.grouchy, fog: fogOn(), seed: opts.seed ?? (Date.now() & 0x7fffffff) }).s;
  return drive(TUNING, { scn: s2, won: opts.won, grouchy: opts.grouchy, side, start: JSON.stringify(s0), cmds: [] }, false);
}

/** Watch a recorded battle again, from its start state. */
export const replaySource = (r: Replay): Source => drive(TUNING, r, true);

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
