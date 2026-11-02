// Pure campaign roster logic shared by the browser campaign and the multiplayer server (no DOM, no JSON imports).
export type RosterUnit = { rid: number; type: string; name: string; men: number; maxMen: number; xp?: number };
export type CampaignState = { idx: number; results: Record<string, 'win' | 'draw' | 'loss'>; roster: RosterUnit[]; ended: string | null };

export function freshRoster(camp: any, tu: any): RosterUnit[] {
  const out: RosterUnit[] = [];
  let rid = 1;
  for (const [type, names] of Object.entries(camp.roster as Record<string, string[]>))
    for (const name of names) { const m = tu.types[type].men; out.push({ rid: rid++, type, name, men: m, maxMen: m, xp: 0 }); }
  return out;
}

/** Apply a finished battle: survivors keep their losses, then rest heals a fraction of the missing men. */
export function applyResult(c: CampaignState, camp: any, id: string, state: any): CampaignState {
  const next: CampaignState = JSON.parse(JSON.stringify(c));
  const r = state.result;
  for (const o of state.out as { rid: number; men: number; fate: string; xp?: number }[]) {
    const u = next.roster.find((q) => q.rid === o.rid);
    if (!u) continue;
    if (o.men <= 4.5) next.roster = next.roster.filter((q) => q.rid !== o.rid);
    else { u.men = Math.max(5, Math.round(o.men)); u.xp = Math.round(o.xp ?? u.xp ?? 0); } // rank is earned across the campaign
  }
  for (const u of next.roster) u.men = Math.min(u.maxMen, Math.round(u.men + (u.maxMen - u.men) * camp.healFraction));
  next.results[id] = r.winner === 0 ? 'win' : r.winner === 1 ? 'loss' : 'draw';
  next.idx = Math.min(camp.battles.length, c.idx + 1);
  if (next.idx >= camp.battles.length) next.ended = `waterloo_${next.results[id]}`;
  return next;
}
