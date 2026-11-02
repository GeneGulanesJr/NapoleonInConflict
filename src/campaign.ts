// Campaign state: persistent roster, battle results, save/load.
import camp from './data/campaign.json';
import tuning from './data/tuning.json';
import charleroi from './data/charleroi.json';
import quatrebras from './data/quatrebras.json';
import ligny from './data/ligny.json';
import genappe from './data/genappe.json';
import waterloo from './data/waterloo.json';
import hougoumont from './data/hougoumont.json';
import wavre from './data/wavre.json';

export const TUNING: any = tuning;
export const CAMPAIGN: any = camp;
export const SCENARIOS: Record<string, any> = { charleroi, quatrebras, ligny, genappe, waterloo, hougoumont, wavre };
/** extra battles that are not part of the campaign: quick battle only */
export const EXTRA_BATTLES = ['hougoumont', 'wavre'];

export type RosterUnit = { rid: number; type: string; name: string; men: number; maxMen: number; xp?: number };
export type CampaignState = { idx: number; results: Record<string, 'win' | 'draw' | 'loss'>; roster: RosterUnit[]; ended: string | null };
const KEY = 'nic-campaign-v2';

export function freshRoster(): RosterUnit[] {
  const out: RosterUnit[] = [];
  let rid = 1;
  for (const [type, names] of Object.entries(CAMPAIGN.roster as Record<string, string[]>))
    for (const name of names) { const m = TUNING.types[type].men; out.push({ rid: rid++, type, name, men: m, maxMen: m, xp: 0 }); }
  return out;
}
export const newCampaign = (): CampaignState => ({ idx: 0, results: {}, roster: freshRoster(), ended: null });

export function load(): CampaignState | null {
  try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
export function save(c: CampaignState) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* private mode */ } }
export function clearSave() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

export const wonMap = (c: CampaignState) => Object.fromEntries(Object.entries(c.results).map(([k, v]) => [k, v === 'win']));

/** Apply a finished battle: survivors keep their losses, then rest heals a fraction of the missing men. */
export function applyResult(c: CampaignState, id: string, state: any): CampaignState {
  const next: CampaignState = JSON.parse(JSON.stringify(c));
  const r = state.result;
  for (const o of state.out as { rid: number; men: number; fate: string; xp?: number }[]) {
    const u = next.roster.find((q) => q.rid === o.rid);
    if (!u) continue;
    if (o.men <= 4.5) next.roster = next.roster.filter((q) => q.rid !== o.rid);
    else { u.men = Math.max(5, Math.round(o.men)); u.xp = Math.round(o.xp ?? u.xp ?? 0); } // rank is earned across the campaign
  }
  for (const u of next.roster) u.men = Math.min(u.maxMen, Math.round(u.men + (u.maxMen - u.men) * CAMPAIGN.healFraction));
  next.results[id] = r.winner === 0 ? 'win' : r.winner === 1 ? 'loss' : 'draw';
  next.idx = Math.min(CAMPAIGN.battles.length, c.idx + 1);
  if (next.idx >= CAMPAIGN.battles.length) next.ended = `waterloo_${next.results[id]}`;
  return next;
}

/** Fog of war is a player setting (default off, the campaign is balanced without it); the sim only applies it when asked. */
export const fogOn = () => { try { return localStorage.getItem('nic-fog') === '1'; } catch { return false; } };
export const setFog = (on: boolean) => { try { localStorage.setItem('nic-fog', on ? '1' : '0'); } catch { /* ignore */ } };

export { makeSkirmish } from './sim/skirmish.ts';
