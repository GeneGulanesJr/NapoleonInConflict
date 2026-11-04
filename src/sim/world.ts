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

/** The river whose water is here (off its bridges), or null. A bridge is [x, z] or [x, z, half-width]: ground within the half-width (7 by default) of its centre is dry, so a wide bridge passes a broader front. */
export function riverAt(scn: any, x: number, z: number): any {
  for (const r of scn.map.rivers ?? []) {
    if (r.bridges.some(([bx, bz, bw]: number[]) => Math.hypot(x - bx, z - bz) < (bw ?? 7))) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) if (segDist(x, z, r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1]) < r.width / 2) return r;
  }
  return null;
}

const nearGrids = new WeakMap<object, Uint8Array>();
/** The deep (unfordable) river whose water is here, off its bridges, with an O(1) early-out: a 4-unit grid, baked once per map, marks the cells within reach of deep water. */
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
  if (X >= 0 && Z >= 0 && X < n && Z < n && !G[Z * n + X]) return null;
  for (const r of m.rivers ?? []) {
    if (r.ford || r.bridges.some(([bx, bz, bw]: number[]) => Math.hypot(x - bx, z - bz) < (bw ?? 7))) continue;
    for (let i = 0; i + 1 < r.pts.length; i++) if (segDist(x, z, r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1]) < r.width / 2) return r;
  }
  return null;
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

