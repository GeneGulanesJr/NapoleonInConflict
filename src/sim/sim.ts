// Pure, deterministic battle simulation. No DOM, no Three.js: runs in the browser and on the Node server.
import { detour, heightAt, featureAt } from './world.ts';

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
    for (let i = 0; i < (g.n ?? 1); i++)
      out.push({ ...g, n: undefined, names: undefined, name: g.names?.[i] ?? (g.n > 1 ? `${g.name} ${i + 1}` : g.name), x: g.x + i * (g.dx ?? 0), z: g.z + i * (g.dz ?? 0) });
  }
  return out;
}

/**
 * opts.roster: campaign roster [{rid,type,name,men,maxMen}] used to fill side 0 slots (best-strength first).
 * opts.won: campaign results {battleId: boolean} used by `delayIfWon` timeline events.
 */
export function createSim(scn: any, tu: any, opts: { seed?: number; roster?: any[]; won?: Record<string, boolean>; fog?: boolean } = {}): Sim {
  const mkSide = (i: number) => ({ rp: scn.rpStart?.[i] ?? 0, score: 0, lost: 0, cd: {} as Record<string, number>, reserves: { ...(scn.reserves?.[i] ?? {}) } });
  const s: any = {
    t: 0, seed: opts.seed ?? 1, nextId: 1, units: [], smoke: [], fx: [], out: [], log: [], events: [],
    zones: scn.zones.map((z: any) => ({ ...z, owner: z.owner ?? null, p: z.owner === 0 ? 1 : z.owner === 1 ? -1 : 0 })),
    side: [mkSide(0), mkSide(1)], weather: scn.weather ?? 'clear', over: false, result: null, ti: 0, endCheck: 0,
    fog: !!opts.fog, seen: [[], []], hist: [], chron: [], fallen: [], histT: 0,
  };
  const tl = (scn.timeline ?? []).map((e: any) => {
    let t = e.t;
    for (const [b, d] of Object.entries(e.delayIfWon ?? {})) if (opts.won?.[b]) t += d as number;
    return { ...e, t };
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
    rid: d.rid ?? null, dead: false, via: null as { x: number; z: number } | null,
    spReady: 0, spUntil: 0, spKind: '', acc: 0, accT: 0,
    xp: d.xp ?? 0, vet: rankOf(sim.tu, d.xp ?? 0), stance: 'hold', auto: false, sq: false, cavSeen: -99, queue: [] as number[][],
    garrison: null as number | null, gTarget: null as number | null, aura: false, flankT: -99,
  };
  sim.s.units.push(u);
  return u;
}

// ---------------------------------------------------------------- commands
export type Cmd =
  | { c: 'move'; ids: number[]; x: number; z: number; q?: boolean }
  | { c: 'stance'; ids: number[]; s: string }
  | { c: 'auto'; ids: number[] }
  | { c: 'garrison'; ids: number[]; vid: number }
  | { c: 'attack'; ids: number[]; target: number }
  | { c: 'form'; ids: number[]; f: string }
  | { c: 'stop'; ids: number[] }
  | { c: 'special'; ids: number[] }
  | { c: 'ability'; name: string; x: number; z: number }
  | { c: 'deploy'; type: string };

export function command(sim: Sim, side: number, c: Cmd) {
  const s = sim.s;
  if (s.over) return;
  const mine = (ids: number[]) => ids.map((id) => s.units.find((u: any) => u.id === id && u.side === side && !u.dead && !u.routed)).filter(Boolean);
  const half = sim.scn.map.size / 2 - 2;
  if (c.c === 'move') {
    const us = mine(c.ids);
    if (!us.length) return;
    const cx = us.reduce((a: number, u: any) => a + u.x, 0) / us.length, cz = us.reduce((a: number, u: any) => a + u.z, 0) / us.length;
    let dx = c.x - cx, dz = c.z - cz;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    us.sort((a: any, b: any) => (a.x * -dz + a.z * dx) - (b.x * -dz + b.z * dx));
    // side by side by real frontage (and never closer than the idle spacing rule), so a group arrives without piling up
    const hw = us.map((u: any) => { const f = foot(u, sim.tu); return Math.max((f[1] - f[0]) / 2 + 2, 0.7 * rad(u) + 0.5); });
    let acc = -hw.reduce((a: number, b: number) => a + b, 0);
    us.forEach((u: any, i: number) => {
      const off = acc + hw[i]; acc += 2 * hw[i];
      const tx = Math.max(-half, Math.min(half, c.x - dz * off)), tz = Math.max(-half, Math.min(half, c.z + dx * off));
      if (c.q && u.tx != null && u.chase == null) { if (u.queue.length < 6) u.queue.push([tx, tz]); } // shift-click: add a waypoint
      else { u.tx = tx; u.tz = tz; u.queue = []; u.chase = null; u.via = null; u.garrison = u.gTarget = null; }
    });
  } else if (c.c === 'attack') {
    if (!s.units.some((u: any) => u.id === c.target && u.side !== side && !u.dead)) return;
    for (const u of mine(c.ids)) { u.chase = c.target; u.tx = u.tz = null; u.via = null; u.queue = []; u.garrison = u.gTarget = null; }
  } else if (c.c === 'form') {
    for (const u of mine(c.ids)) {
      if ((u.type === 'line' || u.type === 'guard') && u.form !== c.f && sim.tu.formFire[c.f]) { u.form = c.f; u.busy = sim.tu.formChangeTime; }
    }
  } else if (c.c === 'stop') {
    for (const u of mine(c.ids)) { u.tx = u.tz = u.chase = null; u.via = null; u.queue = []; u.garrison = u.gTarget = null; }
  } else if (c.c === 'stance') {
    for (const u of mine(c.ids)) u.stance = c.s === 'aggressive' || c.s === 'skirmish' ? c.s : 'hold';
  } else if (c.c === 'auto') {
    const us = mine(c.ids).filter(isInf), on = !us.every((u: any) => u.auto);
    for (const u of us) u.auto = on;
  } else if (c.c === 'garrison') {
    const v = (sim.scn.map.villages ?? [])[c.vid];
    if (!v || !garrisonable(v)) return;
    const held = s.units.filter((q: any) => q.side === side && q.garrison === c.vid).length;
    let free = sim.tu.garrison.capacity - held;
    for (const u of mine(c.ids)) {
      if (!(isInf(u) || u.type === 'skirmisher') || free <= 0) continue;
      free--; u.chase = null; u.via = null; u.queue = []; u.garrison = null; u.gTarget = c.vid; u.tx = v.x + (free ? -1.8 : 1.8); u.tz = v.z + 0.8;
    }
  } else if (c.c === 'special') {
    for (const u of mine(c.ids)) {
      const sp = sim.tu.specials?.[u.type];
      if (!sp || s.t < u.spReady) continue;
      u.spReady = s.t + sp.cd; u.spUntil = s.t + sp.dur; u.spKind = sp.kind;
      if (sp.kind === 'volley') u.reload = 0;
      if (sp.kind === 'rally') { // commander: broken men nearby rally, the rest steady
        const ca = sim.tu.commanderAura;
        for (const q of s.units) if (q.side === side && !q.dead && q !== u && Math.hypot(q.x - u.x, q.z - u.z) < ca.rallyRadius) { if (q.routed) { q.routed = false; q.morale = Math.max(q.morale, 45); ev(sim, { k: 'rally', x: q.x, z: q.z }); } else q.morale = Math.min(q.maxMorale, q.morale + 30); }
      }
      ev(sim, { k: 'special', x: u.x, z: u.z, side, kind: sp.kind, name: u.name });
    }
  } else if (c.c === 'ability') useAbility(sim, side, c.name, c.x, c.z);
  else if (c.c === 'deploy') deploy(sim, side, c.type);
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
  const p = entryPoint(sim, side);
  const u = spawn(sim, side, { type, name: `Reserve ${T.label}`, x: p.x, z: p.z });
  const g = sim.scn.entry[side];
  u.tx = g.x; u.tz = g.z + (side === 0 ? -25 : 25);
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
function foot(u: any, tu: any): number[] { const k = tu.figScale ?? 1; return foot0(u, tu).map((v) => v * k); }
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
  if (Math.hypot(a.x - b.x, a.z - b.z) > 170) return 99;
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
const isInf = (u: any) => u.type === 'line' || u.type === 'guard';

function damage(sim: Sim, u: any, cas: number, moraleScale = 1, att?: any) {
  if (u.dead) return;
  const tu = sim.tu, s = sim.s;
  cas = Math.min(cas, u.men);
  u.men -= cas;
  s.side[u.side].lost += cas;
  s.side[1 - u.side].score += cas * tu.casualtyScore;
  u.morale -= (cas / u.maxMen) * tu.moraleLoss * moraleScale * (1 - u.vet * tu.veterancy.resist) * (u.aura ? tu.commanderAura.resist : 1) * (u.garrison != null ? tu.garrison.morale : 1);
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
function masked(u: any, e: any, live: any[], tu: any) {
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

// ---------------------------------------------------------------- step
export function step(sim: Sim, dt: number) {
  const { s, scn, tu } = sim;
  if (s.over) return;
  s.t += dt;
  const W = tu.weather[s.weather] ?? tu.weather.clear;
  const half = scn.map.size / 2;

  // timeline
  while (s.ti < sim.tl.length && sim.tl[s.ti].t <= s.t) runEvent(sim, sim.tl[s.ti++]);

  // economy + cooldowns
  for (let i = 0; i < 2; i++) {
    const sd = s.side[i];
    sd.rp += (scn.rpRate?.[i] ?? 0) * dt;
    for (const k of Object.keys(sd.cd)) sd.cd[k] = Math.max(0, sd.cd[k] - dt);
  }

  const live = s.units.filter((u: any) => !u.dead);
  const byId = new Map<number, any>(live.map((u: any) => [u.id, u]));

  // history for the after-action report
  if (s.t - s.histT >= 10) { s.histT = s.t; s.hist.push({ t: Math.round(s.t), l0: Math.round(s.side[0].lost), l1: Math.round(s.side[1].lost), s0: Math.round(s.side[0].score), s1: Math.round(s.side[1].score) }); }

  // commander aura
  const ca = tu.commanderAura, cmds = live.filter((u: any) => u.type === 'commander' && !u.routed);
  for (const u of live) u.aura = u.type !== 'commander' && cmds.some((c: any) => c.side === u.side && Math.hypot(c.x - u.x, c.z - u.z) < ca.radius);

  // fog of war: an enemy is seen when one of your units is within sight (or it has just fired)
  const seen: Set<number>[] = [new Set(), new Set()];
  for (const e of live) {
    if (!s.fog) { seen[1 - e.side].add(e.id); continue; }
    const wood = featureAt(scn, e.x, e.z).kind === 'wood' ? 0.6 : 1;
    const vis = (e.fired < tu.sight.reveal) || live.some((f: any) => f.side !== e.side && Math.hypot(f.x - e.x, f.z - e.z) < (tu.sight[f.type] ?? 70) * (s.weather === 'storm' ? tu.sight.storm : s.weather === 'rain' ? tu.sight.rain : 1) * wood && !smokeBlocked(sim, f.x, f.z, e.x, e.z));
    if (vis) seen[1 - e.side].add(e.id);
  }
  s.seen = [[...seen[0]], [...seen[1]]];

  for (const u of live) {
    const T = tu.types[u.type];
    u.reload = Math.max(0, u.reload - dt); u.busy = Math.max(0, u.busy - dt);
    u.hurt += dt; u.fired += dt;
    u.mv = false;
    const f = featureAt(scn, u.x, u.z);

    if (u.routed) {
      let ne: any = null, nd = 1e9;
      for (const e of live) if (e.side !== u.side && !e.dead) { const d = Math.hypot(e.x - u.x, e.z - u.z); if (d < nd) { nd = d; ne = e; } }
      const en = scn.entry[u.side];
      let dx = en.x - u.x, dz = en.z - u.z;
      if (ne && nd < 60) { dx = u.x - ne.x; dz = u.z - ne.z; } // run from the nearest enemy, else toward home
      const d = Math.hypot(dx, dz) || 1;
      const sp = T.speed * 1.2 * f.slow * W.move * dt;
      u.x += (dx / d) * sp; u.z += (dz / d) * sp;
      u.facing = Math.atan2(dx, dz);
      u.mv = true;
      if (nd > tu.rallyDistance) {
        u.morale += 3 * dt;
        if (u.morale >= tu.rallyAt) { u.routed = false; ev(sim, { k: 'rally', x: u.x, z: u.z }); }
      }
      if (Math.abs(u.x) > half - 2 || Math.abs(u.z) > half - 2) { u.dead = true; u.fate = 'left'; }
      continue;
    }

    // auto-square: infantry with the toggle on form square when cavalry close in, and stand back to line afterwards
    if (u.auto && isInf(u)) {
      const cavNear = live.some((e: any) => e.side !== u.side && !e.routed && tu.types[e.type].cav && e.type !== 'commander' && Math.hypot(e.x - u.x, e.z - u.z) < 34);
      if (cavNear) { u.cavSeen = s.t; if (u.form !== 'square' && u.busy <= 0) { u.form = 'square'; u.busy = tu.formChangeTime; u.sq = true; } }
      else if (u.sq && u.form === 'square' && s.t - u.cavSeen > 6 && u.busy <= 0) { u.form = 'line'; u.busy = tu.formChangeTime; u.sq = false; }
    }
    // stances: aggressive units go for anything close when idle; skirmishers kite
    if (u.gTarget == null && u.garrison == null && u.tx == null && u.chase == null && u.eng == null && u.busy <= 0 && u.stance !== 'hold') {
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

    // chase / move
    let gx = u.tx, gz = u.tz, stopAt = 1, touch = false;
    if (u.chase != null) {
      const t = byId.get(u.chase);
      if (!t || t.dead) u.chase = null;
      else { gx = t.x; gz = t.z; stopAt = T.range > 0 ? T.range * 0.98 : 1; const gp = gapBetween(u, t, tu); touch = T.range > 0 ? gp <= T.range * 0.98 : gp < 0.6; } // ranged units halt at max range and shoot; melee-only close in until the edges touch
    }
    const dd = gx != null && gz != null ? Math.hypot(gx - u.x, gz - u.z) : 0;
    if (gx == null || gz == null || dd <= stopAt) u.via = null;
    else if (u.via) { if (Math.hypot(u.via.x - u.x, u.via.z - u.z) < 4) u.via = null; }
    else if ((Math.floor(s.t / dt) + u.id) % 10 === 0) u.via = detour(scn, u.x, u.z, gx, gz); // wade-free route over a bridge
    if (u.via && gx != null) { gx = u.via.x; gz = u.via.z; stopAt = 1; }
    if (gx != null && gz != null && u.busy <= 0) {
      const dx = gx - u.x, dz = gz - u.z, d = Math.hypot(dx, dz);
      // a unit locked in melee stands and fights (it cannot ride through the men it is hitting); only an explicit move order breaks away
      const eT = u.eng != null ? byId.get(u.eng) : null, held = !!eT && !eT.dead && !eT.routed && (u.chase != null || u.tx == null);
      if (d <= stopAt || touch || held) { if (u.chase == null && d <= stopAt) { u.tx = u.tz = null; const nxt = u.queue.shift(); if (nxt) { u.tx = nxt[0]; u.tz = nxt[1]; } } }
      else {
        const fs = T.cav || u.type === 'artillery' || u.type === 'skirmisher' ? 1 : tu.formSpeed[u.form];
        const run = u.spUntil > s.t && (u.spKind === 'sprint' || u.spKind === 'charge') ? 1.7 : 1;
        const sp = Math.min(d - stopAt + 0.01, T.speed * fs * f.slow * W.move * run * dt);
        const nx = u.x + (dx / d) * sp, nz = u.z + (dz / d) * sp;
        const slope = (heightAt(scn, nx, nz) - heightAt(scn, u.x, u.z)) / Math.max(sp, 0.01);
        const k = 1 - Math.max(0, Math.min(0.5, slope * 1.5));
        u.x += (nx - u.x) * k; u.z += (nz - u.z) * k;
        u.facing = Math.atan2(dx, dz);
        u.mv = true;
      }
    }
  }

  // combat
  for (const u of live) {
    if (u.dead || u.routed) continue;
    const T = tu.types[u.type];

    // melee: nearest enemy in contact
    let c: any = null, cd = 0.8;
    for (const e of live) { if (e.dead || e.side === u.side || Math.hypot(e.x - u.x, e.z - u.z) > 70) continue; const g = gapBetween(u, e, tu); if (g < cd) { cd = g; c = e; } }
    if (c) {
      if (u.eng !== c.id) {
        u.eng = c.id;
        { const want = Math.atan2(c.x - u.x, c.z - u.z), dd = Math.atan2(Math.sin(want - u.facing), Math.cos(want - u.facing)); u.facing += Math.max(-1, Math.min(1, dd)); } // turn once, at most ~57 degrees, no per-tick swinging
        if (T.cav && !c.routed && c.form !== 'square' && !tu.types[c.type].cav) { c.morale -= tu.chargeShock; ev(sim, { k: 'charge', x: c.x, z: c.z }); }
      }
      const asp = aspect(u, c), gm = c.garrison != null ? (T.cav ? tu.garrison.meleeCav : tu.garrison.meleeInf) : 1;
      if (asp && s.t - c.flankT > 6) { c.flankT = s.t; ev(sim, { k: 'flank', x: c.x, z: c.z, side: c.side, kind: asp }); chron(sim, 1 - c.side, `${asp === 2 ? 'Rear' : 'Flank'} attack on ${c.name}`); }
      damage(sim, c, u.men * T.melee * meleeMult(u, c) * gm * tu.flank.dmg[asp] * (1 + u.vet * tu.veterancy.melee) * tu.meleeRate * (u.spUntil > s.t && u.spKind === 'charge' ? 1.6 : 1) * dt, tu.flank.morale[asp], u);
      if (c.dead) u.eng = null;
      continue;
    }
    u.eng = null;

    // ranged fire (only when standing still, not changing formation)
    if (T.range <= 0 || u.mv || u.busy > 0 || u.reload > 0) continue;
    let tg: any = null, td = T.range;
    for (const e of live) { if (e.dead || e.side === u.side || !seen[u.side].has(e.id)) continue; const d = Math.max(0, gapBetween(u, e, tu)); if (d < td && !smokeBlocked(sim, u.x, u.z, e.x, e.z) && !masked(u, e, live, tu)) { td = d; tg = e; } } // range is measured to the nearest part of the target formation
    if (!tg) continue;
    // round shot falls short or wide more often the further it flies; canister at close range always tells
    const canister = u.spUntil > s.t && u.spKind === 'canister', volley = u.spUntil > s.t && u.spKind === 'volley', close = td < tu.canisterRange * (canister ? 2.2 : 1);
    const miss = u.type === 'artillery' && !close && rand(s) > 1 - 0.65 * (td / T.range);
    const fm = u.type === 'skirmisher' || u.type === 'artillery' ? 1 : tu.formFire[u.form];
    const dmgForm = tu.types[tg.type].cav ? 0.8 : tg.type === 'skirmisher' ? 0.6 : tu.formDmg[tg.form];
    const rf = Math.max(tu.rangeFloor, 1 - 0.75 * (td / T.range));
    const elev = Math.max(0.8, Math.min(1.25, 1 + 0.02 * (heightAt(scn, u.x, u.z) - heightAt(scn, tg.x, tg.z))));
    const asp = aspect(u, tg);
    if (asp && s.t - tg.flankT > 6) { tg.flankT = s.t; ev(sim, { k: 'flank', x: tg.x, z: tg.z, side: tg.side, kind: asp }); chron(sim, 1 - tg.side, `${asp === 2 ? 'Rear' : 'Flank'} fire on ${tg.name}`); }
    let cas = u.men * T.power * rf * fm * dmgForm * (tg.garrison != null ? tu.garrison.cover : featureAt(scn, tg.x, tg.z).cover) * tu.flank.dmg[asp] * (1 + u.vet * tu.veterancy.fire) * smokeFactor(sim, tg.x, tg.z) * W.fire * elev
      * (0.5 + 0.5 * Math.max(0, u.morale) / u.maxMorale) * (0.8 + 0.4 * rand(s));
    if (u.type === 'artillery' && close) cas *= tu.canisterMult * (canister ? 1.4 : 1);
    if (volley) { cas *= 2.2; u.spUntil = 0; }
    if (miss) ev(sim, { k: 'boom', x: tg.x + (rand(s) - 0.5) * 16, z: tg.z + (rand(s) - 0.5) * 16 }); // the ball ploughs up the ground nearby
    else damage(sim, tg, cas, tu.flank.morale[asp], u);
    u.reload = T.reload * (0.9 + 0.2 * rand(s)) * (volley ? 1.6 : canister ? 0.6 : 1);
    u.fired = 0;
    u.facing = Math.atan2(tg.x - u.x, tg.z - u.z);
    const fx = Math.sin(u.facing), fz = Math.cos(u.facing);
    s.smoke.push({ x: u.x + fx * 3, z: u.z + fz * 3, age: 0 });
    if (s.smoke.length > tu.smoke.maxPuffs) s.smoke.shift();
    const fw = foot(u, tu); // frontage, so the renderer can ripple the volley along the whole firing line
    ev(sim, { k: 'shot', side: u.side, x: u.x, z: u.z, a: u.type === 'artillery' ? 1 : 0, tx: tg.x, tz: tg.z, w: Math.round(fw[1] - fw[0]) });
  }

  // abilities in flight
  for (const f of s.fx) {
    const ab = tu.abilities[f.kind];
    f.t += dt;
    if (f.t < ab.delay || f.t > ab.delay + ab.dur) continue;
    for (const u of live) {
      if (u.dead || Math.hypot(u.x - f.x, u.z - f.z) > ab.r) continue;
      damage(sim, u, u.maxMen * ab.dps * dt * tu.formDmg[u.form], 0.5);
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
      const p = (min - d) * 0.25;
      a.x -= (dx / d) * p; a.z -= (dz / d) * p; b.x += (dx / d) * p; b.z += (dz / d) * p;
    }
  }

  // morale: recovery, routs
  for (const u of live) {
    if (u.dead) continue;
    const half2 = half - 1;
    u.x = Math.max(-half2, Math.min(half2, u.x)); u.z = Math.max(-half2, Math.min(half2, u.z));
    if (u.acc >= 3 && s.t - u.accT > 0.8) { ev(sim, { k: 'dmg', x: u.x, z: u.z, side: u.side, n: Math.round(u.acc) }); u.acc = 0; u.accT = s.t; }
    if (u.routed) continue;
    if (u.hurt > 6) u.morale = Math.min(u.maxMorale, u.morale + 1.5 * dt);
    if (u.aura) u.morale = Math.min(u.maxMorale, u.morale + tu.commanderAura.regen * dt);
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

  // smoke ageing
  for (const p of s.smoke) p.age += dt;
  s.smoke = s.smoke.filter((p: any) => p.age < tu.smoke.life);

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
      if (e.go) { u.tx = e.go.x + (i - (defs.length - 1) / 2) * 10 * (e.spreadX ?? 1); u.tz = e.go.z + (i - (defs.length - 1) / 2) * 10 * (e.spreadZ ?? 0); }
    });
  }
}

function finish(sim: Sim, alive: boolean[]) {
  const s = sim.s, sc = [s.side[0].score, s.side[1].score];
  // final verdict: objectives held at the end count more than points banked along the way
  const held = [0, 0];
  for (const z of s.zones) if (z.owner != null) held[z.owner] += z.value;
  const hr = held[0] + held[1] ? held[0] / (held[0] + held[1]) : 0.5;
  const w = sim.tu.endHeldWeight;
  const ratio = w * hr + (1 - w) * (sc[0] / Math.max(1, sc[0] + sc[1]));
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
