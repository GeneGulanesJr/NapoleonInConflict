// Terrain queries shared by the simulation, the bots and the renderer.
// shortcut: Scn/Tuning are `any` (they are JSON); add schemas if the data files grow.

const C = 2; // height-cache spacing (units); grid points sit on multiples of C
const grids = new WeakMap<any, { i0: number; n: number; g: Float64Array }>();

/** integer lattice hash -> [-1, 1) */
const ih = (x: number, z: number, s: number) => { let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(s, 1274126177)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1; };
function vnoise(x: number, z: number, s: number) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  return (ih(ix, iz, s) * (1 - u) + ih(ix + 1, iz, s) * u) * (1 - v) + (ih(ix, iz + 1, s) * (1 - u) + ih(ix + 1, iz + 1, s) * u) * v;
}

/** Analytic smooth ground of a map (no sunken lanes): rolling base (map.rough fBm, else the old sine) + rotated/plateau hills. */
export function groundAt(m: any, x: number, z: number): number {
  const r = m.rough;
  let h = r ? (r.amp * (vnoise(x / r.scale, z / r.scale, r.seed) + 0.5 * vnoise((2 * x) / r.scale, (2 * z) / r.scale, r.seed + 1) + 0.25 * vnoise((4 * x) / r.scale, (4 * z) / r.scale, r.seed + 2))) / 1.75
    : 0.6 * Math.sin(x * 0.045) * Math.cos(z * 0.06);
  for (const k of m.hills ?? []) {
    const a = ((k.rot ?? 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), dx = x - k.x, dz = z - k.z;
    const lx = (dx * c + dz * s) / k.rx, lz = (-dx * s + dz * c) / k.rz;
    h += k.h * Math.exp(-((lx * lx + lz * lz) ** (k.p ?? 1)));
  }
  return h;
}

/** groundAt sampled bilinearly from a per-map grid (built once): heightAt runs per unit per tick and per vertex. */
function smoothAt(m: any, x: number, z: number): number {
  let G = grids.get(m);
  if (!G) {
    const i0 = Math.floor(-((m.size ?? 400) / 2 + 6) / C), n = 1 - 2 * i0, g = new Float64Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) g[j * n + i] = groundAt(m, (i0 + i) * C, (i0 + j) * C);
    grids.set(m, (G = { i0, n, g }));
  }
  const gx = x / C - G.i0, gz = z / C - G.i0, i = Math.floor(gx), j = Math.floor(gz), n = G.n, g = G.g;
  if (i < 0 || j < 0 || i >= n - 1 || j >= n - 1) return groundAt(m, x, z); // off the board
  const fx = gx - i, fz = gz - j, k = j * n + i;
  return (g[k] * (1 - fx) + g[k + 1] * fx) * (1 - fz) + (g[k + n] * (1 - fx) + g[k + n + 1] * fx) * fz;
}

export function heightAt(scn: any, x: number, z: number): number {
  let h = smoothAt(scn.map, x, z);
  for (const l of scn.map.lanes ?? []) { const d = lineDist(l.pts, x, z); if (d < l.w) h -= l.depth * Math.min(1, (l.w - d) / (l.w * 0.4)); } // sunken lane
  return h;
}

/** Clear sight line between two eyes (eye = height above the ground): blocked by rising ground, or by a deep belt of woods (~14 units, ~8 dense; the ~6 units at each end don't count, so troops at a wood's edge see out). */
export function los(scn: any, ax: number, az: number, aEye: number, bx: number, bz: number, bEye: number): boolean {
  const m = scn.map, L = Math.hypot(bx - ax, bz - az), n = Math.ceil(L / 3), ha = heightAt(scn, ax, az) + aEye, hb = heightAt(scn, bx, bz) + bEye;
  let wood = 0;
  for (let i = 1; i < n; i++) {
    const t = i / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    if (smoothAt(m, x, z) > ha + (hb - ha) * t + 0.3) return false;
    if (t * L > 6 && (1 - t) * L > 6) for (const w of m.woods ?? []) if (Math.hypot(x - w.x, z - w.z) < w.r) { wood += (L / n) * (w.dense ? 14 / 8 : 1); if (wood > 14) return false; break; }
  }
  return true;
}

