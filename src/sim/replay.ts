// Record and replay. A battle is its start state plus each player command and the step it came before;
// the sim and the bot are deterministic, so feeding those back rebuilds the battle exactly.
import { createSim, step, command, SIM_VERSION, type Cmd, type Sim } from './sim.ts';
import { makeBot } from './bot.ts';
import { makeSkirmish } from './skirmish.ts';

/** keys: [step, state] every KEY steps and at the end, to seek from; end: the last step; chron: the final chronicle (turning points); ref: the scenario to rebuild for a replay file */
export type Replay = {
  scn: any; v?: number; won?: Record<string, boolean>; grouchy?: string; side: number; start: string; cmds: [number, Cmd][];
  keys?: [number, string][]; end?: number; chron?: any[]; ref?: { id: string; seed?: number; strength: number[]; skill?: number };
};
export const DT = 0.05, KEY = 1200; // a keyframe every 60 sim-seconds

/** The player's side runs from `r`'s start state against the bot. Live (play = false) it records each command; with play it feeds the recording back. */
export function runner(tu: any, r: Replay, play = false) {
  const sim: Sim = createSim(r.scn, tu, { won: r.won, grouchy: r.grouchy }); // the timeline (delayIfWon, Grouchy's orders) comes from scn + won + grouchy; everything else from the start state
  sim.s = JSON.parse(r.start); // the live run starts from the same parsed copy as the replay, so nothing (e.g. -0) can differ
  const bot = makeBot(sim, 1 - r.side), keys = (r.keys ??= []);
  let n = 0, i = 0;
  /** carry on from state j at step k (pending events stay) */
  const at = (k: number, j: string) => {
    const ev = sim.s.events;
    sim.s = JSON.parse(j); sim.s.events = ev; n = k;
    for (i = 0; i < r.cmds.length && r.cmds[i][0] < n;) i++;
  };
  function tick() {
    if (play) while (i < r.cmds.length && r.cmds[i][0] <= n) command(sim, r.side, r.cmds[i++][1]);
    step(sim, DT); bot(DT); n++;
    if (n % KEY && !sim.s.over) return;
    // the run itself carries on from the keyframe's copy, so a seek to it plays on exactly as the battle did
    let k = keys.find((q) => q[0] === n);
    if (!k) keys.push((k = [n, JSON.stringify({ ...sim.s, events: [] })]));
    at(n, k[1]);
    if (sim.s.over && !play) { r.end = n; r.chron = sim.s.chron; }
  }
  return {
    sim, tick,
    get n() { return n; },
    cmd(c: Cmd) { if (play) return; r.cmds.push([n, structuredClone(c)]); command(sim, r.side, c); },
    /** toward step m: from the nearest keyframe at or before it (or from here, if that is nearer), fast-forwarding until the clock reads `until` (call again to go on); true once there. The skipped stretch's events are dropped. */
    seek(m: number, until = Infinity) {
      const k = keys.reduce((b, q) => (q[0] <= m && q[0] > b[0] ? q : b), [0, r.start] as [number, string]);
      if (m < n || k[0] > n) at(k[0], k[1]);
      while (n < m && !sim.s.over && performance.now() < until) tick();
      sim.s.events.length = 0;
      return n >= m || sim.s.over;
    },
  };
}

// ---------------------------------------------------------------- replay files
/** A replay file is the recording without the scenario: on load it is rebuilt from `ref`, never taken from the file. */
export const replayFile = (r: Replay) => JSON.stringify({ ...r, scn: undefined });

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nat = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
/** every number finite, every string short and free of markup (state text reaches the HUD) */
const sane = (v: any): boolean => (typeof v === 'string' ? v.length < 300 && !/[<>"]/.test(v) : typeof v === 'number' ? Number.isFinite(v) : v && typeof v === 'object' ? Object.values(v).every(sane) : true);
function state(j: unknown) {
  let s: any;
  try { s = typeof j === 'string' && JSON.parse(j); } catch { return false; }
  return !!s && typeof s === 'object' && Array.isArray(s.units) && Array.isArray(s.zones) && Array.isArray(s.side) && s.side.length === 2 && num(s.t) && sane(s);
}
/** structural only (other commands and fields may come): a step, and an order made of numbers, booleans, short strings and short number lists */
const arg = (v: unknown) => typeof v === 'boolean' || num(v) || (typeof v === 'string' && v.length <= 40) || (Array.isArray(v) && v.length <= 100 && v.every(num));
const order = (e: any) => Array.isArray(e) && e.length === 2 && nat(e[0]) && !!e[1] && typeof e[1] === 'object' && !Array.isArray(e[1]) && typeof e[1].c === 'string' && Object.values(e[1]).every(arg);

/** Reads a replay file (it may come from anyone): checks it, and rebuilds its scenario from our own data. Throws with a reason.
 *  orders: the campaign's ids for Grouchy's orders (they shape Waterloo's timeline, so a file's choice must be one of them) */
export function parseReplay(text: string, scenarios: Record<string, any>, orders: string[] = []): Replay {
  let f: any;
  try { f = JSON.parse(text); } catch { throw new Error('not a replay file'); }
  const ref = f?.ref;
  if (!ref || typeof ref !== 'object') throw new Error('not a replay file');
  if (f.v !== SIM_VERSION) throw new Error('recorded on another version of the game: its orders would not play out the same'); // the sim is deterministic per version only
  const base = ref.id === 'skirmish' && Number.isInteger(ref.seed) ? makeSkirmish(ref.seed) : typeof ref.id === 'string' && Object.hasOwn(scenarios, ref.id) ? scenarios[ref.id] : null;
  if (!base) throw new Error(`unknown battle "${String(ref.id).slice(0, 30)}"`);
  if (!Array.isArray(ref.strength) || ref.strength.length !== 2 || !ref.strength.every((x: unknown) => num(x) && x > 0 && x <= 10)) throw new Error('bad army strength');
  if (f.side !== 0 && f.side !== 1) throw new Error('bad side');
  if (f.won != null && (typeof f.won !== 'object' || !Object.values(f.won).every((v) => typeof v === 'boolean'))) throw new Error('bad campaign results');
  if (f.grouchy != null && !orders.includes(f.grouchy)) throw new Error("bad orders for Grouchy"); // used as a key into the timeline's delays: only our own ids
  if (!state(f.start)) throw new Error('bad start state');
  if (!nat(f.end) || !Array.isArray(f.cmds) || !f.cmds.every(order)) throw new Error('bad orders');
  if (!Array.isArray(f.keys) || !f.keys.every((k: any) => Array.isArray(k) && k.length === 2 && nat(k[0]) && state(k[1]))) throw new Error('bad keyframes');
  if (!Array.isArray(f.chron) || !f.chron.every((c: any) => c && num(c.t) && (c.side === 0 || c.side === 1) && typeof c.text === 'string')) throw new Error('bad turning points');
  const strength = [...ref.strength], skill = ref.skill === 0 || ref.skill === 2 ? ref.skill : 1; // the bot's difficulty (Easy / Normal / Hard) shapes its play
  return { scn: { ...base, strength, skill }, v: f.v, ref: { id: ref.id, seed: ref.seed, strength, skill }, won: f.won ?? undefined, grouchy: f.grouchy ?? undefined, side: f.side, start: f.start, cmds: f.cmds, keys: f.keys, end: f.end, chron: f.chron };
}
