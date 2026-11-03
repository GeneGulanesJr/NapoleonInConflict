// Route finding: a movement-cost grid baked once per map and movement class, A* over it (8 neighbours, binary heap), then string-pulled waypoints.
// Pure and deterministic (no randomness, fixed neighbour order): runs in the sim on the client and the server.
import { featureAt, heightAt, riverAt } from './world.ts';

const CELL = 4, CAP = 6000, DIAG = CELL * Math.SQRT2;
const DX = [1, -1, 0, 0, 1, 1, -1, -1], DZ = [0, 0, 1, -1, 1, -1, 1, -1];
type Grid = { n: number; o: number; f: any[]; deep: Uint8Array; sl: Float32Array; c: Record<string, Float32Array>; min: Record<string, number>; g: Float64Array; par: Int32Array; seen: Uint32Array; done: Uint32Array; gen: number };
const grids = new WeakMap<any, Grid>();

/** The ground at every cell (features at the centre, deep water at any corner, slope factor) plus the A* scratch arrays: built once per map. */
function grid(scn: any, tu: any): Grid {
  let G = grids.get(scn.map);
  if (G) return G;
  const n = Math.ceil(scn.map.size / CELL), o = -scn.map.size / 2, N = n * n, f: any[] = [], deep = new Uint8Array(N), h = new Float64Array(N), sl = new Float32Array(N), dn = tu.terrain.downhill - 1;
  const m = n + 1, W = new Uint8Array(m * m); // deep water at the cell corners
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) { const r = riverAt(scn, o + i * CELL, o + j * CELL); W[j * m + i] = +(!!r && !r.ford); }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = o + (i + 0.5) * CELL, z = o + (j + 0.5) * CELL, k = j * n + i, q = j * m + i, fe = featureAt(scn, x, z);
    f.push(fe); h[k] = heightAt(scn, x, z);
    deep[k] = +((fe.river && !fe.river.ford) || W[q] || W[q + 1] || W[q + m] || W[q + m + 1]); // a whole cell clear of deep water, so no march grazes the river beside a bridge
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, gr = Math.hypot(h[i < n - 1 ? k + 1 : k] - h[i > 0 ? k - 1 : k], h[j < n - 1 ? k + n : k] - h[j > 0 ? k - n : k]) / (2 * CELL);
    sl[k] = (1 / (1 - Math.min(0.5, 1.5 * gr)) + 1 / (1 + Math.min(dn, 1.5 * gr))) / 2; // step()'s uphill and downhill pace on this slope, averaged
  }
  grids.set(scn.map, (G = { n, o, f, deep, sl, c: {}, min: {}, g: new Float64Array(N), par: new Int32Array(N), seen: new Uint32Array(N), done: new Uint32Array(N), gen: 0 }));
  return G;
}

/** Cost per unit of march for one movement class (1 = flat open ground); deep water off the bridges is impassable. */
function bake(G: Grid, k: string, speed: (f: any) => number) {
  const c = new Float32Array(G.n * G.n);
  let m = Infinity;
  G.f.forEach((f, i) => { c[i] = G.deep[i] ? Infinity : G.sl[i] / speed(f); m = Math.min(m, c[i]); });
  G.min[k] = m;
  return (G.c[k] = c);
}

/** Waypoints [[x, z], ...] for a march from (ax, az) to (bx, bz) by movement class k (speed(f) = its pace multiplier on ground f), or null when the straight line will do:
 *  round deep water by the bridges, round woods and villages (or through them when that is quicker), along roads when that is faster overall. */
