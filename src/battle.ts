// In-battle controller: input, HUD, and all the Anime.js presentation (banners, popups, counters, intro, outro).
import { animate, createTimeline, stagger, steps } from 'animejs';
import { ICONS, pxCanvas, pxUrl, pxCursor } from './pixel.ts';
import { distToFoot, manPrice, posted, masked, verdict, hour, layout, clampDeploy } from './sim/sim.ts';
import { los } from './sim/world.ts';
import type { View } from './render.ts';
import { SIDE_COLOR, unitStatus } from './render.ts';
import type { Source } from './game.ts';
import { DT, replayFile } from './sim/replay.ts';
import { TUNING, pref, setPref } from './campaign.ts';
import { playEvents, cue, toggleMute, unlock, music, say, toggleRadio, muted } from './audio.ts';
import { settings } from './settings.ts';
import { tutorial } from './tutorial.ts';

export type Outcome = 'continue' | 'retry' | 'menu' | 'replay';
/** every control, grouped: the in-battle help overlay (? / F10) and the title screen's help line both read this one list */
export const CONTROLS: [string, [string, string][]][] = [
  ['Camera', [['WASD / arrows', 'pan'], ['Mouse at screen edge', 'pan'], ['Q/E, middle-drag', 'rotate'], ['Wheel', 'zoom at the cursor'], ['F', 'focus selection'], ['O', 'follow the selection'], ['Ctrl+F5-F8', 'save the view'], ['F5-F8', 'fly to a saved view'], ['Backspace', 'jump to last alert'], ['Minimap left-click', 'look there'], ['Minimap left-drag', 'pan'], ['Tab', 'big map']]],
  ['Selection', [['Left-click / drag', 'select'], ['Shift+click', 'add to selection'], ['Double-click', 'all of that kind on screen'], ['Ctrl+A', 'all regiments'], ['Shift+1-9', 'save group'], ['1-9', 'recall group (tap twice: fly there)'], ['I', 'next idle regiment'], ['Army bar', 'click select, Shift add, double-click fly'], ['Hover', 'regiment details, range, flank'], ['Esc', 'cancel / clear selection / menu']]],
  ['Orders', [['Right-click', 'move or attack'], ['Right-drag', 'form a front facing away from you: wider spreads the regiments, narrower packs them: a second rank forms behind, then column'], ['Double right-click', 'double time'], ['Alt+right-click / drag', 'move as a block (keep the shape)'], ['Ctrl+right-click', 'face that way (wheel in place)'], ['Right-click just behind', 'fall back facing the enemy'], ['Shift+right-click', 'waypoint'], ['Right-click a farm', 'garrison'], ['A (tap), left-click', 'attack-move'], ['H', 'halt'], ['G', 'stance: hold / attack / hold fire'], ['Minimap right-click', 'move there'], ['Right-click / drag (deployment)', 'place the selection at once'], ['Enter (deployment)', 'start the battle']]],
  ['Formations & specials', [['Z/X/C', 'line / column / square (horse: squadron / wedge)'], ['V', 'unit special'], ['K + click foe', 'bayonet charge']]],
  ['Aids & reserves', [['F1/F2/F3', 'tactical aid'], ['N', 'replenish (on a held objective; not in combat or with the enemy near)'], ['Reserves panel', 'call in a regiment']]],
  ['Replays', [['Replay bar', 'play/pause, 1-16×, click or drag to jump'], ['Bar markers', 'jump to a turning point']]],
  ['View', [['Space', 'pause'], ['+ / -', 'game speed'], ['J', 'message log'], ['M', 'mute'], ['R', 'radio'], ['L', 'edge scrolling on/off'], ['T', 'dusk'], ['P', 'render quality'], ['? / F10', 'this help']]],
];
const GLYPH: Record<string, string> = { line: 'I', guard: 'G', skirmisher: 'S', lancer: 'L', cuirassier: 'C', artillery: 'A', commander: '*' };
const VET = ['', 'Seasoned', 'Veteran', 'Elite'];
const START_DIST = 120; // opening zoom: a few regiments and the ground around them in view
const SIDE_NAME = ['French', 'Coalition'];
const FORMS: [string, string, string][] = [['line', 'Z', 'Line'], ['column', 'X', 'Column'], ['square', 'C', 'Square']];
const ABKEY: Record<string, string> = { barrage: 'F1', rockets: 'F2', cavalry: 'F3' }; // number keys belong to control groups
const $ = <T extends HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T;
const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');
/** names and log text come from the server in multiplayer: never put them into innerHTML raw */
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function runBattle(root: HTMLElement, view: View, src: Source, scn: any, opts: { campaign: boolean; onExit: (o: Outcome) => void }) {
  const me = src.side;
  const state0 = src.state;
  view.setScenario(scn, TUNING);
  view.setSelection([]);

  // ---------------------------------------------------------------- HUD markup
  const hud = document.createElement('div');
  hud.className = 'hud';
  const abilities: string[] = scn.abilities?.[me] ?? [];
  const reserveTypes = Object.keys(scn.reserves?.[me] ?? {});
  hud.innerHTML = `
    <div class="topbar">
      <div class="score s0"><span class="lbl">French</span><b id="sc0">0</b></div>
      <div class="center">
        <div class="ttl">${scn.title} <small>${scn.date}${src.replay ? ' · REPLAY' : ''}</small></div>
        <div class="tug" title="Who wins if the battle ended now: objectives held count ${Math.round(TUNING.endHeldWeight * 100)}%, points ${Math.round((1 - TUNING.endHeldWeight) * 100)}%. Between the marks it is a draw."><i id="tug"></i><b style="left:${50 - TUNING.drawBand * 100}%"></b><b style="left:${50 + TUNING.drawBand * 100}%"></b></div>
        <div class="clock"><span id="clk">--:--</span> · <span id="wx">Clear</span> · <span id="left"></span></div>
        <div class="pips" id="pips"></div>
      </div>
      <div class="score s1"><b id="sc1">0</b><span class="lbl">Coalition</span></div>
    </div>
    <div class="ctl">
      <button data-sp="0" title="Pause (Space)">⏸</button><button data-sp="1" class="on">1×</button><button data-sp="2">2×</button><button data-sp="4">4×</button><button data-sp="8">8×</button><button id="mute" title="Mute (M)">${muted ? '🔇' : '🔊'}</button><button id="hlp" title="Controls (? / F10)">?</button><button id="pmb" title="Menu: restart, quit, settings (Esc)">☰</button><button id="leave" title="Leave battle" style="display:none">✕</button>
    </div>
    <div id="toasts"></div>
    <div id="popups"></div>
    <div id="banner"><b></b><span></span></div>
    <div class="bl panel" id="sel"><div class="hd">No selection</div><div class="rows"></div>
      <div class="forms">${FORMS.map(([f, k, l]) => `<button data-form="${f}">${l} <kbd>${k}</kbd></button>`).join('')}<button data-stop>Halt <kbd>H</kbd></button><button data-stance>Hold <kbd>G</kbd></button><button data-bay style="display:none" title="Bayonet charge: then click an enemy regiment. Shaken defenders break before contact; steady ones fire a last volley.">Bayonet <kbd>K</kbd></button><button data-refill style="display:none" title="Fresh men march in while the regiment stands on an objective you hold and is out of the fight. Paid in reserve points as they arrive."></button><button data-special class="spbtn" style="display:none"></button></div></div>
    <div class="bc" id="abil">${abilities.map((a) => {
      const ab = TUNING.abilities[a];
      return `<button class="ab" data-ab="${a}" title="${ab.label}"><span class="ico"></span><span class="nm">${ab.label}</span><kbd>${ab.key}</kbd><span class="cd"></span><i class="sweep"></i></button>`;
    }).join('')}</div>
    <div class="br">
      <div class="panel" id="res"><div class="hd">Reserves <b id="rp">0</b> pts <small id="pool"></small></div>
        <div class="rbtns">${reserveTypes.map((t) => `<button data-res="${t}"><span>${TUNING.types[t].label}</span><em>${TUNING.types[t].cost}</em><u></u></button>`).join('')}</div></div>
      <canvas id="mini" width="96" height="96"></canvas>
    </div>
    <div class="panel" id="army"></div>
    <div class="panel" id="tip" style="display:none"></div>
    <div class="panel" id="dep" style="display:none"><div class="hd">Deployment</div><p>Right-click or drag to place the selected regiments in the blue area.</p><button id="depgo">Start battle <kbd>Enter</kbd></button></div>
    <div class="panel" id="help" style="display:none"><div class="hd">Controls <small>? / F10 / Esc to close</small></div><div class="hcols">${CONTROLS.map(([g, ks]) => `<div><b>${g}</b>${ks.map(([k, d]) => `<p><kbd>${k}</kbd> ${d}</p>`).join('')}</div>`).join('')}</div></div>
    <div class="panel" id="pm" style="display:none"><div class="hd">${src.mode === 'local' ? 'Paused' : 'Menu'}</div>
      <div class="pmb"><button data-pm="resume">Resume</button>${src.mode === 'local' ? `<button data-pm="retry">Restart ${src.replay ? 'replay' : 'battle'}</button>` : ''}<button data-pm="menu">${opts.campaign ? 'Save and quit' : 'Quit to menu'}</button></div>
      <div class="hd">Settings <small>difficulty, fog and couriers apply from the next battle</small></div><div class="sets"></div></div>
    <div class="intro" id="intro"><small></small><h1></h1><p></p></div>
    <div class="fade" id="fade"></div>
    <div class="result" id="result"></div>`;
  root.appendChild(hud);
  music(true, scn.nat?.[me]);
  hud.querySelectorAll<HTMLElement>('.ab').forEach((b) => b.querySelector('.ico')!.replaceChildren(pxCanvas(ICONS[b.dataset.ab!], 2)));

  // ---------------------------------------------------------------- state helpers
  const mine = (u: any) => u.side === me && !u.dead && u.draftFor == null; // drafts on the march aren't yours to command
  const deploying = () => src.state.phase === 'deploy' && !src.replay; // a replay applies the recorded placements on its first tick
  const tut = tutorial(hud, scn, opts.campaign);
  const drafting = (u: any) => src.state.units.some((d: any) => d.draftFor === u.id && !d.dead); // a draft is marching to it
  let selection: number[] = [];
  let targeting: string | null = null;
  let lastLogT = state0.t;
  let prevT = state0.t;
  const prevOwner: Record<string, number | null> = Object.fromEntries(state0.zones.map((z: any) => [z.id, z.owner]));
  const abReady: Record<string, boolean> = {};
  let ended = false;
  let raf = 0;
  let lastAlert: { x: number; z: number } | null = null, lastFlank = -99; // Backspace flies to the newest alert
  let edgeOn = pref('nic-edge', true), aDown = -1e9; // aDown: when A went down (a tap arms attack-move, a hold pans)
  const mouse = { x: 0, y: 0, in: false, view: false }; // last pointer position; view = over the battlefield, not a HUD panel

  // zone pips
  const pips = $(hud, '#pips');
  pips.innerHTML = state0.zones.map((z: any) => `<span class="pip" data-z="${z.id}" title="${z.name} (${z.value}/s)">${z.name}</span>`).join('');
  const paintPip = (z: any, pulse: boolean) => {
    const el = $<HTMLElement>(pips, `[data-z="${z.id}"]`);
    el.style.setProperty('--c', z.owner === 0 ? 'var(--fr)' : z.owner === 1 ? 'var(--co)' : '#888'); // CSS vars: the colour-blind switch repaints them live
    if (pulse) animate(el, { scale: [1.5, 1], duration: 700, ease: 'outElastic(1, .5)' });
  };
  state0.zones.forEach((z: any) => paintPip(z, false));

  // ---------------------------------------------------------------- Anime.js presentation
  const bannerQ: [string, string, string][] = [];
  let bannerBusy = false;
  function banner(main: string, sub: string, color: string) {
    bannerQ.push([main, sub, color]);
    if (!bannerBusy) nextBanner();
  }
  function nextBanner() {
    const q = bannerQ.shift();
    if (!q) { bannerBusy = false; return; }
    bannerBusy = true;
    const el = $<HTMLElement>(hud, '#banner');
    $(el, 'b').textContent = q[0]; $(el, 'span').textContent = q[1];
    el.style.setProperty('--c', q[2]);
    createTimeline({ onComplete: nextBanner })
      .add(el, { opacity: [1, 1], translateY: [-40, 0], duration: 360, ease: steps(6) })
      .add(el, { opacity: [1, 0], duration: 240, ease: steps(3) }, '+=2600');
  }
  let lastContact = -99;
  let duskOn = false, silOn = false, topOn = false;
  /** Calling in an aid is the show-piece: banner, slow-motion beat, camera push-in, radio call. Enemy aids get a warning. */
  function aidCue(e: any) {
    const ab = TUNING.abilities[e.name], ours = e.side === me;
    banner(ours ? ab.label.toUpperCase() : `ENEMY ${ab.label.toUpperCase()}`, ours ? 'Fire for effect' : 'Take cover', SIDE_COLOR[e.side]);
    say(ours ? ({ barrage: 'Guns, fire for effect!', rockets: 'Rockets away!', cavalry: 'Cavalry, charge!' } as any)[e.name] : 'Incoming fire! Take cover!', 2);
    if (!ours) { cue('alert'); return; }
    cue('capture');
    view.flyTo(e.x, e.z, Math.max(40, view.cam.dist * 0.8), 900);
    if (src.mode === 'local' && !src.paused) { const prev = src.speed; src.speed = 0.3; setTimeout(() => { if (!src.paused) src.speed = prev; }, 1200); }
  }
  /** a toast with a place is an alert: click it (or press Backspace) to fly there */
  function toast(msg: string, at?: { x: number; z: number }) {
    note(msg, at);
    const el = document.createElement('div');
    el.className = at ? 'toast go' : 'toast'; el.textContent = msg;
    if (at) { const p = { x: at.x, z: at.z }; lastAlert = p; el.insertAdjacentHTML('beforeend', ' <small>click to view</small>'); el.onclick = () => view.flyTo(p.x, p.z, undefined, 1000); }
    $(hud, '#toasts').appendChild(el);
    createTimeline({ onComplete: () => el.remove() }) // one timeline: a second animate() on opacity would replace the fade-in and leave the toast invisible
      .add(el, { opacity: [0, 1], translateX: [-40, 0], duration: 400, ease: 'outQuad' })
      .add(el, { opacity: 0, duration: 600, ease: 'inQuad' }, '+=6600');
  }
  function popup(e: any) {
    const el = document.createElement('div');
    el.className = `popup side${e.side}`;
    const counts: Record<string, number> = {};
    (e.types as string[]).forEach((t) => (counts[t] = (counts[t] ?? 0) + 1));
    el.innerHTML = `<b>${e.side === me ? 'Reinforcements' : 'Enemy reinforcements'}</b><span>${Object.entries(counts).map(([t, n]) => `${n}× ${TUNING.types[t].label}`).join(', ')}</span>${e.x != null ? '<small>click to view</small>' : ''}`;
    if (e.x != null) { lastAlert = { x: e.x, z: e.z }; el.onclick = () => view.flyTo(e.x, e.z, undefined, 1000); }
    note(`${el.querySelector('b')!.textContent}: ${el.querySelector('span')!.textContent}`, e.x != null ? e : undefined);
    $(hud, '#popups').appendChild(el);
    createTimeline({ onComplete: () => el.remove() })
      .add(el, { opacity: [0, 1], scale: [0.7, 1], translateX: [60, 0], duration: 550, ease: 'outBack(1.4)' })
      .add(el, { opacity: 0, translateX: 40, duration: 500, ease: 'inQuad' }, '+=6450');
    cue('arrive');
  }

  // animated score counters
  const disp = { s0: 0, s1: 0, tug: 50, rp: 0 };
  const lastTarget = { s0: -1, s1: -1, tug: -1, rp: -1 };
  function tweenNumbers(st: any, rp: number) {
    const sc = [st.side[0].score, st.side[1].score], tug = verdict(st, TUNING) * 100; // the bar is the verdict if the battle ended now, not just the points
    const to = { s0: Math.round(sc[0]), s1: Math.round(sc[1]), tug: Math.round(tug), rp: Math.round(rp) };
    if (to.s0 === lastTarget.s0 && to.s1 === lastTarget.s1 && to.tug === lastTarget.tug && to.rp === lastTarget.rp) return;
    Object.assign(lastTarget, to);
    animate(disp, {
      s0: to.s0, s1: to.s1, tug: to.tug, rp: to.rp, duration: 700, ease: 'outQuad',
      onUpdate: () => {
        $(hud, '#sc0').textContent = String(Math.round(disp.s0)); $(hud, '#sc1').textContent = String(Math.round(disp.s1));
        $<HTMLElement>(hud, '#tug').style.width = `${disp.tug}%`; $(hud, '#rp').textContent = String(Math.round(disp.rp));
      },
    });
  }

  // ---------------------------------------------------------------- input
  const dom = view.dom;
  const keys = new Set<string>();
  let drag: { x: number; y: number; box: HTMLElement } | null = null;
  let rot: { x: number } | null = null;
  const box = document.createElement('div');
  box.className = 'selbox'; box.style.display = 'none'; document.body.appendChild(box); // client-pixel overlay, outside the scaled HUD

  const setSel = (ids: number[]) => { selection = ids; view.setSelection(ids); renderSel(true); };
  const myUnits = () => src.state.units.filter(mine);
  const selUnits = () => src.state.units.filter((u: any) => selection.includes(u.id));
  /** an order that cannot be carried out: say so (the sim ignores it silently) */
  const deny = (m: string) => { toast(m); cue('alert'); };
  const isInfantry = (u: any) => u.type === 'line' || u.type === 'guard';
  const isCav = (u: any) => TUNING.types[u.type].cav && u.type !== 'commander';
  const CAV_FORM: Record<string, string> = { line: 'squadron', column: 'wedge' }; // the horse's formation on the same key
  const formName = (u: any) => (isCav(u) ? (u.form === 'wedge' ? 'wedge' : 'squadron') : u.form);
  /** the men a draft could bring u (the sim's rule: refillOffCost x the price, from the reserve points and the pool) */
  const draftMen = (u: any) => { const sd = src.state.side[me]; return Math.min(u.maxMen - u.men, Math.floor(sd.rp / (manPrice(TUNING, u) * TUNING.refillOffCost)), Math.floor(sd.pool)); };
  /** the sim's rule for taking replacements: not in melee, no enemy (a general apart) within tuning.refillClear */
  const calmHere = (u: any) => u.eng == null && !src.state.units.some((e: any) => e.side !== me && !e.dead && !e.routed && e.type !== 'commander' && Math.hypot(e.x - u.x, e.z - u.z) < TUNING.refillClear);
  const heldGround = (u: any) => src.state.zones.some((z: any) => z.owner === me && Math.hypot(u.x - z.x, u.z - z.z) < z.r);

  function renderSel(force = false) {
    const st = src.state;
    selection = selection.filter((id) => st.units.some((u: any) => u.id === id && !u.dead));
    view.setSelection(selection);
    const rows = $(hud, '#sel .rows'), hd = $(hud, '#sel .hd');
    hd.textContent = selection.length ? `${selection.length} selected` : 'Drag to select';
    const stB = $<HTMLElement>(hud, '[data-stance]');
    const sel0 = selection.map((id) => st.units.find((q: any) => q.id === id)).filter(Boolean);
    stB.style.display = sel0.length ? '' : 'none';
    const horse = sel0.length > 0 && sel0.every(isCav), mixed = sel0.some(isCav) && sel0.some((u: any) => !isCav(u));
    hud.querySelectorAll<HTMLElement>('[data-form]').forEach((b) => { // Z/X/C: line / column / square for foot, squadron / wedge for horse
      const f = b.dataset.form!; if (horse && !CAV_FORM[f]) { b.style.display = 'none'; return; } /* horse have no square */ const k = FORMS.find((q) => q[0] === f)![1], l = horse ? CAV_FORM[f] ?? '' : mixed && CAV_FORM[f] ? `${FORMS.find((q) => q[0] === f)![2]}/${CAV_FORM[f]}` : FORMS.find((q) => q[0] === f)![2], h = `${l[0].toUpperCase()}${l.slice(1)} <kbd>${k}</kbd>`;
      if (b.dataset.h !== h) { b.dataset.h = h; b.innerHTML = h; b.title = horse && f === 'column' ? 'Wedge: hits and shocks harder once formed up, but wheels slowly and takes more fire' : ''; }
      b.style.display = '';
    });
    $<HTMLElement>(hud, '[data-bay]').style.display = sel0.some((u: any) => (u.type === 'line' || u.type === 'guard') && !u.routed && u.form !== 'square') ? '' : 'none'; // only formed infantry can charge
    if (sel0.length) { stB.innerHTML = `${({ hold: 'Hold', aggressive: 'Attack', skirmish: 'Skirmish', holdfire: 'Hold fire' } as any)[sel0[0].stance] ?? 'Hold'} <kbd>G</kbd>`; }
    const rfB = $<HTMLElement>(hud, '[data-refill]'), hurt = sel0.filter((u: any) => u.type !== 'commander' && u.men < u.maxMen);
    if (hurt.length) { // a whole regiment costs its reserve price on an objective we hold, refillOffCost times that anywhere else
      const onOurs = (u: any) => st.zones.some((z: any) => z.owner === me && Math.hypot(u.x - z.x, u.z - z.z) < z.r);
      const cost = Math.ceil(hurt.reduce((a: number, u: any) => a + (u.maxMen - u.men) * manPrice(TUNING, u) * (onOurs(u) ? 1 : TUNING.refillOffCost), 0)); // at today's price; it rises as the regiment fills
      rfB.style.display = ''; rfB.classList.toggle('on', hurt.every((u: any) => u.refill)); rfB.classList.toggle('off', !hurt.some((u: any) => calmHere(u) && (onOurs(u) || (!drafting(u) && draftMen(u) >= u.maxMen * 0.05))));
      rfB.innerHTML = `Replenish <kbd>N</kbd> ${cost} pts${hurt.every(onOurs) ? '' : ' · draft marches in'}`;
      rfB.title = `On an objective you hold, fresh men trickle in (deploy price). Elsewhere a draft sets out from your map edge at ${TUNING.refillOffCost}× the price and joins on arrival; it can be caught on the way. Not in combat, nor with the enemy within ${TUNING.refillClear} units.`;
    } else rfB.style.display = 'none';
    view.setRefillHint(hurt.length > 0); // pulse the objectives we hold: replenishing is cheapest there
    const spBtn = $<HTMLElement>(hud, '[data-special]');
    const su = selection.map((id) => st.units.find((q: any) => q.id === id)).find((u: any) => u && TUNING.specials[u.type]);
    if (su) { const sp = TUNING.specials[su.type], cd = Math.ceil(su.spReady - st.t); spBtn.style.display = ''; spBtn.classList.toggle('off', cd > 0); spBtn.innerHTML = `${sp.label} <kbd>V</kbd>${cd > 0 ? ` ${cd}s` : ''}`; } else spBtn.style.display = 'none';
    const sig = selection.join(',') + '|' + (force ? Math.random() : Math.floor(st.t * 2));
    if ((rows as any)._sig === sig) return;
    (rows as any)._sig = sig;
    rows.innerHTML = selection.slice(0, 6).map((id) => {
      const u = st.units.find((q: any) => q.id === id);
      return `<div class="srow${u.routed ? ' routed' : ''}"><span>${u.refill || drafting(u) ? '+ ' : ''}${esc(u.name)}</span><i class="b m"><s style="width:${(u.men / u.maxMen) * 100}%"></s></i><i class="b o"><s style="width:${Math.max(0, (u.morale / u.maxMorale) * 100)}%"></s></i><em>${Math.round(u.men)}</em></div>`;
    }).join('') + (selection.length > 6 ? `<div class="srow more">+${selection.length - 6} more</div>` : '');
    if (sel0.length === 1) rows.insertAdjacentHTML('beforeend', unitCard(sel0[0]));
  }

  // army bar: one card per regiment, DOM touched only when a card's values change (like the plates)
  const army = $<HTMLElement>(hud, '#army'), selPanel = $<HTMLElement>(hud, '#sel'), topbar = $<HTMLElement>(hud, '.topbar'), toasts = $<HTMLElement>(hud, '#toasts');
  const cards = new Map<number, { el: HTMLElement; m: HTMLElement; o: HTMLElement; em: HTMLElement; sig: string }>();
  /** courier orders: seconds until the next order still on the road reaches u, or null */
  const due = (u: any) => { const ts = (src.state.orders ?? []).filter((o: any) => o.c.ids[0] === u.id).map((o: any) => o.t); return ts.length ? Math.min(...ts) - src.state.t : null; };
  const isIdle = (u: any) => !u.routed && u.type !== 'commander' && (u.fired ?? 99) > 10 && u.tx == null && u.chase == null && !u.queue?.length && u.garrison == null && u.eng == null && due(u) == null;
  function drawArmy(st: any) {
    const us = st.units.filter(mine), live = new Set(us.map((u: any) => u.id));
    for (const [id, c] of cards) if (!live.has(id)) { c.el.remove(); cards.delete(id); }
    for (const u of us) {
      let c = cards.get(u.id);
      if (!c) {
        const el = document.createElement('div');
        el.className = 'ac'; el.dataset.id = String(u.id); el.title = `${u.name} (${TUNING.types[u.type].label})\n1-9 control group · R routed · + replenishing · G garrisoned · > orders on the way · ? idle`;
        el.innerHTML = `<b>${GLYPH[u.type] ?? '?'}</b><i class="b m"><s></s></i><i class="b o"><s></s></i><em></em>`;
        army.appendChild(el);
        c = { el, m: $(el, '.m s'), o: $(el, '.o s'), em: $(el, 'em'), sig: '' };
        cards.set(u.id, c);
      }
      const mp = Math.round((u.men / u.maxMen) * 100), op = Math.max(0, Math.round((u.morale / u.maxMorale) * 100));
      const grp = Object.keys(groups).find((n) => groups[Number(n)].includes(u.id)) ?? ''; // its control group, first
      const mk = grp + (u.routed ? 'R' : `${u.refill || drafting(u) ? '+' : ''}${u.garrison != null ? 'G' : ''}${due(u) != null ? '>' : ''}${isIdle(u) ? '?' : ''}`); // '?' = awaiting orders (a pixel-font z reads as 2)
      const cls = `ac${selection.includes(u.id) ? ' sel' : ''}${u.routed ? ' routed' : op < 30 ? ' waver' : ''}`;
      const sig = `${mp}|${op}|${mk}|${cls}`;
      if (sig === c.sig) continue;
      c.sig = sig; c.m.style.width = `${mp}%`; c.o.style.width = `${op}%`; c.em.textContent = mk; c.el.className = cls;
    }
    army.style.top = `${topbar.offsetHeight + 4}px`; toasts.style.top = army.style.top; army.style.maxHeight = `${hud.offsetHeight - topbar.offsetHeight - selPanel.offsetHeight - 14}px`; // fits its cards, capped between the top bar and the selection panel, whatever their heights
  }
  const cardId = (e: MouseEvent) => Number((e.target as HTMLElement).closest<HTMLElement>('.ac')?.dataset.id);
  army.onclick = (e) => { const id = cardId(e); if (id) setSel(e.shiftKey ? [...new Set([...selection, id])] : [id]); };
  army.ondblclick = (e) => { const u = src.state.units.find((q: any) => q.id === cardId(e)); if (u) view.flyTo(u.x, u.z, undefined, 600); };

  // hover tooltip: any visible regiment; against an enemy, whether your selection reaches it and whether it shows you a flank
  const tip = $<HTMLElement>(hud, '#tip');
  function hoverTip(st: any) {
    const vis = (u: any) => !u.dead && (u.side === me || !st.fog || st.seen?.[me]?.includes(u.id));
    const g = mouse.view && mouse.in && !drag && !rdrag ? view.ground(mouse.x, mouse.y) : null;
    setCursor(g);
    const u = g && (unitAt(g, vis) ?? view.pickUnit(st, mouse.x, mouse.y, vis, 24));
    view.setHover(u ? u.id : null); // the hovered regiment shows its full plate
    if (!u) { tip.style.display = 'none'; return; }
    const T = TUNING.types[u.type], inf = u.type === 'line' || u.type === 'guard';
    const ls = [`<b style="color:var(${u.side === me ? '--mine' : '--foe'})">${esc(u.name)}</b>`, `${T.label}${inf || isCav(u) ? ` · ${formName(u)}` : ''}`, `Men ${Math.round(u.men)}/${u.maxMen} · Morale ${Math.max(0, Math.round((u.morale / u.maxMorale) * 100))}%`];
    if (u.vet) ls.push(`${'*'.repeat(u.vet)} ${VET[u.vet] ?? ''}`);
    if ((u.fat ?? 0) >= 0.05 || (u.mcap ?? u.maxMorale) < u.maxMorale) ls.push(`Fatigue ${Math.round((u.fat ?? 0) * 100)}%${u.mcap < u.maxMorale ? ` · morale can only reach ${Math.round((u.mcap / u.maxMorale) * 100)}%` : ''}`); // tired and badly hurt units are shakier
    if (u.type === 'artillery') ls.push(u.limT > 0 ? (u.limbered ? 'Unlimbering…' : 'Limbering up…') : u.limbered ? 'Limbered (cannot fire)' : 'Unlimbered (cannot move)');
    if (u.stun > 0) ls.push(`<i class="no">Stunned by the charge (${Math.ceil(u.stun)}s): cannot fire, move or change formation</i>`);
    else if (u.shaken > 0) ls.push(`<i class="no">Shaken by fire (${Math.ceil(u.shaken)}s): slower to load, weaker fire, cannot change formation</i>`);
    if (u.form === 'square' && u.busy > 0 && !(u.stun > 0)) ls.push(`<i class="no">Forming square: open to a charge for ${Math.ceil(u.busy)}s</i>`);
    if (u.bay != null) ls.push('Charging with the bayonet!');
    else if (posted(u, TUNING)) ls.push('Posted: steadier under fire'); // stood still long enough for the defensive bonus
    if (u.stance === 'holdfire') ls.push(`Holding fire${u.fired >= TUNING.holdFire.loaded ? ': a heavy first volley when they close' : ''}`);
    if (u.garrison != null) ls.push(`Garrison: ${esc(scn.map.villages?.[u.garrison]?.name ?? 'farm')}`);
    const od = u.side === me ? due(u) : null;
    if (od != null) ls.push(`Orders arrive in ${Math.ceil(od)}s`);
    if (u.routed) ls.push('<i class="no">Routed</i>');
    const sel = st.units.filter((q: any) => selection.includes(q.id) && !q.routed);
    if (u.side !== me && sel.length) {
      const guns = sel.filter((q: any) => TUNING.types[q.type].range > 0), rng = guns.filter((q: any) => distToFoot(u, TUNING, q.x, q.z) <= TUNING.types[q.type].range); // the sim's edge-to-edge range, from each shooter's front rank
      const n = rng.filter((q: any) => los(scn, q.x, q.z, TUNING.types[q.type].cav ? 3 : 2, u.x, u.z, 2) && !masked(q, u, st.units, TUNING)).length; // ...and, like the sim, no firing over a crest or through our own ranks
      if (guns.length) ls.push(n === guns.length ? '<i class="ok">In range</i>' : n ? `<i class="ok">In range: ${n}/${guns.length}</i>` : rng.length ? '<i class="no">In range, line of fire blocked</i>' : '<i class="no">Out of range</i>');
      if (u.form !== 'square' && u.garrison == null && !u.routed) { // the sim's aspect(): front if c > 0.5, rear if c < -0.5, else flank
        const c = centre(sel), dx = c.x - u.x, dz = c.z - u.z, k = (dx * Math.sin(u.facing) + dz * Math.cos(u.facing)) / (Math.hypot(dx, dz) || 1);
        if (k <= 0.5) ls.push(`<i class="ok">${k < -0.5 ? 'Rear' : 'Flank'} exposed</i>`);
      }
    }
    const html = ls.join('<br>');
    if ((tip as any)._h !== html) { tip.innerHTML = html; (tip as any)._h = html; }
    tip.style.display = '';
    placeTip();
  }
  function placeTip() {
    if (tip.style.display === 'none') return;
    const S = hud.getBoundingClientRect().width / hud.offsetWidth || 1, x = mouse.x / S + 10, y = mouse.y / S + 10; // client px -> HUD px
    tip.style.left = `${Math.min(x, hud.offsetWidth - tip.offsetWidth - 4)}px`; tip.style.top = `${y + tip.offsetHeight > hud.offsetHeight - 4 ? y - tip.offsetHeight - 16 : y}px`;
  }

  function groundOf(e: MouseEvent) { return view.ground(e.clientX, e.clientY); }
  /** the unit whose formation footprint is at (or just under) a ground point; the cursor lands behind a figure's feet in the tilted view, hence the margin */
  function unitAt(g: { x: number; z: number }, filter: (u: any) => boolean, margin = 5) {
    let best: any = null, bd = margin;
    for (const u of src.state.units) { if (!filter(u)) continue; const d = distToFoot(u, TUNING, g.x, g.z); if (d < bd) { bd = d; best = u; } }
    return best;
  }
  const abCfg = (n: string) => TUNING.abilities[n];

  function startTargeting(name: string) {
    const sd = src.state.side[me];
    if (src.state.over || (sd.cd[name] ?? 0) > 0) return;
    targeting = name;
    dom.style.cursor = 'crosshair';
    document.querySelectorAll('.ab').forEach((b) => b.classList.toggle('arm', (b as HTMLElement).dataset.ab === name));
  }
  function cancelTargeting() {
    targeting = null; dom.style.cursor = ''; view.setReticle(null);
    hud.querySelectorAll('.ab').forEach((b) => b.classList.remove('arm'));
  }

  const onCtx = (e: Event) => e.preventDefault();
  dom.addEventListener('contextmenu', onCtx);
  const onDown = (e: PointerEvent) => {
    unlock();
    if (intro) { skipIntro(); return; }
    if (e.button === 1) { rot = { x: e.clientX }; e.preventDefault(); return; }
    if (e.button === 0) {
      if (targeting) {
        const g = groundOf(e);
        if (targeting === 'bayonet') { // charge the enemy regiment under the cursor
          const st = src.state, foeOk = (u: any) => u.side !== me && !u.dead && !u.routed && (!st.fog || st.seen?.[me]?.includes(u.id));
          const foe = (g && unitAt(g, foeOk)) ?? view.pickUnit(st, e.clientX, e.clientY, foeOk, 34);
          if (foe) src.cmd({ c: 'bayonet', ids: selection, target: foe.id });
        } else if (g && targeting === 'amove') src.cmd({ c: 'move', ids: selection, x: g.x, z: g.z, q: e.shiftKey, am: true, col: col() });
        else if (g) {
          src.cmd({ c: 'ability', name: targeting, x: g.x, z: g.z });
          const btn = $<HTMLElement>(hud, `[data-ab="${targeting}"]`);
          animate(btn, { scale: [0.88, 1], duration: 350, ease: 'outBack' });
        }
        cancelTargeting();
        return;
      }
      drag = { x: e.clientX, y: e.clientY, box };
    } else if (e.button === 2) {
      if (targeting) { cancelTargeting(); return; }
      if (selection.length) rdrag = { x: e.clientX, y: e.clientY, g: groundOf(e) }; // a click or a drag: decided on release
    }
  };
  const col = () => pref('nic-col', true); // the 'March in column' setting
  /** broken men take no orders (the sim drops them): when the whole selection is routed, say so */
  function canOrder() { const us = selUnits(); if (!us.length || !us.every((u: any) => u.routed)) return true; deny(us.length === 1 ? `${us[0].name} is broken and takes no orders` : 'Broken regiments take no orders'); return false; }
  let lastR = { x: 0, y: 0, t: -1e9 };
  /** right-click: attack a foe, man a farm, or move (shift adds a waypoint, alt keeps the group's shape, the same spot twice quickly is double time) */
  function rightClick(e: PointerEvent) {
    const st = src.state;
    const seenFoe = (u: any) => u.side !== me && !u.dead && (!st.fog || st.seen?.[me]?.includes(u.id));
    const g0 = groundOf(e);
    const foe = (g0 && unitAt(g0, seenFoe)) ?? view.pickUnit(st, e.clientX, e.clientY, seenFoe, 34); // any soldier of the formation counts, not just its centre
    if (foe) { src.cmd({ c: 'attack', ids: selection, target: foe.id }); return; }
    if (!g0) return;
    const vi = (scn.map.villages ?? []).findIndex((v: any) => v.garrison && Math.hypot(v.x - g0.x, v.z - g0.z) < v.r + 2);
    if (vi >= 0 && !e.shiftKey) { // right-click a farm to man it
      const room = TUNING.garrison.capacity - st.units.filter((q: any) => q.side === me && (q.garrison === vi || q.gTarget === vi) && !selection.includes(q.id)).length;
      if (!selUnits().some((u: any) => (isInfantry(u) || u.type === 'skirmisher') && !u.routed)) deny('Only infantry and skirmishers can man a farm');
      else if (room <= 0) deny(`${scn.map.villages[vi].name ?? 'The farm'} is already full`);
      else src.cmd({ c: 'garrison', ids: selection, vid: vi });
    }
    else {
      const now = performance.now(), run = now - lastR.t < 350 && Math.hypot(e.clientX - lastR.x, e.clientY - lastR.y) < 12;
      lastR = { x: e.clientX, y: e.clientY, t: run ? -1e9 : now };
      src.cmd({ c: 'move', ids: selection, x: g0.x, z: g0.z, q: e.shiftKey, keep: e.altKey, col: col(), run });
    }
  }
  /** right-drag: the dragged line is where the group stands, facing away from where it is now */
  let rdrag: { x: number; y: number; g: { x: number; z: number } | null } | null = null;
  function dragOrder(e: PointerEvent) {
    const a = rdrag?.g, b = groundOf(e);
    if (!a || !b || Math.hypot(b.x - a.x, b.z - a.z) < 2) return null;
    const us = src.state.units.filter((u: any) => selection.includes(u.id));
    const vx = b.x - a.x, vz = b.z - a.z, mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const cx = us.reduce((s: number, u: any) => s + u.x, 0) / (us.length || 1), cz = us.reduce((s: number, u: any) => s + u.z, 0) / (us.length || 1);
    let px = vz, pz = -vx; // one of the two normals of the line...
    const fwd = (mx - cx) * px + (mz - cz) * pz;
    const cy = view.cam.yaw + Math.PI / 4; // the camera sits at (sin cy, cos cy) from its target, so "into the screen" is minus that
    if (Math.abs(fwd) > 1 ? fwd < 0 : Math.sin(cy) * px + Math.cos(cy) * pz > 0) { px = -px; pz = -pz; } // ...the one pointing on from the group (or into the screen when it stands on the line)
    return { ax: a.x, az: a.z, bx: b.x, bz: b.z, mx, mz, f: Math.atan2(px, pz), w: Math.hypot(vx, vz) };
  }
  dom.addEventListener('pointerdown', onDown);
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  function onMove(e: PointerEvent) {
    Object.assign(mouse, { x: e.clientX, y: e.clientY, in: true, view: e.target === dom });
    placeTip();
    if (rot && !view.guide) { view.cam.yaw -= (e.clientX - rot.x) * 0.006; rot.x = e.clientX; }
    if (rdrag && Math.hypot(e.clientX - rdrag.x, e.clientY - rdrag.y) > 10) { // the dragged line, and ghost footprints where each regiment will stand and face
      const o = dragOrder(e), us = src.state.units.filter((u: any) => selection.includes(u.id) && !u.routed);
      view.setDragLine(o); const gs = o && !e.ctrlKey && us.length ? layout(us, { x: o.mx, z: o.mz, f: o.f, w: o.w, keep: e.altKey }, TUNING, scn.map.size / 2 - 2) : null;
      view.setGhosts(gs && deploying() ? gs.map((g) => ({ ...g, ...clampDeploy(src.state.deploy[me], g.x, g.z) })) : gs); // deploying: show the spot the regiment will really take, inside the zone
    }
    if (drag && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) {
      const b = drag.box.style;
      b.display = 'block'; b.left = `${Math.min(drag.x, e.clientX)}px`; b.top = `${Math.min(drag.y, e.clientY)}px`;
      b.width = `${Math.abs(e.clientX - drag.x)}px`; b.height = `${Math.abs(e.clientY - drag.y)}px`;
    }
    if (targeting) {
      const g = view.ground(e.clientX, e.clientY);
      const r = targeting === 'amove' ? 4 : targeting === 'bayonet' ? 6 : abCfg(targeting)?.r ?? 8;
      if (g) view.setReticle(g.x, g.z, r, targeting === 'cavalry' ? 0x66ccff : targeting === 'amove' ? 0xffe34a : targeting === 'bayonet' ? 0xff3b2f : 0xff7755);
    }
  }
  let lastPick = { id: -1, t: 0 };
  function onUp(e: PointerEvent) {
    if (e.button === 1) rot = null;
    if (e.button === 2 && rdrag && deploying()) { // deployment: a click or a drag stands the selection there at once
      const o = Math.hypot(e.clientX - rdrag.x, e.clientY - rdrag.y) > 10 ? dragOrder(e) : null, g = o ? { x: o.mx, z: o.mz } : groundOf(e);
      if (g) src.cmd({ c: 'place', ids: selection, x: g.x, z: g.z, f: o?.f, w: o?.w });
      rdrag = null; view.setDragLine(null); view.setGhosts(null);
      return;
    }
    if (e.button === 2 && rdrag) {
      if (!canOrder()) { rdrag = null; view.setDragLine(null); view.setGhosts(null); return; }
      const o = Math.hypot(e.clientX - rdrag.x, e.clientY - rdrag.y) > 10 ? dragOrder(e) : null, g = e.ctrlKey ? groundOf(e) : null;
      if (g) src.cmd({ c: 'face', ids: selection, x: g.x, z: g.z }); // ctrl: wheel in place toward the point
      else if (o) src.cmd({ c: 'move', ids: selection, x: o.mx, z: o.mz, f: o.f, w: o.w, q: e.shiftKey, keep: e.altKey, col: col() });
      else if (!e.ctrlKey) rightClick(e);
      rdrag = null; view.setDragLine(null); view.setGhosts(null);
      return;
    }
    if (e.button !== 0 || !drag) return;
    const d = drag; drag = null; d.box.style.display = 'none';
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) {
      const ids = view.unitsIn(src.state, d.x, d.y, e.clientX, e.clientY, (u) => mine(u) && !u.routed).map((u: any) => u.id);
      setSel(e.shiftKey ? [...new Set([...selection, ...ids])] : ids);
    } else {
      const g1 = groundOf(e);
      const u = (g1 && unitAt(g1, (q) => mine(q))) ?? view.pickUnit(src.state, e.clientX, e.clientY, (q) => mine(q), 34);
      const now = performance.now();
      if (u && lastPick.id === u.id && now - lastPick.t < 350) setSel(view.unitsIn(src.state, 0, 0, innerWidth, innerHeight, (q) => mine(q) && !q.routed && q.type === u.type).map((q: any) => q.id)); // double-click: every regiment of that kind on screen
      else if (u) setSel(e.shiftKey ? [...new Set([...selection, u.id])] : [u.id]);
      else if (!e.shiftKey) setSel([]);
      lastPick = { id: u?.id ?? -1, t: now };
    }
  }
  const wheel = (e: WheelEvent) => { e.preventDefault(); view.zoomBy(e.deltaY > 0 ? 1.15 : 0.87, follow ? null : view.ground(e.clientX, e.clientY)); }; // zoom about the cursor (the selection when following)
  dom.addEventListener('wheel', wheel, { passive: false });

  const keydown = (e: KeyboardEvent) => {
    unlock();
    if (viewKey(e)) return;
    if (intro) { skipIntro(); return; }
    if (e.key === 'Alt') { e.preventDefault(); view.setShowAll(true); return; } // hold Alt: every regiment's full plate (preventDefault keeps the browser menu from grabbing focus)
    if (e.code === 'KeyA' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); setSel(myUnits().filter((u: any) => !u.routed).map((u: any) => u.id)); return; } // not the browser's select-all
    if (e.key === '?' || e.code === 'F10') { e.preventDefault(); toggleHelp(); return; }
    keys.add(e.code);
    if (e.code === 'KeyA' && !e.repeat) aDown = performance.now();
    const grp = /^Digit([1-9])$/.exec(e.code);
    if (/^F[1-3]$/.test(e.code)) e.preventDefault(); // F1 help and F3 find would steal the ability keys
    if (grp) group(Number(grp[1]), e.shiftKey);
    else if (e.code === 'KeyI') nextIdle();
    else if (e.key === 'Enter' && deploying()) { e.preventDefault(); startBattle(); }
    else if (e.code === 'Space') { e.preventDefault(); setSpeed(src.paused ? 1 : 0); }
    else if (e.code === 'KeyM') $<HTMLElement>(hud, '#mute').textContent = toggleMute() ? '🔇' : '🔊';
    else if (e.code === 'Escape') { if (help.style.display !== 'none') toggleHelp(); else if (pm.style.display !== 'none') toggleMenu(); else if (targeting) cancelTargeting(); else if (selection.length) setSel([]); else toggleMenu(); }
    else if (e.code === 'Equal' || e.code === 'NumpadAdd') stepSpeed(1);
    else if (e.code === 'Minus' || e.code === 'NumpadSubtract') stepSpeed(-1);
    else if (e.code === 'Backspace') { e.preventDefault(); if (lastAlert) view.flyTo(lastAlert.x, lastAlert.z, undefined, 800); }
    else if (e.code === 'KeyL') { edgeOn = !edgeOn; setPref('nic-edge', edgeOn); toast(edgeOn ? 'Edge scrolling on' : 'Edge scrolling off'); }
    else if (e.code === 'KeyH') src.cmd({ c: 'stop', ids: selection });
    else if (e.code === 'KeyV') special();
    else if (e.code === 'KeyG') cycleStance();
    else if (e.code === 'KeyN') replenish();
    else if (e.code === 'KeyK' && selection.length) { if (selUnits().some((u: any) => isInfantry(u) && !u.routed && u.form !== 'square')) startTargeting('bayonet'); else deny('Only formed infantry can make a bayonet charge'); }
    else if (e.code === 'KeyR') toast(toggleRadio() ? 'Radio on' : 'Radio off');
    else if (e.code === 'KeyT') { duskOn = !duskOn; view.setDusk(duskOn); toast(duskOn ? 'Dusk' : 'Daylight'); }
    else if (e.code === 'KeyY') { silOn = !silOn; view.setSilhouette(silOn); toast(silOn ? 'Silhouette check' : 'Silhouette off'); }
    else if (e.code === 'KeyU') { topOn = !topOn; view.setTopDown(topOn); toast(topOn ? 'Top-down check' : 'Iso view'); }
    else if (e.code === 'KeyP') toast(`Render quality - ${view.cycleQuality()}`);
    else if (view.guide && !e.repeat && (e.code === 'KeyQ' || e.code === 'KeyE')) view.rotate90(e.code === 'KeyQ' ? 1 : -1);
    else if (e.code === 'KeyF' && selection.length) {
      const us = src.state.units.filter((u: any) => selection.includes(u.id));
      view.flyTo(us.reduce((a: number, u: any) => a + u.x, 0) / us.length, us.reduce((a: number, u: any) => a + u.z, 0) / us.length, undefined, 800);
    } else {
      FORMS.forEach(([f, k]) => { if (e.code === `Key${k}`) reform(f); });
      abilities.forEach((a) => { if (e.code === ABKEY[a]) startTargeting(a); });
    }
  };
  // control groups: Shift+1..9 saves the selection (Ctrl+number would switch browser tabs), 1..9 recalls it, a quick second tap flies there
  const groups: Record<number, number[]> = {};
  let lastGroup = { n: 0, t: 0 };
  const centre = (us: any[]) => ({ x: us.reduce((a, u) => a + u.x, 0) / us.length, z: us.reduce((a, u) => a + u.z, 0) / us.length });
  function group(n: number, save: boolean) {
    if (save) { if (selection.length) { groups[n] = selection.slice(); toast(`Group ${n} set (${selection.length})`); } return; }
    const us = src.state.units.filter((u: any) => mine(u) && groups[n]?.includes(u.id));
    if (!us.length) return;
    setSel(us.map((u: any) => u.id));
    const now = performance.now();
    if (lastGroup.n === n && now - lastGroup.t < 350) { const c = centre(us); view.flyTo(c.x, c.z, undefined, 600); }
    lastGroup = { n, t: now };
  }
  // idle regiments: no orders, not fighting, not in a farm — I cycles through them
  let idleLast = 0; // the last regiment I jumped to: the next press goes to the next one by id, however the list changes meanwhile
  function nextIdle() {
    const idle = src.state.units.filter((u: any) => mine(u) && isIdle(u)).sort((a: any, b: any) => a.id - b.id);
    if (!idle.length) { toast('No idle regiments'); return; }
    const u = idle.find((q: any) => q.id > idleLast) ?? idle[0]; idleLast = u.id;
    setSel([u.id]); view.flyTo(u.x, u.z, undefined, 600);
  }
  const keyup = (e: KeyboardEvent) => { keys.delete(e.code); if (e.key === 'Alt') { e.preventDefault(); view.setShowAll(false); } if (e.code === 'KeyA' && selection.length && performance.now() - aDown < 200) startTargeting('amove'); }; // a tap of A: attack-move
  addEventListener('keydown', keydown); addEventListener('keyup', keyup);
  const onOut = (e: MouseEvent) => { if (!e.relatedTarget) mouse.in = false; }, onBlur = () => { mouse.in = false; keys.clear(); view.setShowAll(false); }; // the pointer left the window: no edge scrolling
  document.addEventListener('mouseout', onOut); addEventListener('blur', onBlur);
  const help = $<HTMLElement>(hud, '#help');
  const toggleHelp = () => { help.style.display = help.style.display === 'none' ? '' : 'none'; };
  help.onclick = toggleHelp; $<HTMLElement>(hud, '#hlp').onclick = toggleHelp;
  const flashBtn = (sel: string) => { const b = hud.querySelector(sel); if (b) animate(b, { scale: [0.88, 1], duration: 300, ease: 'outBack' }); };

  // buttons
  /** change formation; foot that are stunned or shaken cannot (the sim skips them), so say so */
  function reform(f: string) {
    const us = selUnits(), inf = us.filter(isInfantry), cav = us.filter(isCav), cf = CAV_FORM[f];
    const stuck = [...inf.filter((u: any) => u.form !== f), ...(cf ? cav.filter((u: any) => u.form !== cf) : [])].filter((u: any) => !u.routed && (u.stun > 0 || u.shaken > 0));
    if (stuck.length) deny(`${stuck.length === 1 ? stuck[0].name : `${stuck.length} regiments`} cannot change formation while ${stuck.some((u: any) => u.stun > 0) ? 'stunned' : 'shaken'}`);
    if (!inf.length && !cf && cav.length) { deny('Horse cannot form square: Z squadron, X wedge'); return; }
    if (inf.length || !cav.length) src.cmd({ c: 'form', ids: selection, f });
    if (cav.length && cf) src.cmd({ c: 'form', ids: selection, f: cf });
    flashBtn(`[data-form="${f}"]`);
  }
  /** the special (V): say why when nothing in the selection can use it */
  function special() {
    const us = selUnits().filter((u: any) => TUNING.specials[u.type] && !u.routed);
    if (!selection.length) return;
    if (!us.length) { deny('This selection has no special'); return; }
    const wait = Math.min(...us.map((u: any) => u.spReady - src.state.t));
    if (wait > 0) { deny(`${TUNING.specials[us[0].type].label} is ready in ${Math.ceil(wait)}s`); return; }
    src.cmd({ c: 'special', ids: selection });
  }
  /** replenish (N): on a held objective it toggles; elsewhere a draft costs points, so say when there are none to spend */
  function replenish() {
    const sd = src.state.side[me], all = selUnits().filter((u: any) => u.type !== 'commander' && u.men < u.maxMen && u.draftFor == null && !u.routed);
    if (!selection.length) return;
    if (!all.length) { deny('Nothing to replenish: the selection is at full strength'); return; }
    const hurt = all.filter(calmHere);
    if (!hurt.length) { deny(`Cannot replenish in combat or with the enemy within ${TUNING.refillClear} units`); return; }
    const far = hurt.filter((u: any) => !heldGround(u) && !drafting(u));
    if (!hurt.some(heldGround) && !far.length) { deny('A draft is already on its way'); return; }
    if (!hurt.some(heldGround) && far.every((u: any) => draftMen(u) < u.maxMen * 0.05)) { deny(sd.pool < 1 ? 'The depots are empty: no replacements left' : 'Not enough reserve points for a draft'); return; }
    src.cmd({ c: 'replenish', ids: selection });
  }
  hud.querySelectorAll<HTMLElement>('[data-form]').forEach((b) => (b.onclick = () => reform(b.dataset.form!)));
  $<HTMLElement>(hud, '[data-stop]').onclick = () => src.cmd({ c: 'stop', ids: selection });
  $<HTMLElement>(hud, '[data-special]').onclick = special;
  const stancesOf = (u: any) => (u.type === 'skirmisher' ? ['hold', 'aggressive', 'skirmish'] : u.type === 'artillery' ? ['hold', 'holdfire'] : isInfantry(u) ? ['hold', 'aggressive', 'holdfire'] : ['hold', 'aggressive']);
  const cycleStance = () => { // the first regiment's next stance, given to those of the selection that have it (a gun battery has no skirmish stance)
    const u = src.state.units.find((q: any) => q.id === selection[0]); if (!u) return;
    const order = stancesOf(u), to = order[(order.indexOf(u.stance) + 1) % order.length];
    src.cmd({ c: 'stance', ids: selUnits().filter((q: any) => stancesOf(q).includes(to)).map((q: any) => q.id), s: to });
  };
  $<HTMLElement>(hud, '[data-stance]').onclick = cycleStance;
  $<HTMLElement>(hud, '[data-refill]').onclick = replenish;
  $<HTMLElement>(hud, '[data-bay]').onclick = () => startTargeting('bayonet');
  hud.querySelectorAll<HTMLElement>('[data-ab]').forEach((b) => (b.onclick = () => startTargeting(b.dataset.ab!)));
  hud.querySelectorAll<HTMLElement>('[data-res]').forEach((b) => (b.onclick = () => {
    const t = b.dataset.res!, sd = src.state.side[me], T = TUNING.types[t];
    if ((sd.reserves[t] ?? 0) <= 0) { deny(`No ${T.label} left in reserve`); return; }
    if (sd.rp < T.cost) { deny(`${T.label} needs ${T.cost} points (you have ${Math.floor(sd.rp)})`); return; }
    src.cmd({ c: 'deploy', type: t }); animate(b, { scale: [0.9, 1], duration: 300, ease: 'outBack' });
  }));
  const setSpeed = (s: number) => {
    if (src.mode === 'remote' || deploying()) return; // the clock stays stopped until the battle starts
    if (s === 0) src.paused = true; else { src.paused = false; src.speed = s; }
    hud.querySelectorAll<HTMLElement>('[data-sp]').forEach((b) => b.classList.toggle('on', Number(b.dataset.sp) === (src.paused ? 0 : src.speed)));
  };
  hud.querySelectorAll<HTMLElement>('[data-sp]').forEach((b) => (b.onclick = () => setSpeed(Number(b.dataset.sp))));
  const startBattle = () => { if (deploying() && pm.style.display === 'none') { src.cmd({ c: 'start' }); setSpeed(1); } }; // not from behind the menu
  $<HTMLElement>(hud, '#depgo').onclick = startBattle;
  const SPEEDS = src.replay ? [1, 2, 4, 8, 16] : [1, 2, 4, 8];
  const stepSpeed = (d: number) => { if (src.mode !== 'local') return; setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, Math.max(0, SPEEDS.indexOf(src.speed)) + d))]); toast(`Speed ${src.speed}×`); };
  // menu (Esc / ☰): pauses a local battle; restart, quit, and the settings
  const pm = $<HTMLElement>(hud, '#pm');
  let pmWas = 1; // the speed to go back to (0: it was paused already)
  function toggleMenu() {
    const open = pm.style.display === 'none';
    if (open && ended) return; // the result card has its own buttons
    pm.style.display = open ? '' : 'none';
    disarm();
    if (open) { pmWas = src.paused ? 0 : src.speed; setSpeed(0); settings($(pm, '.sets'), view, () => { edgeOn = pref('nic-edge', true); }); }
    else setSpeed(pmWas);
  }
  $<HTMLElement>(hud, '#pmb').onclick = toggleMenu;
  let armed: HTMLElement | null = null, armT = 0; // restart, and quit without saving, lose the battle in progress: the first click asks, the second does it
  const disarm = () => { clearTimeout(armT); if (armed) armed.textContent = armed.dataset.l!; armed = null; };
  const risky = (a: string) => src.mode === 'local' && !src.replay && (a === 'retry' || (a === 'menu' && !opts.campaign));
  pm.querySelectorAll<HTMLElement>('[data-pm]').forEach((b) => {
    b.dataset.l = b.textContent!;
    b.onclick = () => {
      const a = b.dataset.pm!;
      if (a === 'resume') toggleMenu();
      else if (risky(a) && armed !== b) { disarm(); armed = b; b.textContent = 'Sure? Click again'; armT = window.setTimeout(disarm, 3000); }
      else opts.onExit(a as Outcome);
    };
  });
  $<HTMLElement>(hud, '#mute').onclick = () => { $(hud, '#mute').textContent = toggleMute() ? '🔇' : '🔊'; };
  if (src.mode === 'remote') {
    hud.querySelectorAll<HTMLElement>('[data-sp]').forEach((b) => (b.style.display = 'none'));
    const leave = $<HTMLElement>(hud, '#leave');
    leave.style.display = '';
    leave.onclick = () => opts.onExit('menu'); // onExit destroys the battle, which closes the socket
  }

  // minimap
  const mini = $<HTMLCanvasElement>(hud, '#mini'), mctx = mini.getContext('2d')!;
  mini.oncontextmenu = (e) => e.preventDefault();
  let miniDrag: { x: number; y: number } | null = null;
  mini.onpointerdown = (e) => { // left: look there (drag: pan along); right: send the selection there
    const r = mini.getBoundingClientRect(), S = view.mapSize, x = ((e.clientX - r.left) / r.width - 0.5) * S, z = ((e.clientY - r.top) / r.height - 0.5) * S;
    if (e.button === 2) { if (selection.length) src.cmd({ c: 'move', ids: selection, x, z, q: e.shiftKey, col: col() }); }
    else { view.flyTo(x, z, undefined, 600); miniDrag = { x: e.clientX, y: e.clientY }; mini.setPointerCapture(e.pointerId); }
  };
  mini.onpointermove = (e) => {
    if (!miniDrag || Math.hypot(e.clientX - miniDrag.x, e.clientY - miniDrag.y) < 4) return; // a click flies there smoothly; a drag follows the pointer
    miniDrag.x = -1e9; // past the threshold once: follow from now on
    const r = mini.getBoundingClientRect(), S = view.mapSize;
    view.stopCam(); view.cam.x = Math.max(-S / 2, Math.min(S / 2, ((e.clientX - r.left) / r.width - 0.5) * S)); view.cam.z = Math.max(-S / 2, Math.min(S / 2, ((e.clientY - r.top) / r.height - 0.5) * S));
  };
  mini.onpointerup = () => { miniDrag = null; };
  const ghosts = new Map<number, { x: number; z: number; t: number }>(); // fog of war: where each enemy regiment was last seen
  function drawMini(st: any) {
    const W = mini.width, S = view.mapSize, k = W / S, c = mctx;
    const m = W / 170;
    c.fillStyle = '#1d2a1c'; c.fillRect(0, 0, W, W);
    c.strokeStyle = '#3b5a37'; c.strokeRect(0.5, 0.5, W - 1, W - 1);
    for (const r of scn.map.rivers ?? []) { c.strokeStyle = '#3d6fa8'; c.lineWidth = 1; c.beginPath(); r.pts.forEach(([x, z]: number[], i: number) => (i ? c.lineTo((x + S / 2) * k, (z + S / 2) * k) : c.moveTo((x + S / 2) * k, (z + S / 2) * k))); c.stroke(); }
    c.lineWidth = 1;
    for (const w of scn.map.woods ?? []) { c.fillStyle = '#254a27'; c.beginPath(); c.arc((w.x + S / 2) * k, (w.z + S / 2) * k, w.r * k, 0, 6.3); c.fill(); }
    for (const z of st.zones) { c.strokeStyle = z.owner === 0 ? SIDE_COLOR[0] : z.owner === 1 ? SIDE_COLOR[1] : '#bbb'; c.beginPath(); c.arc((z.x + S / 2) * k, (z.z + S / 2) * k, z.r * k, 0, 6.3); c.stroke(); }
    if (deploying()) { c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--mine') || '#4f86ff'; c.globalAlpha = 0.35; c.beginPath(); for (const d of st.deploy[me]) { c.moveTo((d.x + d.r + S / 2) * k, (d.z + S / 2) * k); c.arc((d.x + S / 2) * k, (d.z + S / 2) * k, d.r * k, 0, 6.3); } c.fill(); c.globalAlpha = 1; } // the deployment zone in the friendly colour (palette setting), filled once as one shape so overlaps don't darken
    const big = W > 96, ds = big ? 4 : 2; // the big map (Tab): bigger dots and the objectives' names
    if (big) {
      c.font = '8px Silkscreen'; c.textAlign = 'center';
      for (const z of st.zones) { const x = Math.round((z.x + S / 2) * k), y = Math.round((z.z + S / 2) * k - z.r * k - 3); c.fillStyle = '#000'; c.fillText(z.name, x + 1, y + 1); c.fillStyle = '#e9e4d6'; c.fillText(z.name, x, y); }
    }
    const dot = (x: number, z: number) => c.fillRect(Math.round((x + S / 2) * k) - ds / 2, Math.round((z + S / 2) * k) - ds / 2, ds, ds);
    for (const u of st.units) {
      if (st.fog && u.side !== me) {
        const g = ghosts.get(u.id);
        if (st.seen?.[me]?.includes(u.id)) ghosts.set(u.id, { x: u.x, z: u.z, t: st.t });
        else { if (g && st.t - g.t < 30) { c.globalAlpha = 0.4 * (1 - (st.t - g.t) / 30); c.fillStyle = SIDE_COLOR[u.side]; dot(g.x, g.z); c.globalAlpha = 1; } continue; } // fog: a fading dot where it was last seen
      }
      c.fillStyle = u.routed ? '#999' : SIDE_COLOR[u.side]; dot(u.x, u.z);
    }
    c.strokeStyle = '#fff'; c.strokeRect(Math.round((view.cam.x + S / 2) * k - 12 * m), Math.round((view.cam.z + S / 2) * k - 9 * m), Math.round(24 * m), Math.round(18 * m));
  }

  // ---------------------------------------------------------------- order cursor, unit card, camera views, follow, message log, big map
  const clockAt = (t: number) => { const hr = hour(scn, t); return `${pad(hr)}:${pad((hr % 1) * 60)}`; }; // the sim's clock (minutes included): night falls by it
  const CURSOR = { attack: pxCursor('sword', 0, 0), garrison: pxCursor('house', 5, 6), move: pxCursor('march', 5, 8) };
  let cursor = '';
  /** with regiments selected the cursor shows what a right-click there would do, decided as rightClick decides */
  function setCursor(g: { x: number; z: number } | null) {
    if (targeting) { cursor = 'crosshair'; return; }
    let c = '';
    if (g && selection.length) {
      const st = src.state, seenFoe = (u: any) => u.side !== me && !u.dead && (!st.fog || st.seen?.[me]?.includes(u.id));
      c = unitAt(g, seenFoe) || view.pickUnit(st, mouse.x, mouse.y, seenFoe, 34) ? CURSOR.attack : (scn.map.villages ?? []).some((v: any) => v.garrison && Math.hypot(v.x - g.x, v.z - g.z) < v.r + 2) ? CURSOR.garrison : CURSOR.move;
    }
    if (c !== cursor) { cursor = c; dom.style.cursor = c; }
  }
  const STANCE: Record<string, string> = { hold: 'Hold', aggressive: 'Attack', skirmish: 'Skirmish', holdfire: 'Hold fire' };
  /** exactly one regiment selected: formation, stance, numbers, fatigue, rank and status under its row */
  function unitCard(u: any) {
    const ST: Record<string, string> = { routed: 'Routed', stun: `Stunned ${Math.ceil(u.stun)}s`, shaken: `Shaken ${Math.ceil(u.shaken)}s`, waver: 'Wavering', charge: 'Charging', tired: 'Tired', posted: 'Posted' };
    const more = [u.garrison != null && `Garrison: ${esc(scn.map.villages?.[u.garrison]?.name ?? 'farm')}`, u.type === 'artillery' && (u.limT > 0 ? (u.limbered ? 'Unlimbering' : 'Limbering up') : u.limbered ? 'Limbered' : 'Unlimbered')].filter(Boolean);
    return `<div class="one"><p>${TUNING.types[u.type].label}${u.type === 'line' || u.type === 'guard' || isCav(u) ? ` · ${formName(u)}` : ''} · ${STANCE[u.stance] ?? esc(u.stance)}</p>`
      + `<p>Men ${Math.round(u.men)}/${u.maxMen} · Morale ${Math.max(0, Math.round((u.morale / u.maxMorale) * 100))}%</p>`
      + `<p>Fatigue ${Math.round((u.fat ?? 0) * 100)}% · ${u.vet ? `${'*'.repeat(u.vet)} ${VET[u.vet]}` : 'Green'}${TUNING.types[u.type].ammo ? ` · Ammo ${Math.ceil(u.ammo)}/${TUNING.types[u.type].ammo}${u.ammo < 1 ? ' (dry)' : ''}` : ''}</p>`
      + `<p class="st">${unitStatus(u, src.state.t, TUNING).map((k) => `<span><img src="${pxUrl(k)}">${ST[k]}</span>`).join('')}${more.map((s) => `<span>${s}</span>`).join('')}</p></div>`;
  }
  // camera views: Ctrl+F5-F8 saves one, F5-F8 flies back to it
  const views: { x: number; z: number; dist: number; yaw: number }[] = [];
  function camView(i: number, save: boolean) {
    const c = view.cam, v = views[i];
    if (save) { views[i] = { x: c.x, z: c.z, dist: c.dist, yaw: c.yaw }; toast(`View saved to F${i + 5}`); }
    else if (!v) toast(`No view on F${i + 5}: Ctrl+F${i + 5} saves one`);
    else { view.flyTo(v.x, v.z, v.dist, 500); animate(c, { yaw: c.yaw + Math.atan2(Math.sin(v.yaw - c.yaw), Math.cos(v.yaw - c.yaw)), duration: 500, ease: 'inOutQuad' }); } // the short way round
  }
  // follow (O): the camera trails the selection's centre until something else moves it
  let follow: { x: number; z: number } | null = null; // where following last put the camera
  function followCam(dt: number) {
    if (!follow) return;
    const c = view.cam;
    if (c.x !== follow.x || c.z !== follow.z) { follow = null; toast('Follow off'); return; } // a pan, fly-to or minimap click took over
    const us = src.state.units.filter((u: any) => selection.includes(u.id) && !u.dead);
    if (!us.length) return;
    const p = centre(us), k = 1 - Math.exp(-6 * dt);
    c.x += (p.x - c.x) * k; c.z += (p.z - c.z) * k; follow.x = c.x; follow.z = c.z;
  }
  // message log (J): every toast and popup of this battle with its clock time, newest first; lines with a place fly there
  const journal: { t: string; m: string; at?: { x: number; z: number } }[] = [];
  const logEl = document.createElement('div');
  logEl.className = 'panel'; logEl.id = 'log'; logEl.style.display = 'none';
  logEl.innerHTML = '<div class="hd">Messages <small>J / Esc to close</small></div><div class="lg"></div>';
  hud.appendChild(logEl);
  const logList = $<HTMLElement>(logEl, '.lg');
  const logRow = (e: (typeof journal)[number]) => {
    const p = document.createElement('p'), at = e.at;
    p.textContent = `${e.t} ${e.m}`;
    if (at) { p.className = 'go'; p.onclick = () => view.flyTo(at.x, at.z, undefined, 800); }
    return p;
  };
  function note(m: string, at?: { x: number; z: number }) {
    const e = { t: clockAt(src.state.t), m, at: at && { x: at.x, z: at.z } };
    journal.push(e);
    if (logEl.style.display !== 'none') logList.prepend(logRow(e));
  }
  const toggleLog = () => { const open = logEl.style.display === 'none'; logEl.style.display = open ? '' : 'none'; if (open) logList.replaceChildren(...journal.map(logRow).reverse()); };
  const bigMap = () => { const on = mini.classList.toggle('big'); mini.width = mini.height = on ? 288 : 96; drawMini(src.state); };
  /** F5-F8 / Ctrl+F5-F8 camera views (kept from the browser's reload), O follow, J message log, Tab big map */
  function viewKey(e: KeyboardEvent) {
    const f = /^F([5-8])$/.exec(e.key); // key, not code: input without scan codes (remote desktops, on-screen keyboards) still gets the reload blocked
    if (f) { e.preventDefault(); if (!intro && !e.repeat) camView(Number(f[1]) - 5, e.ctrlKey || e.metaKey); return true; }
    if (e.code === 'Tab') e.preventDefault(); // no focus hopping between buttons
    if (intro || e.repeat) return false;
    if (e.code === 'Tab') bigMap();
    else if (e.code === 'KeyJ') toggleLog();
    else if (e.code === 'Escape' && logEl.style.display !== 'none') toggleLog();
    else if (e.code === 'KeyO') { const was = follow; follow = was || !selection.length ? null : { x: view.cam.x, z: view.cam.z }; toast(follow ? 'Following the selection' : was ? 'Follow off' : 'Select regiments to follow'); }
    else return false;
    return true;
  }

  // ---------------------------------------------------------------- intro (cinematic)
  let intro: any = null;
  const first = scn.zones.slice().sort((a: any, b: any) => b.value - a.value)[0];
  const start = { x: 0, z: 0 };
  {
    const us = state0.units.filter(mine);
    if (us.length) { start.x = us.reduce((a: number, u: any) => a + u.x, 0) / us.length; start.z = us.reduce((a: number, u: any) => a + u.z, 0) / us.length; }
  }
  function playIntro() {
    const el = $<HTMLElement>(hud, '#intro');
    $(el, 'small').textContent = scn.date; $(el, 'p').textContent = `${me === 0 ? scn.hint ?? '' : 'You command the Coalition: hold the objectives and break the French attack.'} Victory: hold more objectives when time runs out, or break the enemy army.`;
    $(el, 'h1').innerHTML = [...scn.title].map((c: string) => `<span>${c === ' ' ? '&nbsp;' : c}</span>`).join('');
    view.cam.x = first.x; view.cam.z = first.z; view.cam.dist = 280; view.cam.yaw = 0.5;
    src.paused = true;
    intro = createTimeline({ onComplete: endIntro })
      .add('#fade', { opacity: [1, 0], duration: 1400, ease: 'inOutQuad' }, 0)
      .add(el, { opacity: [0, 1], duration: 500 }, 300)
      .add($(el, 'small'), { opacity: [0, 1], translateY: [10, 0], duration: 600 }, 400)
      .add(el.querySelectorAll('h1 span'), { opacity: [0, 1], translateY: [24, 0], rotateX: [70, 0], duration: 700, delay: stagger(45), ease: 'outBack' }, 600)
      .add($(el, 'p'), { opacity: [0, 1], duration: 700 }, 1500)
      .add(view.cam, { x: start.x, z: start.z, dist: START_DIST, yaw: 0, duration: 3600, ease: 'inOutCubic' }, 700)
      .add(el, { opacity: 0, duration: 700, ease: 'inQuad' }, 3300);
  }
  function endIntro() {
    intro = null;
    $<HTMLElement>(hud, '#intro').style.display = 'none';
    $<HTMLElement>(hud, '#fade').style.display = 'none';
    lastLogT = src.state.t;
    if (src.mode === 'local') setSpeed(1);
  }
  function skipIntro() { const t = intro; intro = null; t?.complete(); endIntro(); view.cam.x = start.x; view.cam.z = start.z; view.cam.dist = START_DIST; view.cam.yaw = 0; }
  if (src.mode === 'local') playIntro(); else { $<HTMLElement>(hud, '#fade').style.display = 'none'; $<HTMLElement>(hud, '#intro').style.display = 'none'; view.cam.x = start.x; view.cam.z = start.z; view.cam.dist = START_DIST; }

  // ---------------------------------------------------------------- result overlay
  const mmss = (t: number) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  function reportHtml(r: any) {
    const s = r.stats; if (!s) return '';
    const top = s.top[me].filter((u: any) => u.xp > 0).slice(0, 2).map((u: any) => `<li>${'*'.repeat(Number(u.vet) || 0)} ${esc(u.name)}: ${esc(u.xp)} men</li>`).join('');
    const ev = s.chron.slice(-6).map((e: any) => `<li style="color:${SIDE_COLOR[e.side]}">${mmss(e.t)} ${esc(e.text)}</li>`).join('');
    return `<canvas id="chart" width="200" height="40"></canvas><div class="rep"><div><b>Best regiments</b><ul>${top || '<li>-</li>'}</ul></div><div><b>Turning points</b><ul>${ev || '<li>-</li>'}</ul></div></div>`;
  }
  function drawChart(r: any) {
    const cv = hud.querySelector<HTMLCanvasElement>('#chart'), h = r.stats?.hist; if (!cv || !h || h.length < 2) return;
    const c = cv.getContext('2d')!, W = cv.width, H = cv.height, mx = Math.max(1, ...h.map((p: any) => Math.max(p.l0, p.l1))), tM = h[h.length - 1].t || 1;
    c.fillStyle = '#14110d'; c.fillRect(0, 0, W, H);
    for (const [key, col] of [[me === 0 ? 'l1' : 'l0', SIDE_COLOR[1 - me]], [me === 0 ? 'l0' : 'l1', SIDE_COLOR[me]]] as any[]) {
      c.fillStyle = col;
      for (const p of h) c.fillRect(Math.round((p.t / tM) * (W - 2)), H - 1 - Math.round((p[key] / mx) * (H - 4)), 2, 2);
    }
  }
  function showResult(st: any) {
    ended = true;
    const r = st.result, won = r.winner === me, draw = r.winner < 0;
    const el = $<HTMLElement>(hud, '#result');
    const held = [0, 0]; for (const z of st.zones) if (z.owner != null) held[z.owner] += z.value;
    const guard = st.waves ? 1 - st.waves.side : -1, lasted = Math.round(r.stats?.t ?? st.t); // endless waves: the title is about the besieged side
    const title = st.waves ? (me === guard ? (won ? 'THE GUARD STANDS' : 'THE GUARD FALLS') : (won ? 'THE GUARD IS BROKEN' : 'THE GUARD HOLDS')) : draw ? 'DRAW' : won ? (r.decisive ? 'DECISIVE VICTORY' : 'VICTORY') : r.decisive ? 'CRUSHING DEFEAT' : 'DEFEAT';
    const rep = '<button id="rrep" class="alt">Watch replay</button><button id="rsave" class="alt">Save replay</button>';
    const next = src.replay ? '<button id="rretry">Watch again</button><button id="rmenu" class="alt">Back</button>'
      : opts.campaign ? `<button id="rcont">Continue the campaign</button>${won ? '' : '<button id="rretry" class="alt">Retry battle</button>'}${rep}`
      : src.mode === 'local' ? `<button id="rretry">Play again</button>${rep}<button id="rmenu" class="alt">Back to menu</button>` : '<button id="rmenu">Back to menu</button>';
    el.innerHTML = `<div class="card ${draw ? 'draw' : won ? 'win' : 'loss'}"><h2>${title}</h2><p>${scn.title}, ${scn.date}</p>
      <table><tr><th></th><th>${SIDE_NAME[me]} (you)</th><th>${SIDE_NAME[1 - me]}</th></tr>
      <tr><td>Score</td><td class="n" data-v="${Number(r.score[me])}">0</td><td class="n" data-v="${Number(r.score[1 - me])}">0</td></tr>
      <tr><td>Men lost</td><td class="n" data-v="${Number(r.lost[me])}">0</td><td class="n" data-v="${Number(r.lost[1 - me])}">0</td></tr>
      <tr><td>Objectives held</td><td>${held[me]}</td><td>${held[1 - me]}</td></tr>${st.waves ? `<tr><td>Time held</td><td colspan="2">${Math.floor(lasted / 60)}:${pad(lasted % 60)} · ${st.wave} waves came</td></tr>` : ''}</table>
      <p class="sub">The verdict weighs objectives held ${Math.round(TUNING.endHeldWeight * 100)}%, points ${Math.round((1 - TUNING.endHeldWeight) * 100)}%: a side can win with fewer points.</p>
      ${reportHtml(r)}
      <div class="rb">${next}</div></div>`;
    el.style.display = 'flex';
    drawChart(r);
    const card = $(el, '.card');
    createTimeline()
      .add(el, { opacity: [0, 1], duration: 500 })
      .add(card, { scale: [0.8, 1], translateY: [30, 0], opacity: [0, 1], duration: 650, ease: 'outBack' }, 150);
    el.querySelectorAll<HTMLElement>('.n').forEach((n, i) => {
      const o = { v: 0 };
      animate(o, { v: Number(n.dataset.v), duration: 1400, delay: 700 + i * 150, ease: 'outExpo', onUpdate: () => (n.textContent = String(Math.round(o.v))) });
    });
    const go = (o: Outcome) => () => opts.onExit(o);
    el.querySelector<HTMLElement>('#rcont')?.addEventListener('click', go('continue'));
    el.querySelector<HTMLElement>('#rretry')?.addEventListener('click', go('retry'));
    el.querySelector<HTMLElement>('#rmenu')?.addEventListener('click', go('menu'));
    el.querySelector<HTMLElement>('#rrep')?.addEventListener('click', go('replay'));
    el.querySelector<HTMLElement>('#rsave')?.addEventListener('click', () => { // download the recording; the file names its scenario, it does not carry it
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([replayFile(src.rec!)], { type: 'application/json' }));
      a.download = `${scn.id}-replay.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    cue(won ? 'capture' : 'alert');
  }

  // ---------------------------------------------------------------- replay bar: play/pause, speed up to 16×, a scrubber that seeks (nearest keyframe, then fast-forward), turning points as markers
  if (src.replay && src.rec?.end && src.seek) {
    const t0 = state0.t, span = src.rec.end * DT, seek = src.seek;
    const bar = document.createElement('div');
    bar.className = 'panel rbar';
    bar.innerHTML = `<button id="rpp" title="Play / pause (Space)">⏸</button>${[1, 2, 4, 8, 16].map((s) => `<button data-sp="${s}">${s}×</button>`).join('')}<span></span><div class="track" title="Click or drag to jump"><i></i></div>`;
    hud.appendChild(bar); hud.classList.add('replay');
    bar.style.top = `${topbar.offsetHeight + 4}px`;
    const track = $<HTMLElement>(bar, '.track'), fill = $<HTMLElement>(track, 'i'), clk = $<HTMLElement>(bar, 'span'), pp = $<HTMLElement>(bar, '#rpp');
    const to = (t: number) => seek(Math.round((Math.max(t0, Math.min(t0 + span, t)) - t0) / DT));
    for (const c of src.rec.chron ?? []) {
      if (c.t < t0 || c.t > t0 + span) continue; // a resumed battle's chronicle starts before its recording
      const m = document.createElement('b');
      m.style.left = `${((c.t - t0) / span) * 100}%`; m.style.background = SIDE_COLOR[c.side]; m.title = `${mmss(c.t)} ${c.text}`;
      m.onpointerdown = (e) => { e.stopPropagation(); to(c.t - 5); }; // a little before, to see it happen
      track.appendChild(m);
    }
    let scrub = -1; // where the drag is (0..1), while dragging: the seek happens on release
    const frac = (e: PointerEvent) => { const b = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)); };
    track.onpointerdown = (e) => { track.setPointerCapture(e.pointerId); scrub = frac(e); };
    track.onpointermove = (e) => { if (scrub >= 0) scrub = frac(e); };
    track.onpointerup = (e) => { if (scrub < 0) return; scrub = -1; to(t0 + frac(e) * span); };
    bar.querySelectorAll<HTMLElement>('[data-sp]').forEach((b) => (b.onclick = () => setSpeed(Number(b.dataset.sp))));
    hud.querySelectorAll<HTMLElement>('.ctl [data-sp]').forEach((b) => (b.style.display = 'none')); // the bar has them
    let was = 1;
    pp.onclick = () => { if (src.paused) setSpeed(was); else { was = src.speed; setSpeed(0); } };
    const paint = () => {
      if (!bar.isConnected) return; // the battle is over and gone
      requestAnimationFrame(paint);
      const t = scrub >= 0 ? t0 + scrub * span : src.state.t;
      fill.style.width = `${Math.min(100, ((t - t0) / span) * 100)}%`;
      const c = `${mmss(Math.floor(t))} / ${mmss(Math.floor(t0 + span))}`, g = src.paused ? '▶' : '⏸';
      if (clk.textContent !== c) clk.textContent = c;
      if (pp.textContent !== g) pp.textContent = g;
    };
    paint();
  }

  // ---------------------------------------------------------------- per-frame
  let last = performance.now(), hudAcc = 0, lastWx = '', lastClk = '', lastPool = '';
  const wav = new Set<number>(); // regiments already reported wavering (until they steady again)
  const warned = new Set([120, 30].filter((w) => scn.duration - state0.t <= w)); // time warnings already given (a resumed battle may be past them)
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const st = src.state;
    if (src.seeking || st.t < prevT - 1 || st.t > prevT + 5) { lastLogT = st.t; ended = false; warned.clear(); $<HTMLElement>(hud, '#result').style.display = 'none'; for (const z of st.zones) { prevOwner[z.id] = z.owner; paintPip(z, false); } } // remote room restarted, or a replay seek: no flood of stale news
    prevT = st.t;

    // camera pan
    const sp = view.cam.dist * 0.9 * dt;
    let dx = 0, dz = 0;
    if ((keys.has('KeyA') && (!selection.length || now - aDown > 200)) || keys.has('ArrowLeft')) dx -= sp; // with a selection, a quick tap of A is attack-move, not a nudge
    if (edgeOn && mouse.in && !drag && !rdrag && !rot && !intro) { // edge scrolling, like WASD
      if (mouse.x < 6) dx -= sp; else if (mouse.x > innerWidth - 7) dx += sp;
      if (mouse.y < 6) dz -= sp; else if (mouse.y > innerHeight - 7) dz += sp;
    }
    if (keys.has('KeyD') || keys.has('ArrowRight')) dx += sp;
    if (keys.has('KeyW') || keys.has('ArrowUp')) dz -= sp;
    if (keys.has('KeyS') || keys.has('ArrowDown')) dz += sp;
    if (!view.guide && keys.has('KeyQ')) view.cam.yaw += dt * 1.2;
    if (!view.guide && keys.has('KeyE')) view.cam.yaw -= dt * 1.2;
    if (dx || dz) view.pan(dx, dz);
    followCam(dt);

    src.update(dt);
    const evs = src.drainEvents();
    view.sync(st, dt, me, evs);
    playEvents(evs, view.cam.x, view.cam.z);
    view.render();

    for (const e of evs) {
      if (e.k === 'arrive') { popup(e); say(e.side === me ? 'Reinforcements have arrived, sir.' : 'Enemy reinforcements spotted.', 1); }
      else if (e.k === 'aid') aidCue(e);
      else if (e.k === 'flank' && e.side === me) {
        say(e.kind === 2 ? 'They are in our rear!' : 'We are being flanked!', 1);
        if (st.t - lastFlank > 4) { // the event has no name: it is the regiment standing where it happened
          lastFlank = st.t;
          const u = st.units.filter(mine).sort((a: any, b: any) => Math.hypot(a.x - e.x, a.z - e.z) - Math.hypot(b.x - e.x, b.z - e.z))[0];
          toast(`${u?.name ?? 'A regiment'} ${e.kind === 2 ? 'attacked in the rear' : 'flanked'}!`, e);
        }
      }
      else if (e.k === 'rank' && e.side === me) say(`${e.name} has earned its stripes.`);
      else if (e.k === 'rout') { say(e.side === me ? `${e.name} is breaking, sir!` : 'Enemy regiment is routing!', 1); toast(`${e.name} routs!`, e.side === me ? e : undefined); }
      else if (e.k === 'dead') { say(e.side === me ? `We have lost ${e.name}.` : 'Enemy regiment destroyed!', 1); toast(`${e.name} is destroyed!`, e.side === me ? e : undefined); }
      else if (e.k === 'special' && e.side === me) say(({ volley: 'Present! Fire!', sprint: 'Skirmishers, advance!', charge: 'Charge!', canister: 'Load canister!', rally: 'Rally to me!' } as any)[e.kind] ?? 'Yes sir!');
      else if (e.k === 'shot' && e.side !== me && st.t - lastContact > 40 && Math.hypot(e.x - view.cam.x, e.z - view.cam.z) < 70) { lastContact = st.t; say('Contact! Enemy in range.'); }
      else if (e.k === 'weather') banner(TUNING.weather[e.w].label, 'The weather turns', '#9fb4d0');
    }
    // new log lines -> toasts (zone captures get their own banner)
    for (const l of st.log) if (l.t > lastLogT) { if (!/ is taken by | routs!$| is destroyed!$/.test(l.msg)) toast(l.msg); } // routs, losses and captures toast from their events, with a place to click
    if (st.log.length) lastLogT = Math.max(lastLogT, st.log[st.log.length - 1].t);

    for (const z of st.zones) {
      if (z.owner !== prevOwner[z.id]) {
        prevOwner[z.id] = z.owner;
        paintPip(z, true);
        if (z.owner != null) say(z.owner === me ? `${z.name} is ours, sir.` : `We have lost ${z.name}!`, 1);
        if (z.owner != null) { banner(`${z.name} captured`, `${SIDE_NAME[z.owner]} · +${z.value}/s`, SIDE_COLOR[z.owner]); cue(z.owner === me ? 'capture' : 'alert'); toast(z.owner === me ? `${z.name} is ours` : `${z.name} taken by the enemy`, z); }
      }
    }

    // HUD refresh at ~8 Hz
    hudAcc += dt;
    if (hudAcc > 0.12) {
      hudAcc = 0;
      renderSel();
      const sd = st.side[me];
      tweenNumbers(st, sd.rp);
      for (const z of st.zones) { // capture progress: a bar under each objective's name
        const el = $<HTMLElement>(pips, `[data-z="${z.id}"]`), f = String(Math.round(Math.abs(z.p ?? 0) * 20) / 20), key = f + (z.p > 0 ? '+' : '-');
        if (el.dataset.f !== key) { el.dataset.f = key; el.style.setProperty('--f', f); el.style.setProperty('--fc', z.p > 0 ? 'var(--fr)' : 'var(--co)'); }
      }
      for (const u of st.units) { // a regiment about to break: an alert while there is still time to pull it out
        if (!mine(u)) continue;
        const r = u.morale / u.maxMorale;
        if (!u.routed && r < 0.3) { if (!wav.has(u.id)) { wav.add(u.id); toast(`${u.name} is wavering!`, u); } }
        else if (u.routed || r > 0.45) wav.delete(u.id);
      }
      const pl = `Replacements ${Math.floor(sd.pool ?? 0)}${sd.earned >= sd.cap ? ' · RP cap' : ''}`; if (pl !== lastPool) { $(hud, '#pool').textContent = pl; lastPool = pl; } // replacements left; "cap" = no more RP this battle
      const clk = clockAt(st.t);
      if (clk !== lastClk) { $(hud, '#clk').textContent = clk; lastClk = clk; }
      if (st.weather !== lastWx) { $(hud, '#wx').textContent = TUNING.weather[st.weather].label; lastWx = st.weather; }
      const timed = st.hold && st.t < st.hold.t, rem = Math.max(0, (timed ? st.hold.t : scn.duration) - st.t); // a timed objective counts down to its own deadline
      $(hud, '#left').textContent = st.waves ? `Held ${Math.floor(st.t / 60)}:${pad(st.t % 60)} · wave ${st.wave}` : `${Math.floor(rem / 60)}:${pad(rem % 60)} ${timed ? 'to hold' : 'left'}`; // a last stand counts up: how long the line has lasted
      for (const w of [120, 30]) if (rem <= w && !warned.has(w) && !st.over) { warned.add(w); banner(w >= 60 ? `${w / 60} MINUTES LEFT` : `${w} SECONDS LEFT`, timed ? `Hold ${st.zones.find((z: any) => z.id === st.hold.zone)?.name ?? 'the objective'}: ${st.hold.side === me ? 'you win' : 'the foe wins'} if it stands` : st.survive ? 'The army still fighting at the end decides the day' : 'The objectives held at the end decide the day', '#e8c46a'); cue('alert'); }
      for (const a of abilities) {
        const b = $<HTMLElement>(hud, `[data-ab="${a}"]`), cd = sd.cd[a] ?? 0, ab = abCfg(a);
        b.style.setProperty('--p', String(cd / ab.cd));
        $(b, '.cd').textContent = cd > 0 ? String(Math.ceil(cd)) : '';
        const ready = cd <= 0;
        b.classList.toggle('off', !ready);
        if (ready && abReady[a] === false) animate(b, { scale: [1.3, 1], duration: 600, ease: 'outElastic(1, .5)' });
        abReady[a] = ready;
      }
      hud.querySelectorAll<HTMLElement>('[data-res]').forEach((b) => {
        const t = b.dataset.res!, left = sd.reserves[t] ?? 0;
        $(b, 'u').textContent = `×${left}`;
        b.classList.toggle('off', left <= 0 || sd.rp < TUNING.types[t].cost);
      });
      drawMini(st);
      drawArmy(st);
      hoverTip(st);
      $<HTMLElement>(hud, '#dep').style.display = deploying() && !intro ? '' : 'none'; hud.classList.toggle('deploying', deploying());
      if (!intro) tut?.(st, me, selection);
    }
    if (st.over && !ended) showResult(st);
  }
  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      cancelAnimationFrame(raf); music(false);
      removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp);
      removeEventListener('keydown', keydown); removeEventListener('keyup', keyup); removeEventListener('blur', onBlur); document.removeEventListener('mouseout', onOut);
      dom.removeEventListener('wheel', wheel); dom.removeEventListener('pointerdown', onDown); dom.removeEventListener('contextmenu', onCtx);
      dom.style.cursor = '';
      hud.remove(); box.remove();
      view.setSelection([]);
      view.setReticle(null);
      src.close();
    },
  };
}
