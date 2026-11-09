// Directed battle: scripted orders at fixed sim times, for a reconstruction that follows a narrated account instead of a bot's own result.
// An order names its units by a regular expression on their names; `target` (attack) is the same, resolved to an enemy regiment.
import { command } from './sim.ts';

export type Order = { t: number; side: number; who: string; c: string; target?: string; [k: string]: any };

/** Returns a function to call once per tick: it issues every order whose time has come (at once, not by courier). */
export function directed(sim: any, orders: Order[]) {
  const list = [...orders].sort((a, b) => a.t - b.t); let i = 0;
  return () => {
    while (i < list.length && list[i].t <= sim.s.t) {
      const { t: _t, side, who, target, ...cmd } = list[i++], re = new RegExp(who);
      const ids = sim.s.units.filter((u: any) => u.side === side && !u.dead && re.test(u.name)).map((u: any) => u.id);
      if (target) { const e = sim.s.units.find((u: any) => u.side !== side && !u.dead && new RegExp(target).test(u.name)); if (!e) continue; (cmd as any).target = e.id; }
      if (ids.length) command(sim, side, { ...cmd, ids } as any, true);
    }
  };
}
