// Record and replay. A battle is its start state plus each player command and the step it came before;
// the sim and the bot are deterministic, so feeding those back rebuilds the battle exactly.
import { createSim, step, command, type Cmd, type Sim } from './sim.ts';
import { makeBot } from './bot.ts';

export type Replay = { scn: any; won?: Record<string, boolean>; grouchy?: string; side: number; start: string; cmds: [number, Cmd][] };
export const DT = 0.05;

/** The player's side runs from `r`'s start state against the bot. Live (play = false) it records each command; with play it feeds the recording back. */
export function runner(tu: any, r: Replay, play = false) {
  const sim: Sim = createSim(r.scn, tu, { won: r.won, grouchy: r.grouchy }); // the timeline (delayIfWon, Grouchy's orders) comes from scn + won + grouchy; everything else from the start state
  sim.s = JSON.parse(r.start); // the live run starts from the same parsed copy as the replay, so nothing (e.g. -0) can differ
  const bot = makeBot(sim, 1 - r.side);
  let n = 0, i = 0;
  return {
    sim,
    cmd(c: Cmd) { if (play) return; r.cmds.push([n, structuredClone(c)]); command(sim, r.side, c); },
    tick() {
      if (play) while (i < r.cmds.length && r.cmds[i][0] <= n) command(sim, r.side, r.cmds[i++][1]);
      step(sim, DT); bot(DT); n++;
    },
  };
}
