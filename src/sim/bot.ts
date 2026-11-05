// Bot commander. Uses the same command() API as a human player, so it plays by the same rules.
import { command, foot, rand, solid, useAbility, type Sim } from './sim.ts';
import { los } from './world.ts';

const dist = (a: any, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
/** a square too strong for this cavalry regiment to charge */
const firm = (e: any, cav: any, tu: any) => e.form === 'square' && !e.routed && solid(e, cav) > 0.5 && !(e.busy > 0 && dist(e, cav) / tu.types[cav.type].speed < e.busy); // a square that would still be forming when the horse arrive is not firm: ride it down
/** u stands in front of e (the sim's aspect test: front when the cosine is over 0.5) */
const ahead = (u: any, e: any) => ((u.x - e.x) * Math.sin(e.facing) + (u.z - e.z) * Math.cos(e.facing)) / (dist(u, e) || 1) > 0.5;
/** e's flank on u's side: where u stands square to e's facing, its frontage clear of e's by `gap`, a little behind e's front so the approach swings wide of anyone fighting it from the front */
function flankOf(e: any, u: any, gap: number, tu: any) {
  const hw = (q: any) => { const f = foot(q, tu); return (f[1] - f[0]) / 2; }, off = hw(e) + hw(u) + gap;
  const rx = Math.cos(e.facing), rz = -Math.sin(e.facing), sg = Math.sign((u.x - e.x) * rx + (u.z - e.z) * rz) || 1;
  return { x: e.x + rx * sg * off - Math.sin(e.facing) * 6, z: e.z + rz * sg * off - Math.cos(e.facing) * 6 };
}

export function makeBot(sim: Sim, side: number) {
  return (dt: number) => {
    // the bot's memory lives in the sim state (sim.s may be swapped for a save or keyframe), so a resumed battle or a seek carries on exactly
    const b = ((sim.s.bots ??= [])[side] ??= { acc: 1.5, mem: { assign: {}, mend: {} } });
    const mem: { assign: Record<number, { zid: string; ox: number; oz: number }>; mend: Record<number, boolean> } = b.mem;
    b.acc += dt;
    // every tick, not every 2s: a galloping regiment must pull up the moment its target forms a firm square
    // ...and ride back out of musket range instead of idling where the square can shoot it down
    for (const u of sim.s.units) if (u.side === side && u.chase != null && (u.type === 'lancer' || u.type === 'cuirassier')) {
      const t = sim.s.units.find((q: any) => q.id === u.chase);
      if (t && firm(t, u, sim.tu)) { const d = dist(u, t) || 1; command(sim, side, { c: 'move', ids: [u.id], x: t.x + ((u.x - t.x) / d) * 50, z: t.z + ((u.z - t.z) / d) * 50 }); }
    }
    if (b.acc < [2.5, 2, 1.2][sim.scn.skill ?? 1]) return; // Easy / Normal / Hard: how often the bot thinks
    b.acc = 0;
    think(sim, side, mem);
  };
}

function think(sim: Sim, side: number, mem: any) {
  const { s, scn, tu } = sim;
  if (s.over) return;
  const stance: string = scn.bot?.[side] ?? (side === 0 ? 'attack' : 'defend');
  const sd = s.side[side];
  const my = s.units.filter((u: any) => u.side === side && !u.dead && !u.routed);
  const sv = (e: any) => !s.fog || s.seen[side].includes(e.id); // the bot only knows what it can see
  const enemies = s.units.filter((u: any) => u.side !== side && !u.dead && sv(u));
  const foes = enemies.filter((u: any) => !u.routed);
  // flanking: a formed foe already busy with another of our regiments (in melee, or facing it at musket range) is worth going round; one flanker per foe
  const pinned = (e: any, u: any) => e.garrison == null && e.form !== 'square' && !tu.types[e.type].cav && my.some((f: any) => f !== u && (f.eng === e.id || e.eng === f.id || (dist(f, e) < 25 && ahead(f, e))));
  const claimed: Record<number, number> = {};
  const flankTarget = (u: any, range: number) => {
    let t: any = null, td = range;
    for (const e of foes) { const d = dist(u, e); if (d < td && (claimed[e.id] ?? u.id) === u.id && pinned(e, u)) { td = d; t = e; } }
    if (t) claimed[t.id] = u.id;
    return t;
  };
  // an enemy battery can reach this spot with a clear line over the ground
  const guns = foes.filter((e: any) => e.type === 'artillery'), shelled = (x: number, zz: number) => guns.some((g: any) => Math.hypot(g.x - x, g.z - zz) < tu.types.artillery.range && los(scn, g.x, g.z, 2, x, zz, 2));
  const horse = my.filter((u: any) => (u.type === 'lancer' || u.type === 'cuirassier') && u.draftFor == null), reserve = stance === 'attack' && horse.length > 1 ? horse[0] : null; // attacking, one regiment of horse is kept back to counter-charge

  // replenish weak regiments resting on our objectives first (they keep their veterancy), then spend what is left on reserves
  const onOurs = (u: any) => s.zones.some((z: any) => z.owner === side && dist(u, z) < z.r);
  const weak = my.filter((u: any) => u.type !== 'commander' && !u.refill && u.men < 0.6 * u.maxMen && u.eng == null && onOurs(u));
  if (weak.length && sd.rp > 5) command(sim, side, { c: 'replenish', ids: weak.map((u: any) => u.id) });
  const afford = Object.keys(sd.reserves).filter((t) => sd.reserves[t] > 0 && tu.types[t].cost <= sd.rp);
  if (afford.length && s.t > 15 && !my.some((u: any) => u.refill && onOurs(u))) command(sim, side, { c: 'deploy', type: afford[Math.floor(rand(s) * afford.length)] });

  // tactical aid
  for (const name of scn.abilities?.[side] ?? []) {
    if ((sd.cd[name] ?? 0) > 0 || !foes.length || s.t < [60, 45, 30][scn.skill ?? 1]) continue; // grace period so the player can react
    const ab = tu.abilities[name];
    if (name === 'cavalry') {
      if (s.t < 90) continue;
      const art = foes.find((e: any) => e.type === 'artillery') ?? foes[0];
      useAbility(sim, side, name, art.x, art.z);
    } else {
      let best: any = null, bs = 0;
      for (const e of foes) {
        if (!my.some((f: any) => dist(f, e) < 110) || (name === 'barrage' && e.mv)) continue; // needs a spotter; guns do not lay on men who are marching
        let sc = 0;
        for (const o of foes) if (dist(o, e) < ab.r) sc += o.men / 270;
        for (const f of my) if (dist(f, e) < ab.r * 1.2) sc -= 3; // keep clear of own men
        if (sc > bs) { bs = sc; best = e; }
      }
      if (best && bs >= (name === 'barrage' ? 4 : 1)) useAbility(sim, side, name, best.x, best.z);
    }
  }

  // zone assignment
  const mineZones = s.zones.filter((z: any) => z.owner === side);
  const goalZones = stance === 'attack' ? s.zones.filter((z: any) => z.owner !== side) : mineZones.length ? mineZones : s.zones;
  const en = scn.entry[side], retreat = stance === 'retreat'; // a rearguard falls back toward its own map edge, fighting whatever catches it, instead of holding ground
  const zones = retreat ? [{ id: 'home', x: en.x * 0.84, z: en.z * 0.84, r: 45 }] : goalZones.length ? goalZones : s.zones;
  const load: Record<string, number> = {};
  for (const id in mem.assign) { const a = mem.assign[id]; load[a.zid] = (load[a.zid] ?? 0) + 1; }

  for (const u of my) {
    if (u.busy > 0 || u.draftFor != null) continue; // drafts march to their regiment on their own
    if (u.march) { if (u.tx != null || u.chase != null) continue; u.march = false; } // a scripted reinforcement keeps to its route (e.g. Bülow on Plancenoit) until it gets there
    const T = tu.types[u.type];
    if (u.type === 'commander') { // stay with the army, rally broken men
      const inf = my.filter((f: any) => f !== u && f.type !== 'commander');
      if (inf.length) {
        const cx = inf.reduce((q: number, f: any) => q + f.x, 0) / inf.length, cz = inf.reduce((q: number, f: any) => q + f.z, 0) / inf.length + (side === 0 ? 14 : -14);
        if (dist(u, { x: cx, z: cz }) > 26 && (u.tx == null || Math.hypot(u.tx - cx, u.tz - cz) > 12)) command(sim, side, { c: 'move', ids: [u.id], x: cx, z: cz });
      }
      if (s.t >= u.spReady && s.units.some((f: any) => f.side === side && f.routed && dist(f, u) < tu.commanderAura.rallyRadius)) command(sim, side, { c: 'special', ids: [u.id] });
      continue;
    }
    let near: any = null, nd = 1e9;
    for (const e of foes) { const d = dist(u, e); if (d < nd) { nd = d; near = e; } }

    const spc = tu.specials?.[u.type];
    if (spc && s.t >= u.spReady && s.t > 20 && near) {
      const k = spc.kind, ct = u.chase != null ? enemies.find((e: any) => e.id === u.chase) : null;
      if ((k === 'volley' && nd < T.range * 0.8 && !u.mv) || (k === 'canister' && nd < tu.canisterRange * tu.canisterSpecial.reach) || (k === 'sprint' && nd < 70 && nd > 25) || (k === 'charge' && ct && dist(u, ct) < 35)) command(sim, side, { c: 'special', ids: [u.id] }); // the Charge sounds ~25-35 out from its target (thinking every 2 s), so it carries home at the gallop
    }
    // pick / refresh a goal zone
    let a = mem.assign[u.id];
    if (!a || !zones.some((z: any) => z.id === a.zid)) {
      if (a) load[a.zid]--;
      let bz: any = null, bsc = 1e9;
      for (const z of zones) { const sc = dist(u, z) + 70 * (load[z.id] ?? 0); if (sc < bsc) { bsc = sc; bz = z; } }
      const ang = rand(s) * Math.PI * 2, rr = Math.sqrt(rand(s)) * bz.r * 0.7;
      a = mem.assign[u.id] = { zid: bz.id, ox: Math.cos(ang) * rr, oz: Math.sin(ang) * rr };
      load[bz.id] = (load[bz.id] ?? 0) + 1;
    }
    const z = (retreat ? zones : s.zones).find((q: any) => q.id === a.zid);
    const gx = z.x + a.ox, gz = z.z + a.oz;
    const goto = (x: number, zz: number) => {
      if (u.tx != null && Math.hypot(u.tx - x, u.tz - zz) < 4) return;
      command(sim, side, { c: 'move', ids: [u.id], x, z: zz });
    };
    const hold = () => { if (u.tx != null || u.chase != null) command(sim, side, { c: 'stop', ids: [u.id] }); };
    // worn down: fall back to the nearest quiet objective we hold, take on replacements there (the replenish rule above), then rejoin. Regiments defending one of our objectives stay put.
    const dry = T.ammo && u.ammo < 3, wet = !T.ammo || u.ammo >= 0.7 * T.ammo; // nearly out of ammunition: fall back to a depot to take more on
    if ((dry || (u.men < 0.4 * u.maxMen && sd.pool >= 1 && sd.rp > 10)) && u.garrison == null && !s.zones.some((q: any) => q.owner === side && dist(u, q) < q.r)) mem.mend[u.id] = true;
    if (mem.mend[u.id]) {
      const dz = mineZones.filter((q: any) => !q.contested).sort((p: any, q: any) => dist(u, p) - dist(u, q))[0];
      if (!dz || (u.men >= 0.95 * u.maxMen && wet) || (dist(u, dz) < dz.r && !u.refill && wet)) delete mem.mend[u.id]; // done, nowhere to go, or no money to refill: back to the fight
      else { if (dist(u, dz) > dz.r * 0.5) goto(dz.x, dz.z); else hold(); continue; }
    }
    if (stance === 'defend' && u.garrison == null && u.gTarget == null && (u.type === 'line' || u.type === 'guard' || u.type === 'skirmisher')) { // man the farm that sits on our objective
      const vs = scn.map.villages ?? [], vi = vs.findIndex((v: any) => v.garrison && dist(v, z) < 25);
      if (vi >= 0 && s.units.filter((q: any) => q.side === side && (q.garrison === vi || q.gTarget === vi)).length < tu.garrison.capacity) { command(sim, side, { c: 'garrison', ids: [u.id], vid: vi }); continue; }
    }
    if (u.garrison != null || u.gTarget != null) continue;

    if (u.type === 'line' || u.type === 'guard') {
      const hf = stance === 'defend' && near && near.mv && nd < 45 && (near.form === 'column' || tu.types[near.type].cav) ? 'holdfire' : 'hold'; // let a column or horse coming on close in, then give it the heavy first volley
      if (u.stance !== hf) command(sim, side, { c: 'stance', ids: [u.id], s: hf });
      const cavD = foes.reduce((m: number, e: any) => (tu.types[e.type].cav && e.type !== 'commander' ? Math.min(m, dist(u, e)) : m), 1e9); // the bot forms square by hand, when it sees horse close in (it thinks every 2 s), and breaks it up when they are gone
      if (cavD < 60 && u.form !== 'square') { command(sim, side, { c: 'form', ids: [u.id], f: 'square' }); hold(); continue; }
      if (u.form === 'square') { if (cavD > 90 && u.busy <= 0) command(sim, side, { c: 'form', ids: [u.id], f: 'line' }); hold(); continue; }
      if (u.chase != null) continue;
      // bayonet charge when clearly stronger locally
      if (stance === 'attack' && near && nd < 22 && u.morale > 60 && u.fat < 0.5 && near.morale < 0.6 * near.maxMorale) { // go in with the bayonet once the foe wavers
        let mine = 0, theirs = 0;
        for (const f of my) if (dist(f, near) < 40) mine += f.men;
        for (const e of foes) if (dist(e, near) < 40) theirs += e.men;
        if (mine > 2.2 * theirs) { command(sim, side, { c: 'bayonet', ids: [u.id], target: near.id }); continue; }
      }
      if (near && nd <= T.range * 1.05) { hold(); if (u.form !== 'line') command(sim, side, { c: 'form', ids: [u.id], f: 'line' }); continue; }
      const ft = stance === 'attack' ? flankTarget(u, 80) : null;
      if (ft) { // go round to its flank and fire into it from there
        const p = flankOf(ft, u, T.range * 0.6, tu); // within musket range of its flank
        if (dist(u, p) < 30 && u.form !== 'line') command(sim, side, { c: 'form', ids: [u.id], f: 'line' });
        if (dist(u, p) < 5) hold(); else goto(p.x, p.z);
        continue;
      }
      const far = dist(u, { x: gx, z: gz }) > 50 && nd > 70;
      const want = far ? 'column' : 'line';
      if (u.form !== want && !(want === 'column' && u.form === 'line' && dist(u, { x: gx, z: gz }) < 90)) command(sim, side, { c: 'form', ids: [u.id], f: want });
      let rs: any = null; // reverse slope: a post in the zone that a crest hides from their guns
      if (stance === 'defend' && nd > 40 && shelled(u.tx ?? u.x, u.tz ?? u.z)) for (let i = 0; i < 6 && !rs; i++) { const ang = rand(s) * Math.PI * 2, rr = Math.sqrt(rand(s)) * z.r * 0.7, p = { x: z.x + Math.cos(ang) * rr, z: z.z + Math.sin(ang) * rr }; if (!shelled(p.x, p.z)) rs = p; }
      if (rs) { a.ox = rs.x - z.x; a.oz = rs.z - z.z; command(sim, side, { c: 'move', ids: [u.id], x: rs.x, z: rs.z, f: Math.atan2(near.x - rs.x, near.z - rs.z) }); } // ...arriving faced towards the foe
      else if (dist(u, { x: gx, z: gz }) > 4 && (stance === 'attack' || dist(u, z) > z.r)) goto(gx, gz);
    } else if (u.type === 'skirmisher') {
      if (near && nd <= T.range * 0.95) { hold(); continue; }
      if (dist(u, { x: gx, z: gz }) > 4 && (stance === 'attack' || dist(u, z) > z.r)) goto(gx, gz);
    } else if (u.type === 'artillery') {
      if (!near) { if (stance === 'attack') goto(gx, gz + (side === 0 ? 40 : -40)); continue; }
      if (nd < 24 && near.type !== 'artillery') { goto(u.x + (u.x - near.x) * 0.5, u.z + (u.z - near.z) * 0.5); continue; }
      if (nd > T.range * 0.92 && stance === 'attack') { goto(u.x + ((near.x - u.x) / nd) * (nd - T.range * 0.85), u.z + ((near.z - u.z) / nd) * (nd - T.range * 0.85)); continue; }
      // lay the guns on the most valuable target in reach (the sim fires on the ordered target): columns and squares, shaken or stunned regiments, a battery shelling us
      let tg: any = null, tv = 0;
      for (const e of foes) {
        const d = dist(u, e);
        if (d > T.range * 0.9 || !los(scn, u.x, u.z, 2, e.x, e.z, 2)) continue; // only what it can hit from here: an attack order on anything else sends the guns after it
        const v = (e.type === 'artillery' && e.fired < 10 ? 2 : tu.types[e.type].cav ? 0.8 : e.type === 'skirmisher' ? 0.6 : tu.artDmg[e.form] ?? 1) * (e.shaken > 0 || e.stun > 0 ? 1.5 : 1) * (1 - (0.5 * d) / T.range);
        if (v > tv) { tv = v; tg = e; }
      }
      if (!tg) hold();
      else if (u.chase !== tg.id) command(sim, side, { c: 'attack', ids: [u.id], target: tg.id });
    } else {
      // cavalry: hunt foot that cannot form square (shaken or stunned), guns, skirmishers, routers and thin lines; avoid squares
      const wedge = () => { if (u.form !== 'wedge') command(sim, side, { c: 'form', ids: [u.id], f: 'wedge' }); }; // form the wedge for the charge, back to squadron once the foe is far
      if (u.chase == null && u.eng == null && u.form === 'wedge' && nd > 110) command(sim, side, { c: 'form', ids: [u.id], f: 'squadron' });
      if (u.chase != null) continue;
      const rsv = u === reserve;
      let prey: any = null, pv = 0;
      for (const e of rsv ? [] : enemies) {
        const d = dist(u, e);
        if (d > 95 || firm(e, u, tu)) continue;
        const fo = !tu.types[e.type].cav && e.type !== 'artillery' && e.type !== 'skirmisher';
        const w = fo && (e.shaken > 0 || e.stun > 0) && e.form !== 'square' ? 3 : e.type === 'artillery' ? 2.5 : e.type === 'skirmisher' ? 2
          : e.routed ? 2.5 : (fo && e.morale < 70) || e.form === 'column' || e.form === 'square' ? 1 : 0; // a square that is not firm is outnumbered
        if (w / (d + 10) > pv) { pv = w / (d + 10); prey = e; }
      }
      const fit = u.morale > 45 && u.men > 0.3 * u.maxMen, ft = fit && !prey && !rsv ? flankTarget(u, 120) : null;
      const ht = rsv && fit ? foes.find((e: any) => tu.types[e.type].cav && e.type !== 'commander' && dist(u, e) < 100 && my.some((f: any) => (f.type === 'line' || f.type === 'guard') && (f.eng === e.id || e.eng === f.id))) : null; // the reserve rides at enemy horse in among our foot
      if (ht) { wedge(); command(sim, side, { c: 'attack', ids: [u.id], target: ht.id }); }
      else if (prey && fit) { wedge(); command(sim, side, { c: 'attack', ids: [u.id], target: prey.id }); }
      else if (ft) { // ride round to its flank, then charge (defending horse counter-attacks this way too)
        const p = flankOf(ft, u, 4, tu);
        if (!ahead(u, ft) || dist(u, p) < 6) { wedge(); command(sim, side, { c: 'attack', ids: [u.id], target: ft.id }); } else goto(p.x, p.z);
      } else if (stance === 'attack') {
        const inf = my.filter((f: any) => f.type === 'line' || f.type === 'guard');
        if (inf.length) {
          const cx = inf.reduce((q: number, f: any) => q + f.x, 0) / inf.length, cz = inf.reduce((q: number, f: any) => q + f.z, 0) / inf.length;
          if (dist(u, { x: cx, z: cz }) > 30) goto(cx + a.ox, cz + (side === 0 ? 1 : -1) * (rsv ? 30 : 14)); // the reserve waits further back
        } else goto(gx, gz);
      } else if (dist(u, z) > z.r * 1.5) goto(gx, gz);
    }
  }
}
