// Pure, deterministic battle simulation. No DOM, no Three.js: runs in the browser and on the Node server.
import { heightAt, featureAt, los } from './world.ts';
import { route } from './path.ts';

export type Sim = { s: any; scn: any; tu: any; tl: any[] };

export function rand(s: { seed: number }): number {
  s.seed = (s.seed + 0x6d2b79f5) | 0;
  let t = s.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const DEF_NAT = ['fr', 'gb'];
export const natOf = (scn: any, side: number) => scn.nat?.[side] ?? DEF_NAT[side];

/** Expand compact force groups {type,n,x,z,dx,dz,names[]} into single unit definitions. */
export function expandForces(groups: any[]): any[] {
  const out: any[] = [];
  for (const g of groups ?? []) {
    for (let i = 0; i < (g.n ?? 1); i++) // an unnamed group's regiments take the type's label in spawn() (not "undefined 2")
      out.push({ ...g, n: undefined, names: undefined, name: g.names?.[i] ?? (g.n > 1 && g.name ? `${g.name} ${i + 1}` : g.name), x: g.x + i * (g.dx ?? 0), z: g.z + i * (g.dz ?? 0) });
  }
  return out;
}

/**
 * opts.roster: campaign roster [{rid,type,name,men,maxMen}] used to fill side 0 slots (best-strength first).
 * opts.won: campaign results {battleId: boolean} used by `delayIfWon` timeline events.
 * opts.deploy: start in the deployment phase (place regiments, then 'start').
 * opts.grouchy: the campaign's orders for Grouchy (campaign.json grouchy.options id): timeline events and their unit groups
 * with `ifGrouchy` happen only under that order, with `unlessGrouchy` under any other (or none); `delayIfGrouchy` {id: seconds}.
 * opts.courier: orders reach distant regiments by courier (tuning.courier), for both sides.
 */
export function createSim(scn: any, tu: any, opts: { seed?: number; roster?: any[]; won?: Record<string, boolean>; grouchy?: string; fog?: boolean; deploy?: boolean; courier?: boolean } = {}): Sim {
  const mkSide = (i: number) => ({ rp: scn.rpStart?.[i] ?? 0, score: 0, lost: 0, cd: {} as Record<string, number>, reserves: { ...(scn.reserves?.[i] ?? {}) } });
  const s: any = {
    t: 0, seed: opts.seed ?? 1, nextId: 1, units: [], smoke: [], fx: [], out: [], log: [], events: [],
    zones: scn.zones.map((z: any) => ({ ...z, owner: z.owner ?? null, p: z.owner === 0 ? 1 : z.owner === 1 ? -1 : 0 })),
    side: [mkSide(0), mkSide(1)], weather: scn.weather ?? 'clear', over: false, result: null, ti: 0, endCheck: 0,
    fog: !!opts.fog, seen: [[], []], hist: [], chron: [], fallen: [], histT: 0,
    courier: !!opts.courier, orders: [], // orders: [{t, side, c}] still on the road, each for one regiment
  };
  const g = opts.grouchy, has = (x: any) => (!x.ifGrouchy || x.ifGrouchy === g) && (!x.unlessGrouchy || x.unlessGrouchy !== g);
  const tl = (scn.timeline ?? []).filter(has).map((e: any) => {
    let t = e.t + (e.delayIfGrouchy?.[g ?? ''] ?? 0);
    for (const [b, d] of Object.entries(e.delayIfWon ?? {})) if (opts.won?.[b]) t += d as number;
    return { ...e, t, units: e.units?.filter(has) };
  }).sort((a: any, b: any) => a.t - b.t);
  const sim: Sim = { s, scn, tu, tl };

  const pool = [...(opts.roster ?? [])];
  for (const d of expandForces(scn.forces[0])) {
    let r: any = null;
    if (d.type === 'commander') { spawn(sim, 0, d); continue; } // the commander is never part of the roster
    if (opts.roster) {
      let bi = -1;
      pool.forEach((p, i) => { if (p.type === d.type && (bi < 0 || p.men > pool[bi].men)) bi = i; });
      if (bi < 0) continue; // roster has no such unit left
      r = pool.splice(bi, 1)[0];
    }
    spawn(sim, 0, { ...d, ...(r ? { name: r.name, men: r.men, maxMen: r.maxMen, rid: r.rid, xp: r.xp ?? 0 } : {}) });
  }
  for (const d of expandForces(scn.forces[1])) spawn(sim, 1, d);
  if (opts.deploy) { s.phase = 'deploy'; s.deploy = [0, 1].map((i) => s.units.filter((u: any) => u.side === i).map((u: any) => ({ x: u.x, z: u.z, r: tu.deploy.r }))); } // each side may place its army within reach of where it starts; scripted reinforcements come later and don't count
  // war chest: a finite pool of replacement men, and a cap on RP earned from objectives (enough for the listed reserves plus the pool), so refills can't be farmed
  for (let i = 0; i < 2; i++) {
    const sd = s.side[i], men = s.units.filter((u: any) => u.side === i && u.type !== 'commander').reduce((a: number, u: any) => a + u.maxMen, 0);
    const res = Object.entries(sd.reserves).reduce((a: number, [t, n]: any) => a + n * tu.types[t].cost, 0);
    sd.pool = scn.replacements?.[i] ?? Math.round(tu.replacePool * men);
    sd.cap = scn.rpCap?.[i] ?? Math.round(res + sd.pool * (tu.types.line.cost / tu.types.line.men) * 1.5); sd.earned = 0;
  }
  log(sim, scn.title + ' — the battle begins.');
  return sim;
}

export function log(sim: Sim, msg: string) {
  sim.s.log.push({ t: sim.s.t, msg });
  if (sim.s.log.length > 60) sim.s.log.shift();
}
function ev(sim: Sim, e: any) {
  sim.s.events.push(e);
  if (sim.s.events.length > 400) sim.s.events.shift();
}

const rankOf = (tu: any, xp: number) => tu.veterancy.xp.filter((q: number) => xp >= q).length;
export const garrisonable = (v: any) => !!v.garrison;

export function spawn(sim: Sim, side: number, d: any) {
  const T = sim.tu.types[d.type];
  const u = {
    id: sim.s.nextId++, side, type: d.type, name: d.name ?? T.label, nat: d.nat ?? natOf(sim.scn, side),
    men: d.men ?? Math.round(T.men * (sim.scn.strength?.[side] ?? 1)), maxMen: d.maxMen ?? Math.round(T.men * (sim.scn.strength?.[side] ?? 1)), x: d.x, z: d.z, facing: side === 0 ? Math.PI : 0,
    form: d.form ?? 'line', morale: T.morale, maxMorale: T.morale, routed: false,
    tx: null as number | null, tz: null as number | null, chase: null as number | null,
    reload: rand(sim.s) * (T.reload || 1), busy: 0, hurt: 99, fired: 99, mv: false, eng: null as number | null,
    rid: d.rid ?? null, dead: false, path: null as number[][] | null,
    spReady: 0, spUntil: 0, spKind: '', acc: 0, accT: 0,
    xp: d.xp ?? 0, vet: rankOf(sim.tu, d.xp ?? 0), stance: 'hold', auto: false, sq: false, cavSeen: -99, queue: [] as number[][],
    garrison: null as number | null, gTarget: null as number | null, aura: false, flankT: -99, refill: false, tf: null as number | null, am: false, march: false, draftFor: null as number | null, refilled: 0, still: 0,
    fat: 0, mcap: T.morale, bay: null as number | null, tested: false, limbered: false, limT: 0, stun: 0, shaken: 0, // stun: seconds left stunned by a cavalry charge; shaken: seconds left rattled by fire; fatigue 0..1, morale ceiling, bayonet-charge target, charge morale test done, guns hooked to their teams, seconds left limbering/unlimbering
  };
  sim.s.units.push(u);
  return u;
}

// ---------------------------------------------------------------- commands
export type Cmd =
  | { c: 'move'; ids: number[]; x: number; z: number; q?: boolean; f?: number; w?: number; am?: boolean; col?: boolean; keep?: boolean; run?: boolean; pace?: number | null } // f: facing on arrival (radians), w: frontage to spread the group over, am: attack-move (fight what is met on the way), col: march in column, keep: move as a block, run: double time; pace is the sim's own (a courier carries the group's pace), never sent
  | { c: 'face'; ids: number[]; x: number; z: number } // wheel in place toward the point
  | { c: 'stance'; ids: number[]; s: string }
  | { c: 'auto'; ids: number[] }
  | { c: 'replenish'; ids: number[] }
  | { c: 'garrison'; ids: number[]; vid: number }
  | { c: 'attack'; ids: number[]; target: number }
  | { c: 'bayonet'; ids: number[]; target: number } // line/guard (not in square) charge at the run; the target takes a morale test as they close
  | { c: 'form'; ids: number[]; f: string }
  | { c: 'stop'; ids: number[] }
  | { c: 'special'; ids: number[] }
  | { c: 'ability'; name: string; x: number; z: number }
  | { c: 'deploy'; type: string }
  | { c: 'place'; ids: number[]; x: number; z: number; f?: number; w?: number } // deployment phase: stand the group there at once, laid out like a move (f, w: a dragged line), facing the enemy
  | { c: 'start' }; // deployment phase: the clock starts

const GO = ['move', 'attack', 'bayonet', 'stop', 'face', 'garrison']; // orders that replace each other

/** now: apply at once (a courier has just arrived with it, see step). */
export function command(sim: Sim, side: number, c: Cmd, now = false) {
  const s = sim.s;
  if (s.over) return;
  const mine = (ids: number[]) => ids.map((id) => s.units.find((u: any) => u.id === id && u.side === side && !u.dead && !u.routed)).filter(Boolean);
  const half = sim.scn.map.size / 2 - 2;
  if (s.courier && !now && s.phase !== 'deploy' && 'ids' in c && c.c !== 'auto' && c.c !== 'replenish') { // (while deploying the clock is stopped and the army stands ready: orders are instant) // courier orders: each regiment gets its own copy, resolved now (a move's place in the group, its pace) and delivered when the rider arrives
    const us = mine(c.ids), ps: any[] = c.c === 'move' ? layout(us, c, sim.tu, half) : us.map((u: any) => ({ u })), pace = c.c === 'move' ? c.pace ?? groupPace(ps, c, sim.tu) : null;
    for (const p of ps) {
      const one: any = c.c === 'move' ? { ...c, ids: [p.u.id], x: p.x, z: p.z, f: p.f ?? undefined, w: undefined, keep: false, pace } : { ...c, ids: [p.u.id] };
      if (!(c as any).q) s.orders = s.orders.filter((o: any) => o.c.ids[0] !== p.u.id || (o.c.c !== c.c && !(GO.includes(o.c.c) && GO.includes(c.c)))); // a new order countermands the one still on the road
      const t = courierDelay(sim, p.u);
      if (t > 0) s.orders.push({ t: s.t + t, side, c: one }); else command(sim, side, one, true);
    }
    return;
  }
  if (c.c === 'move') {
    const us = mine(c.ids);
    if (!us.length) return;
    const ps = layout(us, c, sim.tu, half), pace = c.pace ?? groupPace(ps, c, sim.tu), tu = sim.tu;
    for (const { u, x: tx, z: tz, f } of ps) {
      u.tf = f;
      if (c.q && u.tx != null && u.chase == null) { if (u.queue.length < 6) u.queue.push([tx, tz]); } // shift-click: add a waypoint
      else {
        u.tx = tx; u.tz = tz; u.queue = []; u.chase = null; u.garrison = u.gTarget = null; u.am = !!c.am; u.pace = pace; u.run = !!c.run;
        const d = Math.hypot(tx - u.x, tz - u.z) || 1;
        u.back = u.type !== 'artillery' && !(tu.types[u.type].cav && u.eng != null) && d < tu.fallback.dist && ((tx - u.x) * Math.sin(u.facing) + (tz - u.z) * Math.cos(u.facing)) / d < -0.5; // a short step to the rear: fall back facing the enemy (horse in a melee breaks off instead)
        if (inColumn(u, c, d, tu)) { u.dep = u.form; u.form = 'column'; u.busy = tu.formChangeTime; } // deploys again on arrival (see step)
      }
    }
  } else if (c.c === 'attack') {
    if (!s.units.some((u: any) => u.id === c.target && u.side !== side && !u.dead)) return;
    for (const u of mine(c.ids)) { u.chase = c.target; u.tx = u.tz = null; u.queue = []; u.garrison = u.gTarget = null; u.am = false; u.tf = null; }
  } else if (c.c === 'bayonet') {
    if (!s.units.some((u: any) => u.id === c.target && u.side !== side && !u.dead && !u.routed)) return;
    for (const u of mine(c.ids)) if (isInf(u) && u.form !== 'square') { u.chase = u.bay = c.target; u.tested = false; u.tx = u.tz = null; u.queue = []; u.garrison = u.gTarget = null; u.am = false; u.tf = null; }
  } else if (c.c === 'form') {
    for (const u of mine(c.ids)) {
      u.dep = null; // an explicit formation overrides deploying on arrival
      if ((u.type === 'line' || u.type === 'guard') && u.form !== c.f && sim.tu.formFire[c.f] && !(u.stun > 0) && !(u.shaken > 0)) { u.form = c.f; u.busy = sim.tu.formChangeTime; } // a regiment stunned by a charge or shaken by fire cannot reform
    }
  } else if (c.c === 'stop' || c.c === 'face') { // face: halt and wheel toward the point (the arrival wheel in step)
    for (const u of mine(c.ids)) { u.tx = u.tz = u.chase = null; u.queue = []; u.garrison = u.gTarget = null; u.am = false; u.tf = c.c === 'face' ? Math.atan2(c.x - u.x, c.z - u.z) : null; }
  } else if (c.c === 'stance') {
    for (const u of mine(c.ids)) u.stance = c.s === 'aggressive' || c.s === 'skirmish' || (c.s === 'holdfire' && (isInf(u) || u.type === 'artillery')) ? c.s : 'hold';
  } else if (c.c === 'auto') {
    const us = mine(c.ids).filter(isInf), on = !us.every((u: any) => u.auto);
    for (const u of us) u.auto = on;
  } else if (c.c === 'replenish') { // on an objective we hold (a depot) men trickle in, a toggle (see step); anywhere else a draft marches from our map edge at refillOffCost x the price
    const us = mine(c.ids).filter((u: any) => u.type !== 'commander' && u.men < u.maxMen && u.draftFor == null), dep = us.filter((u: any) => held(s, u)), on = !dep.every((u: any) => u.refill);
    for (const u of dep) u.refill = on;
    for (const u of us) {
      if (held(s, u) || s.units.some((d: any) => d.draftFor === u.id && !d.dead)) continue; // one draft at a time
      const sd = s.side[side], per = manPrice(sim.tu, u) * sim.tu.refillOffCost, men = Math.min(u.maxMen - u.men, Math.floor(sd.rp / per), Math.floor(sd.pool));
      if (men < u.maxMen * 0.05) continue; // can't afford a useful draft (or the depots are empty)
      sd.rp -= men * per; sd.pool -= men; u.refilled += men;
      const p = homeEdge(sim, side, u.x, u.z), d = spawn(sim, side, { type: u.type, name: `Draft for ${u.name}`, men, maxMen: men, x: p.x, z: p.z, nat: u.nat, form: isInf(u) ? 'column' : undefined });
      d.draftFor = u.id; d.tx = u.x; d.tz = u.z;
      log(sim, `A draft of ${men} men marches to ${u.name}.`);
    }
  } else if (c.c === 'garrison') {
    const v = (sim.scn.map.villages ?? [])[c.vid];
    if (!v || !garrisonable(v)) return;
    const held = s.units.filter((q: any) => q.side === side && (q.garrison === c.vid || q.gTarget === c.vid) && !c.ids.includes(q.id)).length; // on the way counts too (courier orders arrive one by one)
    let free = sim.tu.garrison.capacity - held;
    for (const u of mine(c.ids)) {
      if (!(isInf(u) || u.type === 'skirmisher') || free <= 0) continue;
      free--; u.chase = null; u.am = false; u.queue = []; u.garrison = null; u.gTarget = c.vid; u.tx = v.x + (free ? -1.8 : 1.8); u.tz = v.z + 0.8; u.pace = null; u.run = u.back = false;
    }
  } else if (c.c === 'special') {
    for (const u of mine(c.ids)) {
      const sp = sim.tu.specials?.[u.type];
      if (!sp || s.t < u.spReady) continue;
      u.spReady = s.t + sp.cd; u.spUntil = s.t + sp.dur; u.spKind = sp.kind;
      if (sp.kind === 'volley') u.reload = 0;
      if (sp.kind === 'charge') u.tested = false; // this charge's shock test is still to come
      if (sp.kind === 'rally') { // commander: broken men nearby rally, the rest steady
        const ca = sim.tu.commanderAura;
        for (const q of s.units) if (q.side === side && !q.dead && q !== u && Math.hypot(q.x - u.x, q.z - u.z) < ca.rallyRadius) { if (q.routed) { q.routed = false; q.morale = Math.max(q.morale, 45); ev(sim, { k: 'rally', x: q.x, z: q.z }); } else if (q.morale < mcap(q, sim.tu)) q.morale = Math.min(mcap(q, sim.tu), q.morale + 30); }
      }
      ev(sim, { k: 'special', x: u.x, z: u.z, side, kind: sp.kind, name: u.name });
    }
  } else if (c.c === 'ability') useAbility(sim, side, c.name, c.x, c.z);
  else if (c.c === 'deploy') deploy(sim, side, c.type);
  else if (s.phase !== 'deploy') return; // placing and starting belong to the deployment phase
  else if (c.c === 'start') s.phase = 'battle';
  else if (c.c === 'place') {
    const fo = s.units.filter((u: any) => u.side !== side), n = fo.length || 1;
    const fe = Math.atan2(fo.reduce((a: number, u: any) => a + u.x, 0) / n - c.x, fo.reduce((a: number, u: any) => a + u.z, 0) / n - c.z);
    const f = c.f == null ? fe : Math.cos(c.f - fe) < 0 ? c.f + Math.PI : c.f; // a dragged line keeps its line, but fronts the enemy
    command(sim, side, { c: 'move', ids: c.ids, x: c.x, z: c.z, f, w: c.w }, true); // the move order's layout gives each regiment its spot
    for (const u of mine(c.ids)) {
      if (s.deploy[side].some((d: any) => Math.hypot(u.tx - d.x, u.tz - d.z) < d.r)) { u.x = u.tx; u.z = u.tz; u.facing = f; } // a spot outside the zone: that regiment stays put
      u.tx = u.tz = u.tf = null;
    }
  }
}

/** Where each regiment of a move order stands and faces (f null: no ordered facing). Side by side across the order's facing by real frontage, a wider drag spreading them out;
 *  keep: the group moves as a block, each keeping its offset from the centre and its facing, the whole block turned onto a dragged facing. Pure, so the UI can preview it. */
export function layout(us: any[], c: { x: number; z: number; f?: number; w?: number; keep?: boolean }, tu: any, half: number): { u: any; x: number; z: number; f: number | null }[] {
  const cx = us.reduce((a: number, u: any) => a + u.x, 0) / us.length, cz = us.reduce((a: number, u: any) => a + u.z, 0) / us.length, cl = (v: number) => Math.max(-half, Math.min(half, v));
  if (c.keep) {
    const r = c.f == null ? 0 : c.f - Math.atan2(us.reduce((a: number, u: any) => a + Math.sin(u.facing), 0), us.reduce((a: number, u: any) => a + Math.cos(u.facing), 0)), sn = Math.sin(r), cs = Math.cos(r);
    return us.map((u: any) => ({ u, x: cl(c.x + (u.x - cx) * cs + (u.z - cz) * sn), z: cl(c.z + (u.z - cz) * cs - (u.x - cx) * sn), f: u.facing + r }));
  }
  let dx = c.x - cx, dz = c.z - cz;
  const d = Math.hypot(dx, dz) || 1;
  dx /= d; dz /= d;
  if (c.f != null) { dx = Math.sin(c.f); dz = Math.cos(c.f); } // a dragged line: lay the group out across the chosen facing
  const ss = [...us].sort((a: any, b: any) => (a.x * -dz + a.z * dx) - (b.x * -dz + b.z * dx));
  // side by side by real frontage (and never closer than the idle spacing rule), so a group arrives without piling up
  const hw = ss.map((u: any) => { const f = foot(u, tu); return Math.max((f[1] - f[0]) / 2 + 2, 0.7 * rad(u) + 0.5); });
  const sum = hw.reduce((a: number, b: number) => a + b, 0), extra = c.w && ss.length > 1 ? Math.max(0, c.w - 2 * sum) / (ss.length - 1) : 0;
  let acc = -sum - (extra * (ss.length - 1)) / 2;
  return ss.map((u: any, i: number) => { const off = acc + hw[i]; acc += 2 * hw[i] + extra; return { u, x: cl(c.x - dz * off), z: cl(c.z + dx * off), f: c.f ?? null }; });
}
/** u's marching speed in formation `form`, before ground, weather and fatigue */
const marchSpeed = (u: any, form: string, tu: any) => tu.types[u.type].speed * (isInf(u) ? tu.formSpeed[form] : 1);
/** March in column: a line sent farther than tuning.march.dist forms column for the march (stunned or shaken men cannot reform) */
const inColumn = (u: any, c: any, d: number, tu: any) => !!c.col && isInf(u) && u.form === 'line' && d > tu.march.dist && !(u.stun > 0) && !(u.shaken > 0);
/** A group order keeps to its slowest member's pace, each in the formation it will march in; null for one regiment */
const groupPace = (ps: any[], c: any, tu: any) => ps.length > 1 ? Math.min(...ps.map((p: any) => marchSpeed(p.u, inColumn(p.u, c, Math.hypot(p.x - p.u.x, p.z - p.u.z), tu) ? 'column' : p.u.form, tu))) : null;
/** Seconds a courier needs to reach u from its side's nearest general (the entry point once all have fallen); <= 0 within tuning.courier.free */
function courierDelay(sim: Sim, u: any) {
  const gs = sim.s.units.filter((g: any) => g.side === u.side && g.type === 'commander' && !g.dead), k = sim.tu.courier;
  return (Math.min(...(gs.length ? gs : [sim.scn.entry[u.side]]).map((g: any) => Math.hypot(g.x - u.x, g.z - u.z))) - k.free) / k.speed;
}

/** RP for one replacement man: a whole regiment at its deploy price, rising as the regiment has already been topped up (refillRise 1 = +50% after half its strength) */
export const manPrice = (tu: any, u: any) => (tu.types[u.type].cost / u.maxMen) * (1 + (tu.refillRise * (u.refilled ?? 0)) / u.maxMen);
/** standing on an objective its side holds: a depot, where replacements trickle in */
const held = (s: any, u: any) => s.zones.some((z: any) => z.owner === u.side && Math.hypot(u.x - z.x, u.z - z.z) < z.r);
/** the point on a side's home map edge (the one its entry point lies by) nearest to (x, z): drafts set out from there */
function homeEdge(sim: Sim, side: number, x: number, z: number) {
  const e = sim.scn.entry[side], h = sim.scn.map.size / 2 - 4;
  return Math.abs(e.z) >= Math.abs(e.x) ? { x: Math.max(-h, Math.min(h, x)), z: Math.sign(e.z || 1) * h } : { x: Math.sign(e.x) * h, z: Math.max(-h, Math.min(h, z)) };
}
function entryPoint(sim: Sim, side: number) {
  const e = sim.scn.entry[side];
  return { x: e.x + (rand(sim.s) - 0.5) * 30, z: e.z };
}

export function deploy(sim: Sim, side: number, type: string): boolean {
  const sd = sim.s.side[side], T = sim.tu.types[type];
  if (!T || (sd.reserves[type] ?? 0) <= 0 || sd.rp < T.cost || sim.s.over) return false;
  sd.rp -= T.cost;
  sd.reserves[type]--;
  // arrive at the objective we hold nearest our entry (not one under attack); with none, march on from the map edge
  const g = sim.scn.entry[side], base = sim.s.zones.filter((z: any) => z.owner === side && !z.contested).sort((a: any, b: any) => Math.hypot(a.x - g.x, a.z - g.z) - Math.hypot(b.x - g.x, b.z - g.z))[0];
  const p = base ? { x: base.x + (rand(sim.s) - 0.5) * base.r, z: base.z } : entryPoint(sim, side);
  const u = spawn(sim, side, { type, name: `Reserve ${T.label}`, x: p.x, z: p.z });
  if (!base) { u.tx = g.x; u.tz = g.z + (side === 0 ? -25 : 25); }
  log(sim, `${side === 0 ? 'French' : 'Coalition'} reserve arrives: ${T.label}.`);
  ev(sim, { k: 'arrive', side, names: [u.name], types: [type] });
  return true;
}

export function useAbility(sim: Sim, side: number, name: string, x: number, z: number): boolean {
  const ab = sim.tu.abilities[name], sd = sim.s.side[side];
  if (!ab || !sim.scn.abilities?.[side]?.includes(name) || (sd.cd[name] ?? 0) > 0 || sim.s.over) return false;
  const h = sim.scn.map.size / 2 - 2;
  x = Math.max(-h, Math.min(h, x)); z = Math.max(-h, Math.min(h, z));
  sd.cd[name] = ab.cd;
  ev(sim, { k: 'aid', name, side, x, z });
  if (name === 'cavalry') {
    const p = entryPoint(sim, side);
    const u = spawn(sim, side, { type: ab.unit, name: sim.scn.cavalryName?.[side] ?? 'Cavalry Reserve', men: ab.men, maxMen: ab.men, x: p.x, z: p.z });
    u.tx = x; u.tz = z;
    log(sim, `${side === 0 ? 'French' : 'Coalition'} reserve cavalry charges forward!`);
  } else {
    sim.s.fx.push({ kind: name, side, x, z, t: 0, acc: 0 });
    log(sim, `${ab.label} ${side === 0 ? 'ordered by the French' : 'ordered by the Coalition'}.`);
  }
  return true;
}

// ---------------------------------------------------------------- core helpers
/** footprint radius grows with strength (a 540-man square is ~19 wide); contact is when the edges meet, not the centres */
const rad = (u: any) => (1.4 + 0.33 * Math.sqrt(Math.max(0, u.men))) * 1.3; // 1.3 = tuning.figScale
/** Formation footprint in the unit's local frame [x0, x1, z0, z1] (x = right, z = forward; the unit position is its front rank). Mirrors the renderer's slots. */
export function foot(u: any, tu: any): number[] { const k = tu.figScale ?? 1; return foot0(u, tu).map((v) => v * k); }
function foot0(u: any, tu: any): number[] {
  const T = tu.types[u.type];
  if (u.type === 'artillery') { const w = ((Math.max(1, Math.ceil(u.men / 54)) - 1) / 2) * 4.2 + 2.8; return [-w, w, -4, 2.2]; }
  if (u.routed || u.type === 'skirmisher') return [-8, 8, -3.5, 3.5];
  const n = Math.max(1, Math.ceil(u.men / T.perFig));
  if (T.cav) { const cols = n > 10 ? Math.ceil(n / 2) : n, rows = Math.ceil(n / cols), w = ((cols - 1) / 2) * 2.4 + 1.2; return [-w, w, -(rows - 1) * 3 - 1.6, 1.6]; }
  if (u.form === 'column') { const rows = Math.ceil(n / 3); return [-2.2, 2.2, -(rows - 1) * 1.5 + n / 6 - 0.7, n / 6 + 0.7]; }
  if (u.form === 'square') { const h = (Math.max(2, Math.ceil(n / 4) + 1) - 1) * 0.8 + 0.7; return [-h, h, -h, h]; }
  const ranks = n > 24 ? 3 : 2, w = ((Math.ceil(n / ranks) - 1) / 2) * 1.3 + 0.7;
  return [-w, w, -(ranks - 1) * 1.5 - 0.7, 0.7];
}
const toLocal = (u: any, x: number, z: number) => { const s = Math.sin(u.facing), c = Math.cos(u.facing), dx = x - u.x, dz = z - u.z; return [dx * c - dz * s, dx * s + dz * c]; };
/** Distance from a ground point to a unit's formation footprint (0 = inside it): lets clicks hit any soldier of a formation. */
export function distToFoot(u: any, tu: any, x: number, z: number): number { const [lx, lz] = toLocal(u, x, z); return rectDist(foot(u, tu), lx, lz); }
const rectDist = (f: number[], lx: number, lz: number) => Math.hypot(lx - Math.max(f[0], Math.min(f[1], lx)), lz - Math.max(f[2], Math.min(f[3], lz)));
/** Distance between two formations' edges (<= 0 means they overlap). */
function gapBetween(a: any, b: any, tu: any): number {
  if (Math.hypot(a.x - b.x, a.z - b.z) > 170) return 1e9;
  const fa = foot(a, tu), fb = foot(b, tu);
  let m = 1e9;
  for (const [p, q, fp, fq] of [[a, b, fa, fb], [b, a, fb, fa]] as any[]) {
    const sn = Math.sin(p.facing), cs = Math.cos(p.facing);
    for (const lx of [fp[0], (fp[0] + fp[1]) / 2, fp[1]]) for (const lz of [fp[2], (fp[2] + fp[3]) / 2, fp[3]]) {
      const [qx, qz] = toLocal(q, p.x + lx * cs + lz * sn, p.z - lx * sn + lz * cs);
      m = Math.min(m, rectDist(fq, qx, qz));
    }
  }
  return m;
}
/** Loose bodies (skirmishers, a general's staff) slip through their own side's ranks; everyone else must go round. */
const slips = (u: any, o: any) => u.side === o.side && (u.type === 'skirmisher' || o.type === 'skirmisher' || u.type === 'commander' || o.type === 'commander');
/** Formations are solid: the regiment u would run into by standing at (x, z) instead of where it is, or null. Stepping into contact is refused; once touching, only
 *  steps that don't close on the other's centre are allowed (so a unit can always back off or slide along). Broken men and garrisons don't block. */
function blocker(u: any, x: number, z: number, live: any[], tu: any, fr: Map<any, number>, friends = true): any {
  const ox = u.x, oz = u.z, ru = fr.get(u)!;
  for (const o of live) {
    if (o === u || o.dead || o.routed || o.garrison != null || slips(u, o) || (!friends && o.side === u.side) || Math.hypot(o.x - x, o.z - z) > ru + fr.get(o)! + 1) continue; // bounding circles apart: can't touch
    u.x = x; u.z = z; const g1 = gapBetween(u, o, tu); u.x = ox; u.z = oz;
    if (g1 > 0) continue;
    if (gapBetween(u, o, tu) > 0 || Math.hypot(o.x - x, o.z - z) < Math.hypot(o.x - ox, o.z - oz) - 1e-6) return o;
  }
  return null;
}
const isInf = (u: any) => u.type === 'line' || u.type === 'guard';
/** Hour of day on the scenario clock ('HH:MM' start, then `hours` over `duration` s) at battle time t. */
export const hour = (scn: any, t: number) => { const [h, m] = (scn.clock?.start ?? '12:00').split(':').map(Number); return h + (m || 0) / 60 + (t / scn.duration) * (scn.clock?.hours ?? 0); };
/** Darkness 0 (day) .. 1 (night) from the scenario clock (tuning.night). */
export const dark = (sim: Sim) => { const n = sim.tu.night; return Math.max(0, Math.min(1, (hour(sim.scn, sim.s.t) - n.dusk) / (n.dark - n.dusk))); };
/** eye height above the ground for sight lines (riders sit higher); targets are seen at 2 */
const eye = (u: any, tu: any) => (tu.types[u.type].cav ? 3 : 2);
/** movement multiplier from the ground under u (tuning.terrain): woods and villages by arm, wading, roads for columns, guns and horse not in a fight */
function terrainSpeed(u: any, f: any, tu: any) {
  const tt = tu.terrain, T = tu.types[u.type], arm = T.cav ? 'cavalry' : u.type === 'artillery' || u.type === 'skirmisher' ? u.type : 'infantry';
  return (f.wood ? tt.wood[arm] : 1) * (f.village ? tt.village[arm] : 1) * (f.river ? f.river.ford ?? tt.river : 1) * (f.road && u.eng == null && (T.cav || u.type === 'artillery' || u.form === 'column') ? tt.road : 1);
}

function damage(sim: Sim, u: any, cas: number, moraleScale = 1, att?: any) {
  if (u.dead) return;
  const tu = sim.tu, s = sim.s;
  cas = Math.min(cas, u.men);
  u.men -= cas;
  s.side[u.side].lost += cas;
  s.side[1 - u.side].score += cas * tu.casualtyScore;
  u.morale -= (cas / u.maxMen) * tu.moraleLoss * moraleScale * (1 - u.vet * tu.veterancy.resist) * (u.aura ? tu.commanderAura.resist : 1) * (u.garrison != null ? tu.garrison.morale : 1) * (posted(u, tu) ? tu.hold.morale : 1);
  u.hurt = 0; u.acc += cas;
  if (att && !att.dead) { // inflicting casualties earns rank
    att.xp += cas;
    const r = rankOf(tu, att.xp);
    if (r > att.vet) { att.vet = r; log(sim, `${att.name} is now ${['', 'seasoned', 'veteran', 'elite'][r]}!`); ev(sim, { k: 'rank', x: att.x, z: att.z, side: att.side, name: att.name, vet: r }); chron(sim, att.side, `${att.name} became ${['', 'seasoned', 'veteran', 'elite'][r]}`); }
  }
  if (u.men <= u.maxMen / 120) {
    u.dead = true; u.fate = 'dead';
    ev(sim, { k: 'dead', x: u.x, z: u.z, side: u.side, name: u.name }); log(sim, `${u.name} is destroyed!`);
    s.fallen.push({ name: u.name, side: u.side, type: u.type, t: Math.round(s.t) }); chron(sim, u.side, `${u.name} destroyed`);
    if (u.type === 'commander') { log(sim, `${u.name} has fallen!`); for (const f of s.units) if (f.side === u.side && !f.dead) f.morale -= tu.commanderAura.fallPenalty; }
  }
}
/** Rattle u for `secs` more seconds (tuning.shaken: slower reload, weaker fire, no reforming), up to the cap. */
function shake(u: any, secs: number, tu: any) { if (!u.dead && !u.routed && secs > 0) u.shaken = Math.min(tu.shaken.max, (u.shaken ?? 0) + secs); }
/** A blow from fire: damage(), then a shake in proportion to the share of the regiment it took (plus `extra` s). Returns that share. */
function hit(sim: Sim, tg: any, cas: number, moraleScale: number, att: any, extra: number): number {
  const m0 = Math.max(1, tg.men);
  damage(sim, tg, cas, moraleScale, att);
  const bite = (m0 - Math.max(0, tg.men)) / m0;
  shake(tg, bite * sim.tu.shaken.k + extra, sim.tu);
  return bite;
}
/** tg is behind its own skirmish screen as u sees it: one of its side's skirmishers stands across the last stretch of the line of fire */
function screened(sim: Sim, u: any, tg: any) {
  return tg.type !== 'skirmisher' && sim.s.units.some((f: any) => f.side === tg.side && f.type === 'skirmisher' && !f.dead && !f.routed && Math.hypot(f.x - tg.x, f.z - tg.z) < 45
    && [0.6, 0.75, 0.9].some((k) => distToFoot(f, sim.tu, u.x + (tg.x - u.x) * k, u.z + (tg.z - u.z) * k) < 1));
}
/** 0 front, 1 flank, 2 rear: where the attacker stands relative to the target's facing (squares, garrisons and broken men have no flanks) */
function aspect(att: any, tg: any): number {
  if (tg.form === 'square' || tg.garrison != null || tg.routed) return 0;
  const dx = att.x - tg.x, dz = att.z - tg.z, d = Math.hypot(dx, dz) || 1, c = (dx * Math.sin(tg.facing) + dz * Math.cos(tg.facing)) / d;
  return c > 0.5 ? 0 : c < -0.5 ? 2 : 1;
}
function chron(sim: Sim, side: number, text: string) {
  const c = sim.s.chron; c.push({ t: Math.round(sim.s.t), side, text }); if (c.length > 60) c.shift();
}

/** A friendly regiment stands across the line of fire from u to e (muskets can't shoot through their own men; guns fire over them). */
export function masked(u: any, e: any, live: any[], tu: any) {
  if (u.type === 'artillery') return false;
  return live.some((f: any) => f !== u && f.side === u.side && !f.dead && !f.routed && Math.hypot(f.x - (u.x + e.x) / 2, f.z - (u.z + e.z) / 2) < Math.hypot(e.x - u.x, e.z - u.z) / 2 + 30
    && [0.25, 0.5, 0.75].some((k) => distToFoot(f, tu, u.x + (e.x - u.x) * k, u.z + (e.z - u.z) * k) < 0.5));
}
/** How solid a square is against cavalry: 1 when it has at least as many men as the horsemen, fading fast (ratio squared) as it is outnumbered. */
export const solid = (sq: any, cav: any) => Math.min(1, sq.men / Math.max(1, cav.men)) ** 2;
function meleeMult(a: any, d: any): number {
  if (d.routed) return 1.5;
  const ac = a.type === 'lancer' || a.type === 'cuirassier';
  const dc = d.type === 'lancer' || d.type === 'cuirassier';
  if (ac) {
    if (d.type === 'artillery') return 2.5;
    if (d.type === 'skirmisher') return 2.2;
    if (dc) return 1;
    return d.form === 'square' ? 1.2 - 0.95 * solid(d, a) : d.form === 'column' ? 2 : 1.2; // full square 0.25, a swamped one is just a line (1.2)
  }
  if (dc) return a.form === 'square' ? 1 + 0.6 * solid(a, d) : a.form === 'column' ? 0.5 : a.type === 'skirmisher' ? 0.3 : 1;
  if (d.type === 'artillery') return 2;
  return 1;
}
/** Posted: formed foot or guns that have stood still a while (tuning.hold.after) have dressed their ranks, found the folds of the ground and lie down between volleys */
export const posted = (u: any, tu: any) => (u.still ?? 0) >= tu.hold.after && !u.routed && !tu.types[u.type].cav;
/** Morale ceiling: a regiment that has lost men can't get back to its full spirit (tuning.morale.cap). */
const mcap = (u: any, tu: any) => u.maxMorale * (1 - tu.morale.cap * (1 - Math.min(1, u.men / u.maxMen)));
/** u's charge was shot to pieces on the way in (tuning.falter): it still comes on, without its momentum */
const faltered = (u: any, s: any, tu: any) => s.t - (u.falter ?? -99) < tu.falter.time;
/** Horse ordered away from foe f while in contact with it (a move order pointing away, no attack order): it is breaking off. */
const breakingOff = (q: any, f: any, tu: any) => tu.types[q.type].cav && q.tx != null && q.chase == null && (q.tx - q.x) * (f.x - q.x) + (q.tz - q.z) * (f.z - q.z) < 0;
/** Wheel u toward angle a at its rate (tuning.turn); returns the angle still left to turn. */
function face(u: any, a: number, dt: number, tu: any, rate?: number): number {
  const r = rate ?? tu.turn[tu.types[u.type].cav ? 'cavalry' : isInf(u) ? u.form : u.type] ?? 1, d = Math.atan2(Math.sin(a - u.facing), Math.cos(a - u.facing)), k = Math.max(-r * dt, Math.min(r * dt, d));
  u.facing += k;
  return Math.abs(d - k);
}
/** Morale test for d as a charge by a closes in (tuning.shock): true = it stands. */
export function steady(sim: Sim, d: any, a: any): boolean {
  const tu = sim.tu, k = tu.shock, cav = tu.types[a.type].cav && !tu.types[d.type].cav && d.form !== 'square';
  const st = Math.max(0, d.morale) / d.maxMorale - k.loss * (1 - d.men / d.maxMen) - k.fat * d.fat + (d.form === 'square' ? k.square : 0) + (d.garrison != null ? k.garrison : 0) - k.flank[aspect(a, d)]
    - k.size * Math.max(0, Math.min(1, a.men / Math.max(1, d.men) - 1)) - k.fresh * Math.max(0, d.fat - a.fat) + k.vet * d.vet + (d.aura ? k.aura : 0) - (cav ? k.cav : 0) + (posted(d, tu) ? tu.hold.shock : 0) + k.spread * (rand(sim.s) - 0.5);
  return st >= k.pass;
}
/** A charge closes on d: d breaks, or stands and gives a closing volley that may throw the charger (a) back. */
function shock(sim: Sim, a: any, d: any): 'broke' | 'recoil' | 'melee' {
  const tu = sim.tu, T = tu.types[d.type];
  a.tested = true;
  if (!steady(sim, d, a)) { d.morale = Math.min(d.morale, 0); log(sim, `${d.name} breaks before the charge of ${a.name}!`); chron(sim, a.side, `${d.name} broke before ${a.name}'s charge`); return 'broke'; }
  if (T.range > 0 && d.busy <= 0 && !d.limbered && d.limT <= 0 && aspect(a, d) === 0) shoot(sim, d, a, 0); // held fire for the point-blank volley (a flanked line can't turn its muskets)
  if (a.dead || steady(sim, a, d)) return 'melee';
  const dx = a.x - d.x, dz = a.z - d.z, l = Math.hypot(dx, dz) || 1, h = sim.scn.map.size / 2 - 2;
  a.chase = a.bay = null; a.spUntil = 0; a.queue = []; a.am = false;
  a.tx = Math.max(-h, Math.min(h, a.x + (dx / l) * tu.bayonet.recoil)); a.tz = Math.max(-h, Math.min(h, a.z + (dz / l) * tu.bayonet.recoil));
  log(sim, `${a.name}'s charge is thrown back by ${d.name}!`);
  return 'recoil';
}

/** Powder smoke blocks sight and fire: four or more puffs on the line between two points hide the target. */
function smokeBlocked(sim: Sim, ax: number, az: number, bx: number, bz: number): boolean {
  const r = sim.tu.smoke.radius * 0.5, dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
  let n = 0;
  for (const p of sim.s.smoke) {
    const t = ((p.x - ax) * dx + (p.z - az) * dz) / L2;
    if (t < 0.15 || t > 0.85) continue; // smoke at the shooter's own muzzle or the target itself does not count
    const px = ax + t * dx - p.x, pz = az + t * dz - p.z;
    if (px * px + pz * pz < r * r && ++n >= 4) return true;
  }
  return false;
}

function smokeFactor(sim: Sim, x: number, z: number) {
  let n = 0;
  const r = sim.tu.smoke.radius;
  for (const p of sim.s.smoke) if (Math.abs(p.x - x) < r && Math.abs(p.z - z) < r && Math.hypot(p.x - x, p.z - z) < r) n++;
  return 1 - 0.45 * Math.min(1, n * 0.15);
}

/** One volley (or round) from u at tg, td units off its nearest edge (0 = point blank). */
function shoot(sim: Sim, u: any, tg: any, td: number) {
  const { s, scn, tu } = sim, T = tu.types[u.type], W = tu.weather[s.weather] ?? tu.weather.clear;
  // round shot falls short or wide more often the further it flies; canister at close range always tells
  const canister = u.spUntil > s.t && u.spKind === 'canister', volley = u.spUntil > s.t && u.spKind === 'volley', close = td < tu.canisterRange * (canister ? 2.2 : 1);
  const first = u.stance === 'holdfire' && u.fired >= tu.holdFire.loaded; // a fresh, carefully loaded first volley after holding fire
  const miss = u.type === 'artillery' && !close && rand(s) > 1 - 0.65 * (td / T.range);
  const fm = u.type === 'skirmisher' || u.type === 'artillery' ? 1 : tu.formFire[u.form];
  const dmgForm = tu.types[tg.type].cav ? 0.8 : tg.type === 'skirmisher' ? 0.6 : (u.type === 'artillery' ? tu.artDmg : tu.formDmg)[tg.form]; // round shot ploughs through dense columns and squares
  const rf = Math.max(tu.rangeFloor, 1 - 0.75 * (td / T.range));
  const elev = Math.max(0.8, Math.min(1.25, 1 + 0.02 * (heightAt(scn, u.x, u.z) - heightAt(scn, tg.x, tg.z))));
  const asp = aspect(u, tg);
  if (asp && s.t - tg.flankT > 6) { tg.flankT = s.t; ev(sim, { k: 'flank', x: tg.x, z: tg.z, side: tg.side, kind: asp }); chron(sim, 1 - tg.side, `${asp === 2 ? 'Rear' : 'Flank'} fire on ${tg.name}`); }
  let cas = u.men * T.power * rf * fm * dmgForm * (tg.garrison != null ? tu.garrison.cover : featureAt(scn, tg.x, tg.z).cover) * tu.flank.dmg[asp] * (1 + u.vet * tu.veterancy.fire) * smokeFactor(sim, tg.x, tg.z) * W.fire * (1 - dark(sim) * tu.night.fire) * elev
    * (0.5 + 0.5 * Math.max(0, u.morale) / u.maxMorale) * (1 - tu.fatigue.fire * u.fat) * (posted(tg, tu) ? tu.hold.fire : 1) * (0.8 + 0.4 * rand(s))
    * (u.shaken > 0 ? tu.shaken.fire : 1) * (u.type === 'skirmisher' && tg.type === 'artillery' ? tu.screen.guns : screened(sim, u, tg) ? tu.screen.fire : 1); // rattled men shoot worse; sharpshooters pick off gun crews; a skirmish screen soaks up fire
  if (u.type === 'artillery' && close) cas *= tu.canisterMult * (canister ? 1.4 : 1);
  if (volley) { cas *= 2.2; u.spUntil = 0; }
  else if (first) cas *= tu.holdFire.first;
  if (miss) ev(sim, { k: 'boom', x: tg.x + (rand(s) - 0.5) * 16, z: tg.z + (rand(s) - 0.5) * 16 }); // the ball ploughs up the ground nearby
  else {
    const bite = hit(sim, tg, cas, tu.flank.morale[asp], u, tu.shaken.flank[asp]); // caught on the flank, men are rattled the more
    const charging = tg.bay != null || (tu.types[tg.type].cav && tg.chase != null);
    if (charging && bite >= tu.falter.share && !faltered(tg, s, tu)) { tg.falter = s.t; tg.spUntil = 0; ev(sim, { k: 'falter', x: tg.x, z: tg.z, side: tg.side }); } // a charge shot to pieces still comes on, but without its momentum (no Charge or bayonet bonus)
    if (u.type === 'artillery' && !close) { // round shot carries on through the files and strikes the next regiment in its path
      const dl = Math.hypot(tg.x - u.x, tg.z - u.z) || 1, dx = (tg.x - u.x) / dl, dz = (tg.z - u.z) / dl;
      const q = s.units.find((q: any) => q !== tg && q.side === tg.side && !q.dead && q.garrison == null && Math.hypot(q.x - tg.x, q.z - tg.z) < tu.plough.reach + 30
        && [0.25, 0.5, 0.75, 1].some((k) => distToFoot(q, tu, tg.x + dx * tu.plough.reach * k, tg.z + dz * tu.plough.reach * k) < 0.5));
      if (q) hit(sim, q, cas * tu.plough.carry, 1, u, 0);
    }
  }
  u.reload = T.reload * (0.9 + 0.2 * rand(s)) * (volley ? 1.6 : canister ? 0.6 : 1);
  u.fired = 0;
  const fx = Math.sin(u.facing), fz = Math.cos(u.facing);
  s.smoke.push({ x: u.x + fx * 3, z: u.z + fz * 3, age: 0 });
  if (s.smoke.length > tu.smoke.maxPuffs) s.smoke.shift();
  const fw = foot(u, tu); // frontage, so the renderer can ripple the volley along the whole firing line
  ev(sim, { k: 'shot', side: u.side, x: u.x, z: u.z, a: u.type === 'artillery' ? 1 : 0, tx: tg.x, tz: tg.z, w: Math.round(fw[1] - fw[0]) });
}

// ---------------------------------------------------------------- step
export function step(sim: Sim, dt: number) {
  const { s, scn, tu } = sim;
  if (s.over || s.phase === 'deploy') return; // deploying: the clock waits for 'start'
  s.t += dt;
  const W = tu.weather[s.weather] ?? tu.weather.clear;
  const half = scn.map.size / 2;

  // timeline
  while (s.ti < sim.tl.length && sim.tl[s.ti].t <= s.t) runEvent(sim, sim.tl[s.ti++]);
  // couriers arriving with their orders (see command)
  if (s.orders?.some((o: any) => o.t <= s.t)) {
    const due = s.orders.filter((o: any) => o.t <= s.t).sort((a: any, b: any) => a.t - b.t);
    s.orders = s.orders.filter((o: any) => o.t > s.t);
    for (const o of due) command(sim, o.side, o.c, true);
  }

  // economy + cooldowns
  for (let i = 0; i < 2; i++) {
    const sd = s.side[i], inc = Math.min(sd.cap - sd.earned, tu.rpPerObjective * s.zones.reduce((a: number, z: any) => a + (z.owner === i ? z.value : 0), 0) * dt); // income only from objectives held, until the battle's cap
    if (inc > 0) { sd.rp += inc; sd.earned += inc; }
    for (const k of Object.keys(sd.cd)) sd.cd[k] = Math.max(0, sd.cd[k] - dt);
  }

  const live = s.units.filter((u: any) => !u.dead);
  const byId = new Map<number, any>(live.map((u: any) => [u.id, u]));

  // history for the after-action report
  if (s.t - s.histT >= 10) { s.histT = s.t; s.hist.push({ t: Math.round(s.t), l0: Math.round(s.side[0].lost), l1: Math.round(s.side[1].lost), s0: Math.round(s.side[0].score), s1: Math.round(s.side[1].score) }); }

  // commander aura
  const ca = tu.commanderAura, cmds = live.filter((u: any) => u.type === 'commander' && !u.routed);
  for (const u of live) u.aura = u.type !== 'commander' && cmds.some((c: any) => c.side === u.side && Math.hypot(c.x - u.x, c.z - u.z) < ca.radius);

  // fog of war: an enemy is seen when one of your units is within sight with a clear line (ground, woods, smoke), or it has just fired; re-checked 4x a second
  if (!s.fog || s.t >= (s.seenT ?? 0)) {
    s.seenT = s.t + 0.25;
    const sn: number[][] = [[], []], nt = 1 - dark(sim) * tu.night.sight; // night closes in on every eye
    for (const e of live) {
      if (!s.fog) { sn[1 - e.side].push(e.id); continue; }
      const wood = featureAt(scn, e.x, e.z).kind === 'wood' ? 0.6 : 1;
      const vis = (e.fired < tu.sight.reveal) || live.some((f: any) => f.side !== e.side && Math.hypot(f.x - e.x, f.z - e.z) < (tu.sight[f.type] ?? 70) * (s.weather === 'storm' ? tu.sight.storm : s.weather === 'rain' ? tu.sight.rain : 1) * wood * nt && !smokeBlocked(sim, f.x, f.z, e.x, e.z) && los(scn, f.x, f.z, eye(f, tu), e.x, e.z, 2));
      if (vis) sn[1 - e.side].push(e.id);
    }
    s.seen = sn;
  }
  const seen: Set<number>[] = s.seen.map((a: number[]) => new Set(a));
  const reaches = () => new Map<any, number>(live.map((u: any) => { const f = foot(u, tu); return [u, Math.max(Math.hypot(f[0], f[2]), Math.hypot(f[0], f[3]), Math.hypot(f[1], f[2]), Math.hypot(f[1], f[3]))]; })); // each formation's reach from its position, for cheap contact culling
  let fr = reaches(), plans = 2; // routes worked out per tick: the rest wait their turn on the next

  for (const u of live) {
    const T = tu.types[u.type];
    u.reload = Math.max(0, u.reload - dt / (u.shaken > 0 ? tu.shaken.reload : 1)); u.busy = Math.max(0, u.busy - dt); u.stun = Math.max(0, (u.stun ?? 0) - dt); u.shaken = Math.max(0, (u.shaken ?? 0) - dt); // shaken men load slower
    u.hurt += dt; u.fired += dt;
    u.mv = false;
    if (u.limT > 0 && (u.limT -= dt) <= 0) { u.limT = 0; u.limbered = !u.limbered; } // a battery finishes limbering up / unlimbering
    const f = featureAt(scn, u.x, u.z), tired = 1 - tu.fatigue.slow * u.fat;

    if (u.routed) {
      let ne: any = null, nd = 1e9;
      for (const e of live) if (e.side !== u.side && !e.dead) { const d = Math.hypot(e.x - u.x, e.z - u.z); if (d < nd) { nd = d; ne = e; } }
      const en = scn.entry[u.side];
      let dx = en.x - u.x, dz = en.z - u.z;
      if (ne && nd < 60) { dx = u.x - ne.x; dz = u.z - ne.z; } // run from the nearest enemy, else toward home
      const d = Math.hypot(dx, dz) || 1;
      const sp = T.speed * 1.2 * terrainSpeed(u, f, tu) * W.move * tired * dt;
      u.x += (dx / d) * sp; u.z += (dz / d) * sp;
      { const dd = Math.atan2(Math.sin(Math.atan2(dx, dz) - u.facing), Math.cos(Math.atan2(dx, dz) - u.facing)), m = tu.turn.rout * dt; u.facing += Math.max(-m, Math.min(m, dd)); } // broken men turn and run, not a one-tick flip of the whole box
      u.mv = true;
      for (const f of live) if (f !== u && f.side === u.side && !f.routed && !f.dead && f.garrison == null && Math.hypot(f.x - u.x, f.z - u.z) < fr.get(f)! + 2 && distToFoot(f, tu, u.x, u.z) < 1)
        f.shaken = Math.max(f.shaken ?? 0, tu.shaken.routers * Math.min(1, u.men / Math.max(1, f.men))); // broken men running through a formed regiment throw its ranks into disorder
      if (nd > tu.rallyDistance) {
        u.morale += tu.morale.rally * (u.aura ? tu.morale.auraRally : 1) * (1 - tu.fatigue.regen * u.fat) * dt; // a commander nearby gathers broken men faster
        if (u.morale >= tu.rallyAt) { u.routed = false; ev(sim, { k: 'rally', x: u.x, z: u.z }); }
      }
      if (Math.abs(u.x) > half - 2 || Math.abs(u.z) > half - 2) { u.dead = true; u.fate = 'left'; }
      continue;
    }

    // auto-square: infantry with the toggle on form square when cavalry close in, and stand back to line afterwards
    if (u.auto && isInf(u)) {
      const cavNear = live.some((e: any) => e.side !== u.side && !e.routed && tu.types[e.type].cav && e.type !== 'commander' && Math.hypot(e.x - u.x, e.z - u.z) < 34);
      if (cavNear) { u.cavSeen = s.t; if (u.form !== 'square' && u.busy <= 0 && !(u.shaken > 0)) { u.form = 'square'; u.busy = tu.formChangeTime; u.sq = true; } } // shaken by fire, it cannot form square in time
      else if (u.sq && u.form === 'square' && s.t - u.cavSeen > 6 && u.busy <= 0 && !(u.shaken > 0)) { u.form = 'line'; u.busy = tu.formChangeTime; u.sq = false; }
    }
    // stances: aggressive units go for anything close when idle; skirmishers kite
    if (u.gTarget == null && u.garrison == null && u.tx == null && u.chase == null && u.eng == null && u.busy <= 0 && u.stance !== 'hold' && u.stance !== 'holdfire') {
      let ne: any = null, nd = 1e9;
      for (const e of live) if (e.side !== u.side && !e.dead && seen[u.side].has(e.id)) { const d = Math.hypot(e.x - u.x, e.z - u.z); if (d < nd) { nd = d; ne = e; } }
      if (ne && u.stance === 'aggressive' && nd < 42) u.chase = ne.id;
      else if (ne && u.stance === 'skirmish' && u.type === 'skirmisher' && nd < T.range * 0.5) { const dx = u.x - ne.x, dz = u.z - ne.z, dl = Math.hypot(dx, dz) || 1; u.tx = u.x + (dx / dl) * 14; u.tz = u.z + (dz / dl) * 14; }
    }
    // garrison: arriving at the farm moves the unit into the courtyard
    if (u.gTarget != null) {
      const v = (scn.map.villages ?? [])[u.gTarget];
      if (v && Math.hypot(v.x - u.x, v.z - u.z) < 6) { u.garrison = u.gTarget; u.gTarget = null; u.tx = u.tz = null; u.form = 'line'; u.x = v.x + (u.x < v.x ? -1.8 : 1.8); u.z = v.z + 0.8; log(sim, `${u.name} garrisons ${v.name}.`); }
    }
    if (u.garrison != null) continue; // garrisoned units hold their post (move, stop or attack orders release them)
    // march in column: the column forms its line again at the end of the march, or as soon as a foe it can see is within musket range
    if (u.dep) {
      if (u.form !== 'column') u.dep = null; // reformed some other way meanwhile (auto-square)
      else if (u.busy <= 0 && !(u.shaken > 0) && ((u.tx == null && u.chase == null) || live.some((e: any) => e.side !== u.side && !e.routed && seen[u.side].has(e.id) && Math.hypot(e.x - u.x, e.z - u.z) < T.range + 40 && gapBetween(u, e, tu) < T.range))) { u.form = u.dep; u.dep = null; u.busy = tu.formChangeTime; }
    }
    if (u.tx == null) { u.pace = null; u.run = u.back = false; } // a march's pace, double time and falling back end with it

    // attack-move: keep marching, but stand and fire at a seen foe in range (ranged) or ride down one within 40 (melee-only), then march on
    let amHalt = false;
    if (u.am && u.tx == null) u.am = false; // arrived (or the order was overtaken)
    else if (u.am && (u.chase == null || byId.get(u.chase)?.routed)) {
      u.chase = null;
      let ne: any = null, nd = 40;
      for (const e of live) {
        if (e.side === u.side || e.routed || !seen[u.side].has(e.id)) continue;
        if (T.range > 0) { if (gapBetween(u, e, tu) < T.range && !masked(u, e, live, tu) && los(scn, u.x, u.z, eye(u, tu), e.x, e.z, 2)) { amHalt = true; break; } } // only halt for a foe we could actually hit (not one behind a crest)
        else if (u.type !== 'commander') { const d = Math.hypot(e.x - u.x, e.z - u.z); if (d < nd) { nd = d; ne = e; } }
      }
      if (ne) u.chase = ne.id;
    }

    // chase / move
    let gx = u.tx, gz = u.tz, stopAt = 1, touch = false, dash = u.spUntil > s.t && (u.spKind === 'sprint' || u.spKind === 'charge');
    if (u.bay !== u.chase) u.bay = null; // any other order ends a bayonet charge
    if (u.chase != null) {
      const t = byId.get(u.chase);
      if (!t || t.dead || (u.bay != null && t.routed)) u.chase = u.bay = null; // a bayonet charge halts on the ground it took once the foe breaks
      else {
        gx = t.x; gz = t.z; const gp = gapBetween(u, t, tu), fire = u.bay == null && T.range > 0 && (gp > T.range || los(scn, u.x, u.z, eye(u, tu), t.x, t.z, 2)); stopAt = fire ? T.range * 0.98 : 1; touch = fire ? gp <= T.range * 0.98 : gp < 0.6; // ranged units halt at max range and shoot (once they can see the target over the ground); melee-only and chargers close in until the edges touch
        if (u.bay != null) { dash ||= gp < tu.bayonet.runDist; if (!u.tested && gp < tu.bayonet.testDist && shock(sim, u, t) !== 'melee') continue; } // the last stretch at the run; the morale test as they close
      }
    }
    let go = false;
    const dd = gx != null && gz != null ? Math.hypot(gx - u.x, gz - u.z) : 0;
    // u.path: waypoints [x, z] to march by, then [goal x, goal z, time] it was planned for; planned again when the goal moves on, a chase every few seconds
    const pg = u.path?.[u.path.length - 1];
    if (gx == null || gz == null || dd <= stopAt) u.path = null;
    else if ((!pg || Math.hypot(gx - pg[0], gz - pg[1]) > 15 || (u.chase != null && s.t - pg[2] > 4)) && plans-- > 0) {
      const mc = { type: T.cav ? 'lancer' : u.type === 'guard' ? 'line' : u.type, form: u.form === 'column' ? 'column' : 'line' }; // its movement class: the arm, and whether roads speed it
      u.path = [...(route(scn, tu, mc.type + mc.form, (g) => terrainSpeed(mc, g, tu), u.x, u.z, gx, gz) ?? []), [gx, gz, s.t]];
    }
    while (u.path?.length > 1 && Math.hypot(u.path[0][0] - u.x, u.path[0][1] - u.z) < 1) u.path.shift(); // through each corner, not round it: the legs between are what was costed (on the road, over the bridge)
    if (u.path?.length > 1) { gx = u.path[0][0]; gz = u.path[0][1]; stopAt = 0; } // a corner is never the halt
    if (gx != null && gz != null && u.busy <= 0 && !amHalt) {
      const dx = gx - u.x, dz = gz - u.z, d = Math.hypot(dx, dz);
      // a unit locked in melee stands and fights (it cannot ride through the men it is hitting); only an explicit move order breaks away
      const eT = u.eng != null ? byId.get(u.eng) : null, held = !!eT && !eT.dead && !eT.routed && (u.chase != null || u.tx == null);
      if (d <= stopAt || touch || held) { if (u.chase == null && d <= stopAt) { u.tx = u.tz = null; const nxt = u.queue.shift(); if (nxt) { u.tx = nxt[0]; u.tz = nxt[1]; } } }
      else {
        go = true;
        const back = u.back && u.chase == null && (dx * Math.sin(u.facing) + dz * Math.cos(u.facing)) / d < -0.5; // falling back facing the enemy: no wheel, a slower step
        if (u.type === 'artillery' && (!u.limbered || u.limT > 0)) { if (u.limT <= 0) u.limT = tu.limber.up; } // hook the guns to their teams before they can move
        else if (!back && face(u, Math.atan2(dx, dz), dt, tu, T.cav && u.eng != null ? tu.turn.breakaway : undefined) > tu.turn.slack) u.mv = true; // horse locked in melee wheels away fast (breakaway), not at its parade rate with its back to the foe // wheel onto the new heading before stepping off
        else {
          const run = dash ? 1.7 : u.run ? tu.doubleTime.speed : 1;
          const sp = Math.min(d - stopAt + 0.01, Math.min(marchSpeed(u, u.form, tu), u.pace ?? 1e9) * terrainSpeed(u, f, tu) * W.move * run * (back ? tu.fallback.speed : 1) * tired * dt); // a group keeps to its slowest member's pace
          const nx = u.x + (dx / d) * sp, nz = u.z + (dz / d) * sp;
          const slope = (heightAt(scn, nx, nz) - heightAt(scn, u.x, u.z)) / Math.max(sp, 0.01);
          const k = Math.min((d - stopAt + 0.01) / sp, 1 - Math.max(1 - tu.terrain.downhill, Math.min(0.5, slope * 1.5))); // uphill slows, downhill helps a little (never past the stop)
          let mx = u.x + (nx - u.x) * k, mz = u.z + (nz - u.z) * k;
          const passing = (u.jam ?? 0) > tu.passLines.wait, b = blocker(u, mx, mz, live, tu, fr, !passing); // held up long enough: it files through friendly ranks (passage of lines)
          if (b && b.side !== u.side) { mx = u.x; mz = u.z; } // the enemy's ranks stop it: it halts at contact and the melee decides
          else if (b) { // a friendly regiment in the way: step round it, keeping to one side until clear, else try the other side
            if (u.chase == null && dd < 30) { u.tx = u.tz = null; const nxt = u.queue.shift(); if (nxt) { u.tx = nxt[0]; u.tz = nxt[1]; } } // its ground is taken: close enough
            u.av ??= Math.sign(dx * (b.z - u.z) - dz * (b.x - u.x)) || (u.id & 1 ? 1 : -1);
            const step = Math.hypot(mx - u.x, mz - u.z), h = Math.atan2(dx, dz);
            let ok = false;
            for (const sd of [u.av, -u.av]) {
              for (const a of [0.7, 1.2, 1.6]) {
                const tx = u.x + Math.sin(h + sd * a) * step, tz = u.z + Math.cos(h + sd * a) * step;
                if (!blocker(u, tx, tz, live, tu, fr)) { mx = tx; mz = tz; ok = true; u.av = sd; break; }
              }
              if (ok) break;
            }
            if (!ok) { mx = u.x; mz = u.z; u.jam = (u.jam ?? 0) + dt; }
          } else { u.av = null; if (u.jam && !(passing && blocker(u, mx, mz, live, tu, fr))) u.jam = 0; } // clear of friends again
          u.mv = mx !== u.x || mz !== u.z; // a blocked regiment stands (and may fire)
          u.x = mx; u.z = mz;
          u.fat = Math.min(1, u.fat + (run > 1 ? tu.fatigue.run : tu.fatigue.march[T.cav ? 'cavalry' : isInf(u) ? u.form : u.type] ?? 0) * dt);
        }
      }
    }
    if (u.type === 'artillery' && !go && u.limbered && u.limT <= 0) u.limT = tu.limber.down; // halted: unlimber before the guns can fire
    if (u.tf != null && u.tx == null && u.chase == null && !u.mv && u.busy <= 0 && face(u, u.tf, dt, tu) === 0) u.tf = null; // last stop: wheel to the ordered facing
  }

  // combat
  fr = reaches(); // formations may have changed while moving
  for (const u of live) {
    if (u.dead || u.routed) continue;
    const T = tu.types[u.type];

    // melee: nearest enemy in contact
    let c: any = null, cd = 0.8;
    for (const e of live) { if (e.dead || e.side === u.side || Math.hypot(e.x - u.x, e.z - u.z) > fr.get(u)! + fr.get(e)! + cd) continue; const g = gapBetween(u, e, tu); if (g < cd) { cd = g; c = e; } } // bounding circles first: only close pairs pay for the exact edge test
    if (c) {
      // horse charging downhill hits harder, uphill weaker: ground fall across 16 units through the contact, scaled and clamped to +-30%
      const ex = c.x - u.x, ez = c.z - u.z, el = Math.hypot(ex, ez) || 1;
      const hc = T.cav ? Math.max(0.7, Math.min(1.3, 1 + (tu.terrain.charge * (heightAt(scn, u.x - (ex / el) * 8, u.z - (ez / el) * 8) - heightAt(scn, u.x + (ex / el) * 8, u.z + (ez / el) * 8))) / 16)) : 1;
      if (u.eng !== c.id) {
        u.eng = c.id;
        { const want = Math.atan2(c.x - u.x, c.z - u.z), dd = Math.atan2(Math.sin(want - u.facing), Math.cos(want - u.facing)); u.eF = u.facing + Math.max(-1, Math.min(1, dd)); } // face the foe once, at most ~57 degrees (no per-tick swinging), wheeling there below
        if (T.cav && u.spUntil > s.t && u.spKind === 'charge' && !u.tested && !c.routed) { u.fat = Math.min(1, u.fat + tu.fatigue.blown); if (shock(sim, u, c) === 'recoil') continue; } // horses are blown by the charge; the foe's nerve is tested on impact
        if (T.cav && !c.routed && c.form !== 'square' && !tu.types[c.type].cav) {
          const mom = faltered(u, s, tu) ? tu.falter.impact : 1; // a charge shot to pieces on the way in hits home weakly
          c.morale -= tu.chargeShock * hc * mom;
          const stun = c.garrison == null; // behind a farm's walls the men keep their order
          if (stun) { // in proportion to the impact: slope, the horse's numbers against the foot's, a true Charge (V), lost momentum
            c.stun = Math.max(c.stun ?? 0, tu.stun.time * hc * mom * Math.max(tu.stun.size[0], Math.min(tu.stun.size[1], u.men / Math.max(1, c.men))) * (u.spUntil > s.t && u.spKind === 'charge' ? tu.stun.charge : 1));
            c.busy = Math.max(c.busy, c.stun); // busy: no firing, moving or reforming until it clears
          }
          ev(sim, { k: 'charge', x: c.x, z: c.z, side: c.side, stun });
        }
      }
      if (breakingOff(u, c, tu)) { u.eF = null; continue; } // ordered out of the melee: it wheels away and strikes no blows
      if (u.eF != null) { const dd = Math.atan2(Math.sin(u.eF - u.facing), Math.cos(u.eF - u.facing)), m = tu.turn.engage * dt; if (Math.abs(dd) <= m) { u.facing = u.eF; u.eF = null; } else u.facing += Math.sign(dd) * m; } // wheel into contact, not a one-tick snap of the whole box
      const away = breakingOff(c, u, tu), asp = away ? 0 : aspect(u, c), gm = c.garrison != null ? (T.cav ? tu.garrison.meleeCav : tu.garrison.meleeInf) : 1; // horse getting clear takes a parting blow, not a rear attack, as it wheels away
      if (asp && s.t - c.flankT > 6) { c.flankT = s.t; ev(sim, { k: 'flank', x: c.x, z: c.z, side: c.side, kind: asp }); chron(sim, 1 - c.side, `${asp === 2 ? 'Rear' : 'Flank'} attack on ${c.name}`); }
      if (asp) c.shaken = Math.max(c.shaken ?? 0, tu.shaken.flank[asp]); // attacked on the flank or rear, its ranks cannot turn to face it in good order
      damage(sim, c, u.men * T.melee * meleeMult(u, c) * hc * gm * tu.flank.dmg[asp] * (1 + u.vet * tu.veterancy.melee) * tu.meleeRate * (u.spUntil > s.t && u.spKind === 'charge' ? 1.6 : 1) * (u.bay === c.id && !faltered(u, s, tu) ? tu.bayonet.melee : 1) * (1 - tu.fatigue.melee * u.fat) * (away ? tu.breakoff.hit : 1) * (u.stun > 0 ? tu.stun.melee : 1) * dt,
        tu.flank.morale[asp] * (T.cav || tu.types[c.type].cav ? 1 : tu.bayonet.grind), u); // foot against foot does not grind on for long: one side gives way
      u.fat = Math.min(1, u.fat + tu.fatigue.fight * dt);
      if (c.dead) u.eng = null;
      continue;
    }
    u.eng = null; u.eF = null;

    // ranged fire (only when standing still, not changing formation, guns unlimbered)
    if (T.range <= 0 || u.mv || u.busy > 0 || u.reload > 0 || u.limbered || u.limT > 0) continue;
    let tg: any = null, td = 1e9, best = 1e9;
    const hu = heightAt(scn, u.x, u.z), hf = u.stance === 'holdfire' ? tu.holdFire.range : 1; // holding fire: only a foe close in (or the ordered target) draws a volley
    for (const e of live) {
      if (e.dead || e.side === u.side || !seen[u.side].has(e.id)) continue;
      const d = Math.max(0, gapBetween(u, e, tu)), reach = T.range * (u.type === 'artillery' ? Math.max(1, Math.min(1.3, 1 + tu.terrain.gunReach * (hu - heightAt(scn, e.x, e.z)))) : 1); // guns on high ground reach further
      const k = e.id === u.chase ? -1 : d; // the ordered target comes first whenever it can be hit, else the nearest
      if (k < best && d < reach * (k < 0 ? 1 : hf) && !smokeBlocked(sim, u.x, u.z, e.x, e.z) && !masked(u, e, live, tu) && los(scn, u.x, u.z, eye(u, tu), e.x, e.z, 2)) { best = k; td = d; tg = e; } // range is measured to the nearest part of the target formation; no shooting over a crest
    }
    if (!tg) continue;
    u.tf = null; // the enemy comes before the ordered facing
    if (face(u, Math.atan2(tg.x - u.x, tg.z - u.z), dt, tu) > tu.turn.arc) continue; // wheel toward a target off to the side before giving fire
    shoot(sim, u, tg, td);
  }

  // abilities in flight
  for (const f of s.fx) {
    const ab = tu.abilities[f.kind];
    f.t += dt;
    if (f.t < ab.delay || f.t > ab.delay + ab.dur) continue;
    for (const u of live) {
      if (u.dead || Math.hypot(u.x - f.x, u.z - f.z) > ab.r) continue;
      hit(sim, u, u.maxMen * ab.dps * dt * tu.artDmg[u.form], 0.5, null, 0); // a barrage or rocket strike shakes in proportion to what it takes, like any fire
      u.morale -= ab.mdps * dt;
    }
    f.acc += ab.booms * dt;
    while (f.acc >= 1) {
      f.acc--;
      const a = rand(s) * Math.PI * 2, r = Math.sqrt(rand(s)) * ab.r;
      ev(sim, { k: 'boom', x: f.x + Math.cos(a) * r, z: f.z + Math.sin(a) * r });
    }
  }
  s.fx = s.fx.filter((f: any) => f.t < tu.abilities[f.kind].delay + tu.abilities[f.kind].dur + 0.1);

  // separation (soft, so regiments do not stack)
  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    if (a.dead) continue;
    for (let j = i + 1; j < live.length; j++) {
      const b = live[j];
      if (b.dead || a.eng === b.id || b.eng === a.id || a.garrison != null || b.garrison != null) continue;
      if (a.side === b.side && (a.mv || b.mv)) continue; // friends pass through each other while marching (no bulldozing your own line); they spread out once both halt
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      if (d < 0.001) continue;
      const min = a.side === b.side ? 0.7 * (rad(a) + rad(b)) + 1 : d - gapBetween(a, b, tu) + 0.2; // enemies are kept edge-to-edge apart, never overlapped
      if (d >= min) continue;
      const p = Math.min((min - d) * 0.5, tu.separation.max * dt), wa = (b.men + 50) / (a.men + b.men + 100); // total push, capped; the lighter regiment gives way more
      a.x -= (dx / d) * p * wa; a.z -= (dz / d) * p * wa; b.x += (dx / d) * p * (1 - wa); b.z += (dz / d) * p * (1 - wa);
    }
  }

  // morale: recovery, routs
  for (const u of live) {
    if (u.dead) continue;
    u.still = u.mv || u.routed || u.busy > 0 || u.limT > 0 ? 0 : u.still + dt; // seconds standing in place (not reforming or hitching up): after tuning.hold.after the regiment is posted (see posted())
    const half2 = half - 1;
    u.x = Math.max(-half2, Math.min(half2, u.x)); u.z = Math.max(-half2, Math.min(half2, u.z));
    if (u.acc >= 3 && s.t - u.accT > 0.8) { ev(sim, { k: 'dmg', x: u.x, z: u.z, side: u.side, n: Math.round(u.acc) }); u.acc = 0; u.accT = s.t; }
    u.mcap = mcap(u, tu);
    if (u.routed) continue;
    if (!u.mv && u.eng == null) u.fat = Math.max(0, u.fat - tu.fatigue.rest * dt); // men catch their breath standing
    const rg = (u.hurt > tu.morale.quiet ? tu.morale.regen : 0) + (u.aura ? tu.commanderAura.regen : 0); // spirits recover slowly out of fire, faster under the commander's eye
    if (rg && u.morale > 0 && u.morale < u.mcap) u.morale = Math.min(u.mcap, u.morale + rg * (1 - tu.fatigue.regen * u.fat) * dt);
    if (u.morale <= 0) {
      u.routed = true; u.tx = u.tz = u.chase = null; u.eng = null; u.morale = 0; u.garrison = u.gTarget = null; u.queue = [];
      chron(sim, u.side, `${u.name} routed`);
      ev(sim, { k: 'rout', x: u.x, z: u.z, side: u.side, name: u.name });
      log(sim, `${u.name} routs!`);
      for (const f of live) if (f.side === u.side && f !== u && !f.dead && Math.hypot(f.x - u.x, f.z - u.z) < tu.routSpread.radius) f.morale -= tu.routSpread.loss;
    }
  }

  // capture zones + score
  for (const z of s.zones) {
    const m = [0, 0];
    for (const u of live) if (!u.dead && !u.routed && Math.hypot(u.x - z.x, u.z - z.z) < z.r) m[u.side] += u.men;
    const c = tu.capture;
    if ((m[0] > 0) !== (m[1] > 0)) {
      const side = m[0] > 0 ? 0 : 1, str = Math.max(c.minStrength, Math.min(c.maxStrength, m[side] / c.refMen));
      z.p = Math.max(-1, Math.min(1, z.p + (side === 0 ? 1 : -1) * c.rate * str * dt));
    }
    z.contested = m[0] > 0 && m[1] > 0;
    const prev = z.owner;
    z.owner = z.p > 0.5 ? 0 : z.p < -0.5 ? 1 : null;
    if (z.owner !== prev && z.owner != null) { log(sim, `${z.name} is taken by the ${z.owner === 0 ? 'French' : 'Coalition'}!`); chron(sim, z.owner, `${z.name} captured`); }
    if (z.owner != null) s.side[z.owner].score += z.value * dt;
  }

  // replenishing: fresh men march in while a regiment holds friendly objective ground out of the fight, paid in RP at the deploy rate
  for (const u of live) {
    if (!u.refill || u.dead) continue;
    if (u.routed || u.men >= u.maxMen) { if (!u.routed) log(sim, `${u.name} is back to full strength.`); u.refill = false; continue; }
    const sd = s.side[u.side];
    if (sd.pool < 1) { u.refill = false; log(sim, `${u.side === 0 ? 'French' : 'Coalition'} depots are empty: no more replacements.`); continue; }
    if (u.eng != null || u.hurt < 3 || !held(s, u)) continue; // paused: fighting, under fire, or off our depots (elsewhere a draft marches in, see command)
    const per = manPrice(tu, u), add = Math.min((u.maxMen / tu.refillTime) * dt, u.maxMen - u.men, sd.rp / per, sd.pool);
    u.men += add; sd.rp -= add * per; sd.pool -= add; u.refilled += add;
  }

  // smoke ageing
  for (const p of s.smoke) p.age += dt;
  s.smoke = s.smoke.filter((p: any) => p.age < tu.smoke.life);

  // drafts: march on their regiment and join it on arrival; if it is gone or broken, they become a small regiment of their own
  for (const d of live) {
    if (d.draftFor == null || d.dead) continue;
    const r = byId.get(d.draftFor);
    if (!r || r.dead || r.routed) { d.draftFor = null; d.name = `Draft (${Math.round(d.men)} men)`; continue; }
    if (gapBetween(d, r, tu) < 1.5) { r.men = Math.min(r.maxMen, r.men + d.men); d.dead = true; d.fate = 'merged'; log(sim, `${r.name} is joined by ${Math.round(d.men)} fresh men.`); continue; }
    if (!d.routed) { d.tx = r.x; d.tz = r.z; d.chase = null; }
  }

  // removals
  for (const u of s.units) {
    if (u.dead && u.rid != null && !u.logged) { u.logged = true; s.out.push({ rid: u.rid, men: u.fate === 'left' ? u.men * 0.5 : 0, fate: u.fate, xp: u.xp }); }
  }
  s.units = s.units.filter((u: any) => !u.dead);

  // end of battle
  if (s.t >= s.endCheck) {
    s.endCheck = s.t + 1;
    // an army only counts as gone after 12s with nobody standing (routed men can still rally) and no help about to land
    s.gone ??= [0, 0];
    const alive = [0, 1].map((i) => {
      const has = s.units.some((u: any) => u.side === i && !u.routed) || sim.tl.slice(s.ti).some((e: any) => e.type === 'reinforce' && e.side === i && e.t - s.t < 45);
      s.gone[i] = has ? 0 : s.gone[i] + 1;
      return s.gone[i] < 12;
    });
    if (!alive[0] || !alive[1] || s.t >= scn.duration) finish(sim, alive);
  }
}

