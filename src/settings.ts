// Player settings as one row of cycle buttons, shared by the title screen and the in-battle menu. Everything is remembered across visits.
import { TUNING, pref, setPref, fogOn, setFog, difficulty, setPrefNum } from './campaign.ts';
import { vol, setVolume, radioOn, toggleRadio } from './audio.ts';

const STEPS = [0, 0.25, 0.5, 0.75, 1];
const nextVol = (v: number) => STEPS[(STEPS.findIndex((s) => s >= v - 0.01) + 1) % STEPS.length];
const pct = (v: number) => (v ? `${Math.round(v * 100)}%` : 'Off');
const onOff = (b: boolean) => (b ? 'On' : 'Off');

/** Fills `el` with the settings buttons. onChange runs after any of them is clicked (the battle re-reads edge scrolling). */
export function settings(el: HTMLElement, view: { cycleQuality(): string; quality: string }, onChange = () => {}) {
  const rows: [string, () => string, () => void][] = [
    ['Music', () => pct(vol.mus), () => setVolume('mus', nextVol(vol.mus))],
    ['Effects', () => pct(vol.sfx), () => setVolume('sfx', nextVol(vol.sfx))],
    ['Radio voice', () => onOff(radioOn), () => toggleRadio()],
    ['Edge scrolling', () => onOff(pref('nic-edge', true)), () => setPref('nic-edge', !pref('nic-edge', true))],
    ['Render quality', () => view.quality, () => view.cycleQuality()],
    ['Difficulty', () => TUNING.difficulty.labels[difficulty()], () => setPrefNum('nic-diff', (difficulty() + 1) % 3)],
    ['Fog of war', () => onOff(fogOn()), () => setFog(!fogOn())],
    ['March in column', () => onOff(pref('nic-col', true)), () => setPref('nic-col', !pref('nic-col', true))],
    ['Courier orders', () => onOff(pref('nic-courier', false)), () => setPref('nic-courier', !pref('nic-courier', false))],
  ];
  el.innerHTML = rows.map(([l], i) => `<button data-set="${i}">${l}: <b></b></button>`).join('');
  const paint = () => el.querySelectorAll<HTMLElement>('[data-set]').forEach((b) => (b.querySelector('b')!.textContent = rows[Number(b.dataset.set)][1]()));
  el.querySelectorAll<HTMLElement>('[data-set]').forEach((b) => (b.onclick = () => { rows[Number(b.dataset.set)][2](); paint(); onChange(); }));
  paint();
}
