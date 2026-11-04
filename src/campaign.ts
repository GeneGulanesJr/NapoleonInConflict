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
import { SIM_VERSION } from './sim/sim.ts';
import { freshRoster as buildRoster, applyResult as applyBattle, reinforce as buyMen, recruit as buyRegiment, fillCost as menCost, recruitCost as regimentCost, type RosterUnit, type CampaignState } from './sim/roster.ts';
import { grouchyOrders as orders, grouchyDue as due, fieldRoster as onField } from './sim/roster.ts';

export const TUNING: any = tuning;
export const CAMPAIGN: any = camp;
export const SCENARIOS: Record<string, any> = { charleroi, quatrebras, ligny, genappe, waterloo, hougoumont, wavre };
/** extra battles that are not part of the campaign: quick battle only */
export const EXTRA_BATTLES = ['hougoumont', 'wavre'];

export type { RosterUnit, CampaignState } from './sim/roster.ts';
const KEY = 'nic-campaign-v2';

export const freshRoster = (): RosterUnit[] => buildRoster(CAMPAIGN, TUNING);
export const applyResult = (c: CampaignState, id: string, state: any): CampaignState => applyBattle(c, CAMPAIGN, id, state);
export const newCampaign = (): CampaignState => ({ idx: 0, results: {}, roster: freshRoster(), ended: null, glory: 0 });
/** glory buys men only for the regiments that fight next, not those away with Grouchy (same unit objects, so the men land in c) */
const next = (c: CampaignState): CampaignState => ({ ...c, roster: fieldRoster(c, CAMPAIGN.battles[c.idx]) });
export const reinforce = (c: CampaignState, type: string) => { const v = next(c), ok = buyMen(v, TUNING, type); c.glory = v.glory; return ok; };
export const recruit = (c: CampaignState, type: string) => buyRegiment(c, CAMPAIGN, TUNING, type);
export const fillCost = (c: CampaignState, type: string) => menCost(next(c), TUNING, type);
export const recruitCost = (type: string) => regimentCost(CAMPAIGN, TUNING, type);
export const grouchyOrders = (c: CampaignState) => orders(c, CAMPAIGN);
export const grouchyDue = (c: CampaignState) => due(c, CAMPAIGN) && !loadBattle(c); // not under a battle in progress: its timeline is already fixed
export const fieldRoster = (c: CampaignState, id: string) => onField(c, CAMPAIGN, id);

/** A campaign battle in progress, saved every few seconds so closing the tab doesn't lose it: the battle, the campaign step it belongs to, and the sim state. */
const BKEY = 'nic-battle-v1';
export type BattleSave = { id: string; idx: number; s: any; v?: number };
export function loadBattle(c: CampaignState): BattleSave | null { // a save from another sim version would play on rules it was not made under: dropped
  try { const b = JSON.parse(localStorage.getItem(BKEY) ?? 'null'); return b && b.v === SIM_VERSION && b.idx === c.idx && b.id === CAMPAIGN.battles[c.idx] ? b : null; } catch { return null; }
}
export function saveBattle(b: BattleSave) { try { localStorage.setItem(BKEY, JSON.stringify({ ...b, v: SIM_VERSION })); } catch { /* private mode or full: the battle just can't be resumed */ } }
export function clearBattle() { try { localStorage.removeItem(BKEY); } catch { /* ignore */ } }

export function load(): CampaignState | null {
  try { const s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
export function save(c: CampaignState) { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* private mode */ } }
export function clearSave() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

export const wonMap = (c: CampaignState) => Object.fromEntries(Object.entries(c.results).map(([k, v]) => [k, v === 'win']));

/** Fog of war is a player setting (default off, the campaign is balanced without it); the sim only applies it when asked. */
export const fogOn = () => pref('nic-fog', false);
export const setFog = (on: boolean) => setPref('nic-fog', on);
/** on/off player settings remembered across visits (private mode just forgets them) */
export function pref(k: string, def: boolean) { try { const v = localStorage.getItem(k); return v == null ? def : v === '1'; } catch { return def; } }
export function setPref(k: string, on: boolean) { try { localStorage.setItem(k, on ? '1' : '0'); } catch { /* ignore */ } }
/** numeric player settings (volumes, difficulty, side) */
export function prefNum(k: string, def: number) { try { const v = Number(localStorage.getItem(k) ?? NaN); return Number.isFinite(v) ? v : def; } catch { return def; } }
export function setPrefNum(k: string, v: number) { try { localStorage.setItem(k, String(v)); } catch { /* ignore */ } }
/** 0 Easy, 1 Normal, 2 Hard (tuning.difficulty) */
export const difficulty = () => Math.max(0, Math.min(2, prefNum('nic-diff', 1)));

export { makeSkirmish } from './sim/skirmish.ts';