function runEvent(sim: Sim, e: any) {
  const s = sim.s;
  if (e.msg) log(sim, e.msg);
  if (e.type === 'weather') { s.weather = e.weather; ev(sim, { k: 'weather', w: e.weather }); }
  else if (e.type === 'morale') { for (const u of s.units) if (u.side === e.side) u.morale += e.amount; }
  else if (e.type === 'rp') s.side[e.side].rp += e.amount;
  else if (e.type === 'reinforce') {
    const en = e.entry ?? sim.scn.entry[e.side];
    const defs = expandForces(e.units);
    defs.forEach((d, i) => {
      const u = spawn(sim, e.side, { ...d, x: en.x + (d.x ?? 0) + (i - (defs.length - 1) / 2) * 9 * (e.spreadX ?? 1), z: en.z + (d.z ?? 0) + (i - (defs.length - 1) / 2) * 9 * (e.spreadZ ?? 0) });
      if (i === 0) ev(sim, { k: 'arrive', side: e.side, names: defs.map((q: any) => q.name), types: defs.map((q: any) => q.type), x: en.x, z: en.z });
      if (e.go) { u.tx = e.go.x + (i - (defs.length - 1) / 2) * 10 * (e.spreadX ?? 1); u.tz = e.go.z + (i - (defs.length - 1) / 2) * 10 * (e.spreadZ ?? 0); u.am = true; u.march = true; u.facing = Math.atan2(u.tx! - u.x, u.tz! - u.z); } // arrive facing down the route; historical arrival route: fight what they meet on the way; the bot takes over once they arrive
    });
  }
}

