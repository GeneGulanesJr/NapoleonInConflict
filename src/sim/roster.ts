// Pure campaign roster logic shared by the browser campaign and the multiplayer server (no DOM, no JSON imports).
export type RosterUnit = { rid: number; type: string; name: string; men: number; maxMen: number; xp?: number };
export type CampaignState = { idx: number; results: Record<string, 'win' | 'draw' | 'loss'>; roster: RosterUnit[]; ended: string | null; glory?: number; grouchy?: string };

export function freshRoster(camp: any, tu: any): RosterUnit[] {
  const out: RosterUnit[] = [];
  let rid = 1;
  for (const [type, names] of Object.entries(camp.roster as Record<string, string[]>))
    for (const name of names) { const m = tu.types[type].men; out.push({ rid: rid++, type, name, men: m, maxMen: m, xp: 0 }); }
  return out;
}

// Glory (earned per battle result, camp.glory) buys men between battles at the deploy price: a whole regiment's worth of men costs types[t].cost.
const perMan = (tu: any, type: string) => tu.types[type].cost / tu.types[type].men;
const price = (men: number, tu: any, type: string) => Math.ceil(men * perMan(tu, type) - 1e-6); // whole glory, without float dust tipping 10.0000001 to 11
/** glory to bring every regiment of a type back to full strength */
export const fillCost = (c: CampaignState, tu: any, type: string) => price(c.roster.filter((u) => u.type === type).reduce((a, u) => a + u.maxMen - u.men, 0), tu, type);
/** glory for a fresh regiment raised in place of one destroyed (camp.recruitCost x its deploy price) */
export const recruitCost = (camp: any, tu: any, type: string) => Math.ceil(tu.types[type].cost * camp.recruitCost);
/** Spend glory on replacements for a type, weakest regiment first, as far as the glory goes. Mutates c; false if nothing was bought. */
export function reinforce(c: CampaignState, tu: any, type: string): boolean {
  let men = Math.floor((c.glory ?? 0) / perMan(tu, type) + 1e-6), added = 0;
  for (const u of c.roster.filter((q) => q.type === type).sort((a, b) => a.men / a.maxMen - b.men / b.maxMen)) { const n = Math.min(men, u.maxMen - u.men); u.men += n; men -= n; added += n; }
  if (!added) return false;
  c.glory = Math.max(0, (c.glory ?? 0) - price(added, tu, type));
  return true;
}
/** Raise a fresh regiment (full strength, no rank) under the name of one of this type that was destroyed. Mutates c; false if none was lost or glory is short. */
export function recruit(c: CampaignState, camp: any, tu: any, type: string): boolean {
  const name = (camp.roster[type] as string[]).find((n) => !c.roster.some((u) => u.type === type && u.name === n)), cost = recruitCost(camp, tu, type);
  if (!name || (c.glory ?? 0) < cost) return false;
  c.glory = (c.glory ?? 0) - cost;
  c.roster.push({ rid: Math.max(0, ...c.roster.map((u) => u.rid)) + 1, type, name, men: tu.types[type].men, maxMen: tu.types[type].men, xp: 0 });
  return true;
}

// Marshal Grouchy (camp.grouchy): his orders are asked once after battle `after`; the regiments he takes sit out battle `at`, they are not lost.
/** the chosen orders (a camp.grouchy.options entry), or undefined */
export const grouchyOrders = (c: CampaignState, camp: any) => camp.grouchy?.options.find((o: any) => o.id === c.grouchy);
/** the campaign must ask for Grouchy's orders: his battle is over and they were never given (saves from before the choice too) */
export const grouchyDue = (c: CampaignState, camp: any) => !!camp.grouchy && !c.grouchy && !c.ended && c.idx > camp.battles.indexOf(camp.grouchy.after);
/** the regiments that take the field in battle `id` */
export const fieldRoster = (c: CampaignState, camp: any, id: string) => (id === camp.grouchy?.at ? c.roster.filter((u) => !grouchyOrders(c, camp)?.detach.includes(u.name)) : c.roster);

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
  next.glory = (c.glory ?? 0) + (camp.glory?.[next.results[id]] ?? 0);
  next.idx = Math.min(camp.battles.length, c.idx + 1);
  if (next.idx >= camp.battles.length) next.ended = `waterloo_${next.results[id]}`;
  return next;
}
