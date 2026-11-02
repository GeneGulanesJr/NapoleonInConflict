// Pure roster builder shared by the browser campaign and the multiplayer server.
export function freshRoster(camp: any, tu: any) {
  const out: { rid: number; type: string; name: string; men: number; maxMen: number; xp?: number }[] = [];
  let rid = 1;
  for (const [type, names] of Object.entries(camp.roster as Record<string, string[]>))
    for (const name of names) { const m = tu.types[type].men; out.push({ rid: rid++, type, name, men: m, maxMen: m, xp: 0 }); }
  return out;
}
