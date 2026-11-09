// Directed battle: scripted orders at fixed sim times, for a reconstruction that follows a narrated account instead of the sim's own combat.
// An order names its units by a regular expression on their names; `target` (attack) is the same, resolved to an enemy regiment.
// Besides the sim's own commands, two scripted ones: { c: 'men', to, over } thins a regiment to `to` men over `over` seconds (to 0: it is gone), { c: 'rout' } breaks it.
// With opts.lock the sim is only a stage: every tick the regiments' men, morale and ammunition are put back to the script's values, so movement, firing and falling men
// are the sim's own but who wins, who breaks and who dies is the script's.
import { command, ev } from './sim.ts';

export type Order = { t: number; side: number; who: string; c: string; target?: string; to?: number; over?: number; [k: string]: any };

/** Returns a function to call once per tick: it issues every order whose time has come (at once, not by courier) and, with lock, keeps the stage in order. */
export function directed(sim: any, orders: Order[], opts: { lock?: boolean } = {}) {
  const list = [...orders].sort((a, b) => a.t - b.t); let i = 0;
  const book = new Map<number, { men: number; ammo: number }>(), ramps: { id: number; from: number; to: number; t0: number; t1: number }[] = [], broken = new Set<number>();
  const entry = (u: any) => { let b = book.get(u.id); if (!b) book.set(u.id, (b = { men: u.men, ammo: u.ammo })); return b; };
  return () => {
    while (i < list.length && list[i].t <= sim.s.t) {
      const { t: _t, side, who, target, to, over, ...cmd } = list[i++], re = new RegExp(who);
      const us = sim.s.units.filter((u: any) => u.side === side && !u.dead && re.test(u.name));
      if (cmd.c === 'men') { for (const u of us) ramps.push({ id: u.id, from: entry(u).men, to: to ?? 0, t0: sim.s.t, t1: sim.s.t + (over ?? 1) }); continue; }
      if (cmd.c === 'rout') { for (const u of us) { u.routed = true; broken.add(u.id); } continue; }
      if (target) { const e = sim.s.units.find((u: any) => u.side !== side && !u.dead && new RegExp(target).test(u.name)); if (!e) continue; (cmd as any).target = e.id; }
      const ids = us.map((u: any) => u.id);
      if (ids.length) command(sim, side, { ...cmd, ids } as any, true);
    }
    if (!opts.lock) return;
    for (const u of sim.s.units) {
      if (u.dead) continue;
      const b = entry(u);
      for (const r of ramps) if (r.id === u.id) b.men = r.from + (r.to - r.from) * Math.max(0, Math.min(1, (sim.s.t - r.t0) / Math.max(1e-6, r.t1 - r.t0)));
      if (b.men < 0.5) { u.men = 0; u.dead = true; ev(sim, { k: 'dead', x: u.x, z: u.z, side: u.side, name: u.name }); continue; } // thinned to nothing: gone
      u.men = b.men; u.ammo = b.ammo; u.shaken = 0; u.stun = 0;
      if (!broken.has(u.id)) { u.routed = false; u.morale = u.maxMorale; }
    }
  };
}