export function lineDist(pts: number[][], x: number, z: number) {
  let m = 1e9;
  for (let i = 0; i + 1 < pts.length; i++) m = Math.min(m, segDist(x, z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  return m;
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** The river whose water is here (off its bridges), or null; deep = ignore fordable rivers. */
export function riverAt(scn: any, x: number, z: number, deep = false): any {
  for (const r of scn.map.rivers ?? []) {
    if (deep && r.ford) continue;
    if (r.bridges.some(([bx, bz]: number[]) => Math.hypot(x - bx, z - bz) < 7)) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) if (segDist(x, z, r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1]) < r.width / 2) return r;
  }
  return null;
}

const nearGrids = new WeakMap<object, Uint8Array>();
/** The deep river whose water is here, as riverAt(.., true), with an O(1) early-out: a 4-unit grid, baked once per map, marks the cells within reach of deep water. */
export function deepAt(scn: any, x: number, z: number): any {
  const m = scn.map, half = m.size / 2 + 6, n = Math.ceil((2 * half) / 4);
  let G = nearGrids.get(m);
  if (!G) {
    G = new Uint8Array(n * n);
    for (const r of m.rivers ?? []) if (!r.ford) for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1], reach = r.width / 2 + 4 * 0.71 + 1.5; // half the water + a cell's half-diagonal + margin
      for (let cz = Math.max(0, Math.floor((Math.min(az, bz) - reach + half) / 4)); cz <= Math.min(n - 1, Math.floor((Math.max(az, bz) + reach + half) / 4)); cz++)
        for (let cx = Math.max(0, Math.floor((Math.min(ax, bx) - reach + half) / 4)); cx <= Math.min(n - 1, Math.floor((Math.max(ax, bx) + reach + half) / 4)); cx++)
          if (segDist(-half + (cx + 0.5) * 4, -half + (cz + 0.5) * 4, ax, az, bx, bz) < reach) G[cz * n + cx] = 1;
    }
    nearGrids.set(m, G);
  }
  const X = Math.floor((x + half) / 4), Z = Math.floor((z + half) / 4);
  return X >= 0 && Z >= 0 && X < n && Z < n && !G[Z * n + X] ? null : riverAt(scn, x, z, true);
}

/** cover = damage multiplier for a unit standing here; wood (0, 1, 2 = dense), village, road, river (the river being waded, or null) drive movement (tuning.terrain). */
export function featureAt(scn: any, x: number, z: number) {
  let cover = 1, kind = 'open', wood = 0, village = false, road = false;
  for (const w of scn.map.woods ?? []) if (Math.hypot(x - w.x, z - w.z) < w.r) { cover = Math.min(cover, 0.65); wood = Math.max(wood, w.dense ? 2 : 1); kind = 'wood'; }
  for (const v of scn.map.villages ?? []) if (Math.hypot(x - v.x, z - v.z) < v.r) { cover = Math.min(cover, 0.5); village = true; kind = 'village'; }
  for (const r of scn.map.roads ?? []) if (lineDist(r.pts, x, z) < r.w * 0.7) { road = true; kind = 'road'; }
  const river = riverAt(scn, x, z);
  if (river) kind = 'river';
  for (const l of scn.map.lanes ?? []) if (lineDist(l.pts, x, z) < l.w * 0.7) { cover = Math.min(cover, 0.7); kind = 'lane'; }
  for (const hd of scn.map.hedges ?? []) if (lineDist(hd.pts, x, z) < 2.2) cover = Math.min(cover, 0.85);
  return { cover, kind, wood, village, road, river };
}

