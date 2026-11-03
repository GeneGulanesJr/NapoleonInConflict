// ---------------------------------------------------------------- random skirmish
/** A self-contained scenario with a random map and forces, from a seed. */
export function makeSkirmish(seed: number): any {
  return scaleScenario(makeSkirmishBase(seed), 1.5);
}
/** scale a scenario's coordinates (the campaign data files are already scaled this way) */
export function scaleScenario(j: any, M: number): any {
  const f = (n: number) => Math.round(n * M * 10) / 10, m = j.map;
  m.size = Math.round(m.size * M);
  for (const h of m.hills ?? []) { h.x = f(h.x); h.z = f(h.z); h.rx = f(h.rx); h.rz = f(h.rz); }
  for (const w of m.woods ?? []) { w.x = f(w.x); w.z = f(w.z); w.r = f(w.r); }
  for (const v of m.villages ?? []) { v.x = f(v.x); v.z = f(v.z); v.r = Math.round(v.r * 1.2 * 10) / 10; }
  for (const r of m.rivers ?? []) { r.pts = r.pts.map((q: number[]) => q.map(f)); r.bridges = r.bridges.map((q: number[]) => q.map(f)); r.width = Math.round(r.width * 1.2 * 10) / 10; }
  for (const h of [...(m.hedges ?? []), ...(m.roads ?? [])]) h.pts = h.pts.map((q: number[]) => q.map(f));
  if (m.rough) m.rough.scale = f(m.rough.scale);
  for (const z of j.zones) { z.x = f(z.x); z.z = f(z.z); z.r = Math.round(z.r * 1.2 * 10) / 10; }
  for (const e of j.entry) { e.x = f(e.x); e.z = f(e.z); }
  const sg = (gs: any[]) => { for (const g of gs) for (const k of ['x', 'z', 'dx', 'dz']) if (k in g) g[k] = f(g[k]); };
  for (const side of j.forces) sg(side);
  for (const e of j.timeline ?? []) { for (const k of ['entry', 'go']) if (e[k]) { e[k].x = f(e[k].x); e[k].z = f(e[k].z); } if (e.units) sg(e.units); }
  j.duration = Math.round(j.duration * 1.2);
  return j;
}
function makeSkirmishBase(seed: number): any {
  let q = seed | 0; // not seed | 1: that gave seeds 2k and 2k+1 the same map
  const r = () => { q = (q + 0x6d2b79f5) | 0; let t = Math.imul(q ^ (q >>> 15), q | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)], rr = (a: number, b: number) => Math.round(a + r() * (b - a));
  const size = 220, names = ['Mont-Saint-Pierre', 'La Belle-Alliance', 'Ferme du Bois', 'Les Quatre Vents', 'Haut-Fays', 'Saint-Aubin', 'Le Moulin', 'Fresnes'];
  const vs = [-1, 0, 1].map((k, i) => ({ name: names.splice(rr(0, names.length - 1), 1)[0], x: k * rr(45, 70) + rr(-8, 8), z: rr(-18, 18), r: rr(6, 8), garrison: i !== 1 || r() < 0.5 }));
  const river = r() < 0.6 ? [{ pts: [[-110, rr(-6, 6)], [-40, rr(-14, 0)], [40, rr(0, 14)], [110, rr(-6, 6)]], width: 9, bridges: [] as number[][], ...(r() < 0.5 ? { ford: 0.5 } : {}) }] : []; // half the streams can be waded
  if (river.length) { const p = river[0].pts; river[0].bridges = [[-45, p[1][1]], [vs[1].x, (p[1][1] + p[2][1]) / 2], [45, p[2][1]]]; }
  const zones = vs.map((v, i) => ({ id: 'v' + i, name: v.name, x: v.x, z: v.z, r: 12, value: i === 1 ? 4 : 2.5, owner: i === 1 ? 1 : null }));
  const cav = () => pick(['lancer', 'cuirassier']);
  const army = (side: number) => {
    const z0 = side === 0 ? 72 : -72, sgn = side === 0 ? 1 : -1;
    const g: any[] = [{ type: 'line', n: rr(4, 5), x: -45, z: z0 - sgn * 8, dx: 22 }, { type: 'skirmisher', n: rr(1, 2), x: -20, z: z0 - sgn * 24, dx: 40 }, { type: 'artillery', n: rr(1, 2), x: -25, z: z0 + sgn * 6, dx: 50 }, { type: cav(), n: rr(1, 2), x: 30, z: z0 + sgn * 14, dx: 45 }];
    if (r() < 0.5) g.push({ type: 'guard', n: 1, x: 0, z: z0 + sgn * 4 });
    g.push({ type: 'commander', n: 1, x: 0, z: z0 + sgn * 30, names: [side === 0 ? 'The Marshal' : 'The General'] });
    return g;
  };
  return {
    id: 'skirmish', title: 'Random Skirmish', date: `Seed ${seed}`, blurb: 'A meeting engagement on unknown ground. Scout, take the villages, and hold them.', hint: 'Garrison a farm by right-clicking it. Flank and rear attacks hurt.',
    strength: [1, 1.5], duration: 600, clock: { start: '12:00', hours: 4 }, weather: pick(['clear', 'clear', 'rain']),
    map: { size, rough: { amp: 0.6 + r() * 0.6, scale: rr(30, 55), seed: rr(1, 9999) }, hills: [0, 1].map(() => ({ x: rr(-60, 60), z: rr(-50, 50), rx: rr(25, 55), rz: rr(10, 18), h: rr(3, 7), rot: rr(-40, 40), p: pick([1, 2]) })),
      roads: [{ pts: [[rr(-30, 30), 110], [vs[1].x, vs[1].z], [rr(-30, 30), -110]], w: 4 }], woods: [0, 1, 2].map(() => ({ x: rr(-85, 85), z: rr(-45, 45), r: rr(9, 16) })), rivers: river, villages: vs, hedges: [{ pts: [[-60, rr(-40, -26)], [60, rr(-40, -26)]] }] },
    zones, entry: [{ x: 0, z: 102 }, { x: 0, z: -102 }], rpStart: [20, 20], reserves: [{ line: 2, artillery: 1 }, { line: 2, artillery: 1 }],
    abilities: [['barrage', 'cavalry'], ['barrage', 'rockets']], cavalryName: ['Reserve Cavalry', 'Reserve Cavalry'], nat: ['fr', 'gb'], bot: ['attack', 'defend'],
    forces: [army(0), army(1)], timeline: [{ t: 240, type: 'reinforce', side: 1, units: [{ type: 'line', n: 2, x: 0, z: 0 }], entry: { x: 0, z: -102 }, go: { x: 0, z: -40 } }],
  };
}