export function route(scn: any, tu: any, k: string, speed: (f: any) => number, ax: number, az: number, bx: number, bz: number): number[][] | null {
  const G = grid(scn, tu), c = G.c[k] ?? bake(G, k, speed), n = G.n, o = G.o, mc = G.min[k];
  const at = (x: number, z: number) => Math.max(0, Math.min(n - 1, Math.floor((z - o) / CELL))) * n + Math.max(0, Math.min(n - 1, Math.floor((x - o) / CELL)));
  const line = (x0: number, z0: number, x1: number, z1: number) => { // cost of marching straight, sampled every unit of ground
    const L = Math.hypot(x1 - x0, z1 - z0), m = Math.ceil(L) || 1;
    let s = 0;
    for (let i = 0; i < m; i++) s += c[at(x0 + ((x1 - x0) * (i + 0.5)) / m, z0 + ((z1 - z0) * (i + 0.5)) / m)];
    return (s * L) / m;
  };
  const L = Math.hypot(bx - ax, bz - az), S = line(ax, az, bx, bz), s0 = at(ax, az), t = at(bx, bz);
  if (S < Infinity && (L < 25 || S <= 1.05 * L * mc)) return null; // a short march, or one already as cheap as the ground allows

  // A*: f = g + octile distance x the cheapest cell's cost (never overestimates, so the route is the cheapest)
  const g = G.g, par = G.par, seen = G.seen, done = G.done, gen = ++G.gen, tx = t % n, tz = (t / n) | 0;
  const h = (i: number) => { const dx = Math.abs((i % n) - tx), dz = Math.abs(((i / n) | 0) - tz); return (Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz)) * CELL * mc; };
  const hn: number[] = [], hf: number[] = [];
  const push = (i: number, f: number) => {
    let j = hn.length;
    hn.push(i); hf.push(f);
    while (j > 0) { const p = (j - 1) >> 1; if (hf[p] <= f) break; hn[j] = hn[p]; hf[j] = hf[p]; j = p; }
    hn[j] = i; hf[j] = f;
  };
  const pop = () => {
    const top = hn[0], i = hn.pop()!, f = hf.pop()!, m = hn.length;
    if (m) {
      let j = 0;
      for (;;) { let q = 2 * j + 1; if (q >= m) break; if (q + 1 < m && hf[q + 1] < hf[q]) q++; if (hf[q] >= f) break; hn[j] = hn[q]; hf[j] = hf[q]; j = q; }
      hn[j] = i; hf[j] = f;
    }
    return top;
  };
  g[s0] = 0; par[s0] = -1; seen[s0] = gen; push(s0, h(s0));
  let found = false;
  for (let it = 0; hn.length && it < CAP && hf[0] < 0.95 * S; it++) { // past 0.95 x the straight line's cost no route can be clearly quicker
    const cur = pop();
    if (cur === t) { found = true; break; }
    if (done[cur] === gen) continue; // a stale heap entry
    done[cur] = gen;
    const cx = cur % n, cz = (cur / n) | 0;
    for (let d = 0; d < 8; d++) {
      const x = cx + DX[d], z = cz + DZ[d], nb = z * n + x;
      if (x < 0 || z < 0 || x >= n || z >= n || (c[nb] === Infinity && nb !== t) || done[nb] === gen) continue; // the map edge and deep water bound the search (a goal on the very bank is still reached)
      if (d > 3 && (c[cz * n + x] === Infinity || c[z * n + cx] === Infinity)) continue; // no cutting a corner of deep water
      const ca = c[cur] < Infinity ? c[cur] : c[nb], ng = g[cur] + ((ca + (c[nb] < Infinity ? c[nb] : ca)) / 2) * (d > 3 ? DIAG : CELL); // half of each cell, as line() samples it (a wet start or goal cell counts as its neighbour)
      if (seen[nb] === gen && ng >= g[nb]) continue;
      seen[nb] = gen; g[nb] = ng; par[nb] = cur; push(nb, ng + h(nb));
    }
  }
  if (!found || g[t] >= 0.95 * S) return null; // no way round (or past the search cap), or not clearly quicker than straight

  // string-pull: from each corner, go straight to the farthest cell of the route the straight cut can reach for no more than the route costs
  const p: number[] = [];
  for (let i = t; i >= 0; i = par[i]) p.push(i);
  p.reverse();
  const X = (j: number) => (j === 0 ? ax : j === p.length - 1 ? bx : o + ((p[j] % n) + 0.5) * CELL), Z = (j: number) => (j === 0 ? az : j === p.length - 1 ? bz : o + (((p[j] / n) | 0) + 0.5) * CELL);
  const out: number[][] = [];
  for (let a = 0, b = 1; b < p.length - 1; a = b++) {
    while (b + 1 < p.length && line(X(a), Z(a), X(b + 1), Z(b + 1)) <= g[p[b + 1]] - g[p[a]] + 1e-6) b++;
    if (b < p.length - 1) out.push([X(b), Z(b)]);
  }
  return out;
}