/** The French share of the verdict if the battle ended now: objectives held count endHeldWeight, points banked the rest. Over 0.5 + drawBand the French win. */
export function verdict(s: any, tu: any): number {
  const h = [0, 0], sc = [s.side[0].score, s.side[1].score];
  for (const z of s.zones) if (z.owner != null) h[z.owner] += z.value;
  const hr = h[0] + h[1] ? h[0] / (h[0] + h[1]) : 0.5;
  return tu.endHeldWeight * hr + (1 - tu.endHeldWeight) * (sc[0] / Math.max(1, sc[0] + sc[1]));
}

function finish(sim: Sim, alive: boolean[]) {
  const s = sim.s, sc = [s.side[0].score, s.side[1].score];
  const ratio = verdict(s, sim.tu); // objectives held at the end count more than points banked along the way
  let winner = -1;
  if (!alive[0] && alive[1]) winner = 1;
  else if (alive[0] && !alive[1]) winner = 0;
  else if (alive[0] && alive[1]) {
    winner = ratio > 0.5 + sim.tu.drawBand ? 0 : ratio < 0.5 - sim.tu.drawBand ? 1 : -1;
  }
  const decisive = !alive[0] || !alive[1] || Math.max(ratio, 1 - ratio) > sim.tu.decisiveRatio;
  s.over = true;
  const top = (side: number) => s.units.filter((u: any) => u.side === side).sort((a: any, b: any) => b.xp - a.xp).slice(0, 3).map((u: any) => ({ name: u.name, xp: Math.round(u.xp), vet: u.vet, type: u.type }));
  s.result = { winner, decisive, score: sc.map(Math.round), lost: s.side.map((x: any) => Math.round(x.lost)), collapse: !alive[0] || !alive[1], stats: { hist: s.hist, chron: s.chron.slice(-14), top: [top(0), top(1)], fallen: s.fallen.slice(-8), t: Math.round(s.t) } };
  log(sim, winner < 0 ? 'The battle ends in a draw.' : `The ${winner === 0 ? 'French' : 'Coalition'} win the day!`);
  // units still on the field return to the roster
  for (const u of s.units) if (u.rid != null) s.out.push({ rid: u.rid, men: u.men, fate: 'field', xp: u.xp });
}