/** Unit normal of the river at a bridge (nx, nz): the way over the deck. */
function bridgeNormal(r: any, qx: number, qz: number): [number, number] {
  let bd = 1e9, nx = 0, nz = 1;
  for (let i = 0; i + 1 < r.pts.length; i++) {
    const [px, pz] = r.pts[i], dx = r.pts[i + 1][0] - px, dz = r.pts[i + 1][1] - pz, d = segDist(qx, qz, px, pz, r.pts[i + 1][0], r.pts[i + 1][1]), L = Math.hypot(dx, dz) || 1;
    if (d < bd) { bd = d; nx = -dz / L; nz = dx / L; }
  }
  return [nx, nz];
}

/** Deep water is impassable, so a crossing is walked in three legs along the bridge's own axis: the near bank, the deck, dry ground on the goal's side. Returns the next waypoint, or null if the straight line is dry (fords are waded). */
export function detour(scn: any, ax: number, az: number, bx: number, bz: number): { x: number; z: number } | null {
  const rivers = (scn.map.rivers ?? []).filter((r: any) => !r.ford);
  if (!rivers.length) return null;
  const wades = (x0: number, z0: number, x1: number, z1: number) => {
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 3);
    for (let i = 1; i <= n; i++) if (riverAt(scn, x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n, true)) return true;
    return false;
  };
  for (const r of rivers) for (const [qx, qz] of r.bridges) { // on the deck's centre: carry on over it
    if (Math.hypot(ax - qx, az - qz) >= 4.5) continue;
    const [nx, nz] = bridgeNormal(r, qx, qz), e = r.width / 2 + 3;
    const out = [1, -1].map((g) => ({ g, x: qx + nx * g * e, z: qz + nz * g * e })).filter((c) => !wades(c.x, c.z, bx, bz)).sort((p, q) => Math.hypot(p.x - bx, p.z - bz) - Math.hypot(q.x - bx, q.z - bz))[0]; // the end with dry going to the goal, nearer one first
    if (out && ((ax - qx) * nx + (az - qz) * nz) * out.g < e - 1.5) return { x: out.x, z: out.z };
  }
  if (!wades(ax, az, bx, bz)) return null;
  let best: { x: number; z: number } | null = null, bc = 1e9;
  for (const r of rivers) for (const [qx, qz] of r.bridges) {
    const c = Math.hypot(qx - ax, qz - az) + Math.hypot(bx - qx, bz - qz); if (c >= bc) continue;
    const [nx, nz] = bridgeNormal(r, qx, qz), sa = Math.sign((ax - qx) * nx + (az - qz) * nz) || 1, e = r.width / 2 + 3, ex = qx + nx * sa * e, ez = qz + nz * sa * e;
    if (wades(ax, az, ex, ez) || wades(qx - nx * sa * e, qz - nz * sa * e, bx, bz)) continue; // the near-bank point and the far-bank point must both be reachable dry
    bc = c; best = Math.hypot(ax - ex, az - ez) > 5 ? { x: ex, z: ez } : { x: qx, z: qz };
  }
  return best ?? route(scn, ax, az, bx, bz);
}

