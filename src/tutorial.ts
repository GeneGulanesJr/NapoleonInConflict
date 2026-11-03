// First-battle tutorial: a small HUD panel whose steps advance on what the player does, read from the battle state (so it needs no input hooks).
import { animate } from 'animejs';
import { CAMPAIGN, pref, setPref } from './campaign.ts';

type Base = { t: number; forms: Record<number, string>; zones: number; res: number };
type Test = (st: any, me: number, sel: number[], b: Base) => boolean;
const mine = (st: any, me: number) => st.units.filter((u: any) => u.side === me && !u.dead && u.draftFor == null);
/** what the step is measured against: the state when it came up */
const base = (st: any, me: number): Base => ({
  t: st.t, forms: Object.fromEntries(mine(st, me).map((u: any) => [u.id, u.form])),
  zones: st.zones.filter((z: any) => z.owner === me).length, res: Object.values(st.side[me].reserves).reduce((a: number, n: any) => a + n, 0),
});
const STEPS: [string, Test][] = [
  ['Deploy: select regiments, then right-click or drag inside the blue area to place them. Enter starts the battle.', (st) => st.phase !== 'deploy'],
  ['Select: left-click a regiment, or drag a box round several.', (_st, _me, sel) => sel.length > 0],
  ['Move: right-click the ground to march there. Right-drag forms a line facing the way you drag.', (st, me) => mine(st, me).some((u: any) => (u.tx != null && !u.march) || u.chase != null)],
  ['Formation: Z line (most muskets), X column (fastest), C square.', (st, me, _sel, b) => mine(st, me).some((u: any) => b.forms[u.id] && u.form !== b.forms[u.id])],
  ['Cavalry rides down foot in line or column: form square (C), or press B and the regiment squares up by itself when horse comes near.', (st, me) => mine(st, me).some((u: any) => u.form === 'square' || u.auto)],
  ['Artillery: select the battery and right-click an enemy regiment. Round shot ploughs through columns.', (st, me) => { const g = mine(st, me).filter((u: any) => u.type === 'artillery'); return !g.length || g.some((u: any) => u.chase != null); }],
  ['Objectives decide the day: march onto a flag and hold it until it turns blue.', (st, me, _sel, b) => st.zones.filter((z: any) => z.owner === me).length > b.zones],
  ['Help is at hand: call a regiment from the Reserves panel, or a tactical aid with F1-F3.', (st, me, _sel, b) => base(st, me).res < b.res || Object.values(st.side[me].cd).some((v: any) => v > 0)],
  ['That is the drill. ? or F10 lists every control.', (st, _me, _sel, b) => st.t > b.t + 8],
];

/** The tutorial for the first campaign battle (null elsewhere): call the result from the HUD refresh. Shown until finished or skipped; Settings > Tutorial hints brings it back. */
export function tutorial(hud: HTMLElement, scn: any, campaign: boolean) {
  if (!campaign || scn.id !== CAMPAIGN.battles[0]) return null;
  const el = document.createElement('div'), N = STEPS.length;
  el.className = 'panel'; el.id = 'tut'; el.style.display = 'none';
  el.innerHTML = '<div class="hd"></div><p></p><button></button>';
  hud.appendChild(el);
  const [hd, p, btn] = el.children as unknown as HTMLElement[];
  let i = 0, shown = -1, b: Base | null = null;
  btn.onclick = () => { setPref('nic-tut', false); i = N; };
  return (st: any, me: number, sel: number[]) => {
    if (i < N - 1 && !pref('nic-tut', true)) { el.style.display = 'none'; return; } // hints off (Settings)
    b ??= base(st, me);
    while (i < N && STEPS[i][1](st, me, sel, b)) { if (++i === N - 1) setPref('nic-tut', false); b = base(st, me); } // every step done: not shown again
    el.style.display = i < N ? '' : 'none';
    if (shown === i || i >= N) return;
    shown = i;
    hd.textContent = i < N - 1 ? `Tutorial ${i + 1}/${N - 1}` : 'Tutorial complete';
    p.textContent = STEPS[i][0]; btn.textContent = i < N - 1 ? 'Skip tutorial' : 'Close';
    animate(el, { scale: [1.08, 1], duration: 400, ease: 'outBack' });
  };
}
