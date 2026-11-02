// Terrain queries shared by the simulation, the bots and the renderer.
// shortcut: Scn/Tuning are `any` (they are JSON); add schemas if the data files grow.

export function heightAt(scn: any, x: number, z: number): number {
  let h = 0.6 * Math.sin(x * 0.045) * Math.cos(z * 0.06);
  for (const k of scn.map.hills ?? []) {
    const a = (x - k.x) / k.rx, b = (z - k.z) / k.rz;
    h += k.h * Math.exp(-(a * a + b * b));
  }
  for (const l of scn.map.lanes ?? []) { const d = lineDist(l.pts, x, z); if (d < l.w) h -= l.depth * Math.min(1, (l.w - d) / (l.w * 0.4)); } // sunken lane
  return h;
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

export function inRiver(scn: any, x: number, z: number): boolean {
  for (const r of scn.map.rivers ?? []) {
    for (const [bx, bz] of r.bridges) if (Math.hypot(x - bx, z - bz) < 7) return false;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const [ax, az] = r.pts[i], [cx, cz] = r.pts[i + 1];
      if (segDist(x, z, ax, az, cx, cz) < r.width / 2) return true;
    }
  }
  return false;
}

/** cover = damage multiplier for a unit standing here; slow = movement multiplier. */
export function featureAt(scn: any, x: number, z: number) {
  let cover = 1, slow = 1, kind = 'open';
  for (const w of scn.map.woods ?? []) if (Math.hypot(x - w.x, z - w.z) < w.r) { cover = Math.min(cover, 0.65); slow *= 0.7; kind = 'wood'; }
  for (const v of scn.map.villages ?? []) if (Math.hypot(x - v.x, z - v.z) < v.r) { cover = Math.min(cover, 0.5); slow *= 0.85; kind = 'village'; }
  if (inRiver(scn, x, z)) { slow *= 0.2; kind = 'river'; }
  for (const l of scn.map.lanes ?? []) if (lineDist(l.pts, x, z) < l.w * 0.7) { cover = Math.min(cover, 0.7); kind = 'lane'; }
  for (const hd of scn.map.hedges ?? []) if (lineDist(hd.pts, x, z) < 2.2) cover = Math.min(cover, 0.85);
  return { cover, slow, kind };
}

/** Units never wade a river when a bridge is reachable: returns the bridge to head for first, or null if the straight line is dry. */
export function detour(scn: any, ax: number, az: number, bx: number, bz: number): { x: number; z: number } | null {
  const rivers = scn.map.rivers ?? [];
  if (!rivers.length) return null;
  const wades = (x0: number, z0: number, x1: number, z1: number) => {
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 3);
    for (let i = 1; i <= n; i++) if (inRiver(scn, x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n)) return true;
    return false;
  };
  if (!wades(ax, az, bx, bz)) return null;
  let best: { x: number; z: number } | null = null, bc = 1e9;
  for (const r of rivers) for (const [qx, qz] of r.bridges) {
    const c = Math.hypot(qx - ax, qz - az) + Math.hypot(bx - qx, bz - qz);
    if (c < bc && !wades(ax, az, qx, qz) && !wades(qx, qz, bx, bz)) { bc = c; best = { x: qx, z: qz }; }
  }
  return best;
}