const RC = 3, dryGrids = new WeakMap<object, Uint8Array>(); // pathfinding grid per map: 1 = deep water, baked on first use
/** No bridge fits (a river bends across the straight line): A* round the water on a 3-unit grid, then the farthest corner of that path still in a dry straight line. */
function route(scn: any, ax: number, az: number, bx: number, bz: number): { x: number; z: number } | null {
  const half = scn.map.size / 2 + 6, n = Math.ceil((2 * half) / RC);
  let W = dryGrids.get(scn.map);
  if (!W) { // a cell is closed if deep water lies within 2 units of its centre, so paths keep off the bank and a step never clips the water
    W = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) { const x = -half + ((i % n) + 0.5) * RC, z = -half + (Math.floor(i / n) + 0.5) * RC; W[i] = riverAt(scn, x, z, true) || riverAt(scn, x + 2, z, true) || riverAt(scn, x - 2, z, true) || riverAt(scn, x, z + 2, true) || riverAt(scn, x, z - 2, true) ? 1 : 0; }
    dryGrids.set(scn.map, W);
  }
  const cell = (x: number, z: number) => Math.max(0, Math.min(n - 1, Math.floor((z + half) / RC))) * n + Math.max(0, Math.min(n - 1, Math.floor((x + half) / RC)));
  let s = cell(ax, az), g = cell(bx, bz);
  const near = (c: number) => { let bd = 1e9, bi = c; for (let i = 0; i < n * n; i++) if (!W![i]) { const d = Math.hypot((i % n) - (c % n), Math.floor(i / n) - Math.floor(c / n)); if (d < bd) { bd = d; bi = i; } } return bi; }; // nearest open cell
  const hug = [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]].some(([dx, dz]) => riverAt(scn, ax + dx, az + dz, true)), s0 = s; if (W[s] || hug) s = near(s); // standing at the water's edge: start from the nearest clear cell
  if (W[g]) g = near(g); // goal in or at the water: the nearest clear cell
  const cost = new Float32Array(n * n).fill(1e9), from = new Int32Array(n * n).fill(-1), done = new Uint8Array(n * n), heap: [number, number][] = []; // heap of [priority, cell], priority fixed at push time; stale entries are skipped
  const h = (i: number) => Math.hypot((i % n) - (g % n), Math.floor(i / n) - Math.floor(g / n));
  const push = (e: [number, number]) => { let k = heap.push(e) - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= e[0]) break; heap[k] = heap[p]; k = p; } heap[k] = e; };
  const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { let k = 0; for (;;) { let c = 2 * k + 1; if (c >= heap.length) break; if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++; if (heap[c][0] >= last[0]) break; heap[k] = heap[c]; k = c; } heap[k] = last; } return top[1]; };
  cost[s] = 0; push([h(s), s]);
  while (heap.length) {
    const i = pop(); if (done[i]) continue; done[i] = 1; if (i === g) break;
    for (let d = 0; d < 8; d++) {
      const dx = [1, -1, 0, 0, 1, 1, -1, -1][d], dz = [0, 0, 1, -1, 1, -1, 1, -1][d], x = (i % n) + dx, z = Math.floor(i / n) + dz;
      if (x < 0 || z < 0 || x >= n || z >= n) continue;
      const j = z * n + x; if (W[j] || done[j] || (d > 3 && (W[i + dx] || W[i + dz * n]))) continue; // no cutting a corner of the water
      const c = cost[i] + (d > 3 ? 1.414 : 1); if (c < cost[j]) { cost[j] = c; from[j] = i; push([c + h(j), j]); }
    }
  }
  if (from[g] < 0 && g !== s) return null; // walled off
  const path: number[] = s0 !== s || hug ? [s] : []; { const tail: number[] = []; for (let i = g; i !== -1 && i !== s; i = from[i]) tail.push(i); path.push(...tail.reverse()); }
  const px = (i: number) => -half + ((i % n) + 0.5) * RC, pz = (i: number) => -half + (Math.floor(i / n) + 0.5) * RC;
  const dry = (x1: number, z1: number) => { const L = Math.hypot(x1 - ax, z1 - az); for (let d = 0.5; d < L + 0.5; d += d < 4 ? 0.5 : 1) { const t = Math.min(1, d / L); if (riverAt(scn, ax + (x1 - ax) * t, az + (z1 - az) * t, true)) return false; } return true; }; // 0.5-unit samples for the first 4 units (a step is about 0.3), then 1: a line skimming the bank, or a sliver at the end of a bridge disc, must not pass
  if (hug) { const i = path.find((c) => Math.hypot(px(c) - ax, pz(c) - az) >= 6) ?? path[path.length - 1]; return { x: px(i), z: pz(i) }; } // at the water's edge: first get clear of it (a waypoint under 4 away is dropped at once)
  let k = 0; while (k + 1 < path.length && dry(px(path[k + 1]), pz(path[k + 1]))) k++; // string-pull: the farthest path point in a dry straight line
  return path.length ? { x: px(path[k]), z: pz(path[k]) } : null;
}
