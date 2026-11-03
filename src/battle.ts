// In-battle controller: input, HUD, and all the Anime.js presentation (banners, popups, counters, intro, outro).
import { animate, createTimeline, stagger, steps } from 'animejs';
import { ICONS, pxCanvas } from './pixel.ts';
import { distToFoot } from './sim/sim.ts';
import type { View } from './render.ts';
import { SIDE_COLOR } from './render.ts';
import type { Source } from './game.ts';
import { TUNING } from './campaign.ts';
import { playEvents, cue, toggleMute, unlock, music, say, toggleRadio } from './audio.ts';

export type Outcome = 'continue' | 'retry' | 'menu';
const SIDE_NAME = ['French', 'Coalition'];
const FORMS: [string, string, string][] = [['line', 'Z', 'Line'], ['column', 'X', 'Column'], ['square', 'C', 'Square']];
const ABKEY: Record<string, string> = { barrage: 'Digit1', rockets: 'Digit2', cavalry: 'Digit3' };
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
        <div class="ttl">${scn.title} <small>${scn.date}</small></div>
        <div class="tug"><i id="tug"></i></div>
        <div class="clock"><span id="clk">--:--</span> · <span id="wx">Clear</span> · <span id="left"></span></div>
        <div class="pips" id="pips"></div>
      </div>
      <div class="score s1"><b id="sc1">0</b><span class="lbl">Coalition</span></div>
    </div>
    <div class="ctl">
      <button data-sp="0" title="Pause (Space)">⏸</button><button data-sp="1" class="on">1×</button><button data-sp="2">2×</button><button data-sp="4">4×</button><button id="mute" title="Mute (M)">🔊</button><button id="leave" title="Leave battle" style="display:none">✕</button>
    </div>
    <div id="toasts"></div>
    <div id="popups"></div>
    <div id="banner"><b></b><span></span></div>
    <div class="bl panel" id="sel"><div class="hd">No selection</div><div class="rows"></div>
      <div class="forms">${FORMS.map(([f, k, l]) => `<button data-form="${f}">${l} <kbd>${k}</kbd></button>`).join('')}<button data-stop>Halt <kbd>H</kbd></button><button data-stance>Hold <kbd>G</kbd></button><button data-auto>Auto-sq <kbd>B</kbd></button><button data-refill style="display:none" title="Fresh men march in while the regiment stands on an objective you hold and is out of the fight. Paid in reserve points as they arrive."></button><button data-special class="spbtn" style="display:none"></button></div></div>
    <div class="bc" id="abil">${abilities.map((a) => {
      const ab = TUNING.abilities[a];
      return `<button class="ab" data-ab="${a}" title="${ab.label}"><span class="ico"></span><span class="nm">${ab.label}</span><kbd>${ab.key}</kbd><span class="cd"></span><i class="sweep"></i></button>`;
    }).join('')}</div>
    <div class="br">
      <div class="panel" id="res"><div class="hd">Reserves <b id="rp">0</b> pts</div>
        <div class="rbtns">${reserveTypes.map((t) => `<button data-res="${t}"><span>${TUNING.types[t].label}</span><em>${TUNING.types[t].cost}</em><u></u></button>`).join('')}</div></div>
      <canvas id="mini" width="64" height="64"></canvas>
    </div>
    <div class="intro" id="intro"><small></small><h1></h1><p></p></div>
    <div class="fade" id="fade"></div>
    <div class="result" id="result"></div>`;
  root.appendChild(hud);
  music(true);
  hud.querySelectorAll<HTMLElement>('.ab').forEach((b) => b.querySelector('.ico')!.replaceChildren(pxCanvas(ICONS[b.dataset.ab!], 2)));

  // ---------------------------------------------------------------- state helpers
  const mine = (u: any) => u.side === me && !u.dead;
  let selection: number[] = [];
  let targeting: string | null = null;
  let lastLogT = state0.t;
  let prevT = state0.t;
  const prevOwner: Record<string, number | null> = Object.fromEntries(state0.zones.map((z: any) => [z.id, z.owner]));
  const abReady: Record<string, boolean> = {};
  let ended = false;
  let raf = 0;

  // zone pips
  const pips = $(hud, '#pips');
  pips.innerHTML = state0.zones.map((z: any) => `<span class="pip" data-z="${z.id}" title="${z.name} (${z.value}/s)">${z.name}</span>`).join('');
  const paintPip = (z: any, pulse: boolean) => {
    const el = $<HTMLElement>(pips, `[data-z="${z.id}"]`);
    el.style.setProperty('--c', z.owner === 0 ? SIDE_COLOR[0] : z.owner === 1 ? SIDE_COLOR[1] : '#888');
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
  function toast(msg: string) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    $(hud, '#toasts').appendChild(el);
    animate(el, { opacity: [0, 1], translateX: [-40, 0], duration: 400, ease: 'outQuad' });
    animate(el, { opacity: 0, duration: 600, delay: 7000, ease: 'inQuad', onComplete: () => el.remove() });
  }
  function popup(e: any) {
    const el = document.createElement('div');
    el.className = `popup side${e.side}`;
    const counts: Record<string, number> = {};
    (e.types as string[]).forEach((t) => (counts[t] = (counts[t] ?? 0) + 1));
    el.innerHTML = `<b>${e.side === me ? 'Reinforcements' : 'Enemy reinforcements'}</b><span>${Object.entries(counts).map(([t, n]) => `${n}× ${TUNING.types[t].label}`).join(', ')}</span>${e.x != null ? '<small>click to view</small>' : ''}`;
    if (e.x != null) el.onclick = () => view.flyTo(e.x, e.z, undefined, 1000);
    $(hud, '#popups').appendChild(el);
    animate(el, { opacity: [0, 1], scale: [0.7, 1], translateX: [60, 0], duration: 550, ease: 'outBack(1.4)' });
    animate(el, { opacity: 0, translateX: 40, duration: 500, delay: 7000, ease: 'inQuad', onComplete: () => el.remove() });
    cue('arrive');
  }

  // animated score counters
  const disp = { s0: 0, s1: 0, tug: 50, rp: 0 };
  const lastTarget = { s0: -1, s1: -1, tug: -1, rp: -1 };
  function tweenNumbers(sc: number[], rp: number) {
    const tot = Math.max(1, sc[0] + sc[1]), tug = (sc[0] / tot) * 100;
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

  function renderSel(force = false) {
    const st = src.state;
    selection = selection.filter((id) => st.units.some((u: any) => u.id === id && !u.dead));
    view.setSelection(selection);
    const rows = $(hud, '#sel .rows'), hd = $(hud, '#sel .hd');
    hd.textContent = selection.length ? `${selection.length} selected` : 'Drag to select';
    const stB = $<HTMLElement>(hud, '[data-stance]'), auB = $<HTMLElement>(hud, '[data-auto]');
    const sel0 = selection.map((id) => st.units.find((q: any) => q.id === id)).filter(Boolean);
    stB.style.display = auB.style.display = sel0.length ? '' : 'none';
    if (sel0.length) { stB.innerHTML = `${({ hold: 'Hold', aggressive: 'Attack', skirmish: 'Skirmish' } as any)[sel0[0].stance] ?? 'Hold'} <kbd>G</kbd>`; auB.classList.toggle('on', sel0.filter((u: any) => u.type === 'line' || u.type === 'guard').every((u: any) => u.auto) && sel0.some((u: any) => u.type === 'line' || u.type === 'guard')); }
    const rfB = $<HTMLElement>(hud, '[data-refill]'), hurt = sel0.filter((u: any) => u.type !== 'commander' && u.men < u.maxMen);
    if (hurt.length) { // cost at the deploy rate: a whole regiment costs its reserve price
      const onOurs = (u: any) => st.zones.some((z: any) => z.owner === me && Math.hypot(u.x - z.x, u.z - z.z) < z.r);
      const cost = Math.ceil(hurt.reduce((a: number, u: any) => a + ((u.maxMen - u.men) * TUNING.types[u.type].cost) / u.maxMen, 0));
      rfB.style.display = ''; rfB.classList.toggle('on', hurt.every((u: any) => u.refill)); rfB.classList.toggle('off', !hurt.some(onOurs));
      rfB.innerHTML = `Replenish <kbd>N</kbd> ${cost} pts`;
    } else rfB.style.display = 'none';
    const spBtn = $<HTMLElement>(hud, '[data-special]');
    const su = selection.map((id) => st.units.find((q: any) => q.id === id)).find((u: any) => u && TUNING.specials[u.type]);
    if (su) { const sp = TUNING.specials[su.type], cd = Math.ceil(su.spReady - st.t); spBtn.style.display = ''; spBtn.classList.toggle('off', cd > 0); spBtn.innerHTML = `${sp.label} <kbd>V</kbd>${cd > 0 ? ` ${cd}s` : ''}`; } else spBtn.style.display = 'none';
    const sig = selection.join(',') + '|' + (force ? Math.random() : Math.floor(st.t * 2));
    if ((rows as any)._sig === sig) return;
    (rows as any)._sig = sig;
    rows.innerHTML = selection.slice(0, 6).map((id) => {
      const u = st.units.find((q: any) => q.id === id);
      return `<div class="srow${u.routed ? ' routed' : ''}"><span>${u.refill ? '+ ' : ''}${esc(u.name)}</span><i class="b m"><s style="width:${(u.men / u.maxMen) * 100}%"></s></i><i class="b o"><s style="width:${Math.max(0, (u.morale / u.maxMorale) * 100)}%"></s></i><em>${Math.round(u.men)}</em></div>`;
    }).join('') + (selection.length > 6 ? `<div class="srow more">+${selection.length - 6} more</div>` : '');
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
        if (g) {
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
      if (!selection.length) return;
      const st = src.state;
      const seenFoe = (u: any) => u.side !== me && !u.dead && (!st.fog || st.seen?.[me]?.includes(u.id));
      const g0 = groundOf(e);
      const foe = (g0 && unitAt(g0, seenFoe)) ?? view.pickUnit(st, e.clientX, e.clientY, seenFoe, 34); // any soldier of the formation counts, not just its centre
      if (foe) src.cmd({ c: 'attack', ids: selection, target: foe.id });
      else {
        const g = groundOf(e);
        if (g) {
          const vi = (scn.map.villages ?? []).findIndex((v: any) => v.garrison && Math.hypot(v.x - g.x, v.z - g.z) < v.r + 2);
          if (vi >= 0 && !e.shiftKey) src.cmd({ c: 'garrison', ids: selection, vid: vi }); // right-click a farm to man it
          else src.cmd({ c: 'move', ids: selection, x: g.x, z: g.z, q: e.shiftKey }); // shift-click adds a waypoint
        }
      }
    }
  };
  dom.addEventListener('pointerdown', onDown);
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  function onMove(e: PointerEvent) {
    if (rot && !view.guide) { view.cam.yaw -= (e.clientX - rot.x) * 0.006; rot.x = e.clientX; }
    if (drag && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) {
      const b = drag.box.style;
      b.display = 'block'; b.left = `${Math.min(drag.x, e.clientX)}px`; b.top = `${Math.min(drag.y, e.clientY)}px`;
      b.width = `${Math.abs(e.clientX - drag.x)}px`; b.height = `${Math.abs(e.clientY - drag.y)}px`;
    }
    if (targeting) {
      const g = view.ground(e.clientX, e.clientY);
      const r = abCfg(targeting).r ?? 8;
      if (g) view.setReticle(g.x, g.z, r, targeting === 'cavalry' ? 0x66ccff : 0xff7755);
    }
  }
  function onUp(e: PointerEvent) {
    if (e.button === 1) rot = null;
    if (e.button !== 0 || !drag) return;
    const d = drag; drag = null; d.box.style.display = 'none';
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) {
      const ids = view.unitsIn(src.state, d.x, d.y, e.clientX, e.clientY, (u) => mine(u) && !u.routed).map((u: any) => u.id);
      setSel(e.shiftKey ? [...new Set([...selection, ...ids])] : ids);
    } else {
      const g1 = groundOf(e);
      const u = (g1 && unitAt(g1, (q) => mine(q))) ?? view.pickUnit(src.state, e.clientX, e.clientY, (q) => mine(q), 34);
      if (u) setSel(e.shiftKey ? [...new Set([...selection, u.id])] : [u.id]);
      else if (!e.shiftKey) setSel([]);
    }
  }
  const wheel = (e: WheelEvent) => { e.preventDefault(); view.zoomBy(e.deltaY > 0 ? 1.15 : 0.87); };
  dom.addEventListener('wheel', wheel, { passive: false });

  const keydown = (e: KeyboardEvent) => {
    unlock();
    if (intro) { skipIntro(); return; }
    keys.add(e.code);
    if (e.code === 'Space') { e.preventDefault(); setSpeed(src.paused ? 1 : 0); }
    else if (e.code === 'KeyM') $<HTMLElement>(hud, '#mute').textContent = toggleMute() ? '🔇' : '🔊';
    else if (e.code === 'Escape') { cancelTargeting(); setSel([]); }
    else if (e.code === 'KeyH') src.cmd({ c: 'stop', ids: selection });
    else if (e.code === 'KeyV') src.cmd({ c: 'special', ids: selection });
    else if (e.code === 'KeyG') cycleStance();
    else if (e.code === 'KeyB') src.cmd({ c: 'auto', ids: selection });
    else if (e.code === 'KeyN') src.cmd({ c: 'replenish', ids: selection });
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
      FORMS.forEach(([f, k]) => { if (e.code === `Key${k}`) { src.cmd({ c: 'form', ids: selection, f }); flashBtn(`[data-form="${f}"]`); } });
      abilities.forEach((a) => { if (e.code === ABKEY[a]) startTargeting(a); });
    }
  };
  const keyup = (e: KeyboardEvent) => keys.delete(e.code);
  addEventListener('keydown', keydown); addEventListener('keyup', keyup);
  const flashBtn = (sel: string) => { const b = hud.querySelector(sel); if (b) animate(b, { scale: [0.88, 1], duration: 300, ease: 'outBack' }); };

  // buttons
  hud.querySelectorAll<HTMLElement>('[data-form]').forEach((b) => (b.onclick = () => { src.cmd({ c: 'form', ids: selection, f: b.dataset.form! }); flashBtn(`[data-form="${b.dataset.form}"]`); }));
  $<HTMLElement>(hud, '[data-stop]').onclick = () => src.cmd({ c: 'stop', ids: selection });
  $<HTMLElement>(hud, '[data-special]').onclick = () => src.cmd({ c: 'special', ids: selection });
  const cycleStance = () => { const u = src.state.units.find((q: any) => q.id === selection[0]); if (!u) return; const order = u.type === 'skirmisher' ? ['hold', 'aggressive', 'skirmish'] : ['hold', 'aggressive']; src.cmd({ c: 'stance', ids: selection, s: order[(order.indexOf(u.stance) + 1) % order.length] }); };
  $<HTMLElement>(hud, '[data-stance]').onclick = cycleStance;
  $<HTMLElement>(hud, '[data-auto]').onclick = () => src.cmd({ c: 'auto', ids: selection });
  $<HTMLElement>(hud, '[data-refill]').onclick = () => src.cmd({ c: 'replenish', ids: selection });
  hud.querySelectorAll<HTMLElement>('[data-ab]').forEach((b) => (b.onclick = () => startTargeting(b.dataset.ab!)));
  hud.querySelectorAll<HTMLElement>('[data-res]').forEach((b) => (b.onclick = () => { src.cmd({ c: 'deploy', type: b.dataset.res! }); animate(b, { scale: [0.9, 1], duration: 300, ease: 'outBack' }); }));
  const setSpeed = (s: number) => {
    if (src.mode === 'remote') return;
    if (s === 0) src.paused = true; else { src.paused = false; src.speed = s; }
    hud.querySelectorAll<HTMLElement>('[data-sp]').forEach((b) => b.classList.toggle('on', Number(b.dataset.sp) === (src.paused ? 0 : src.speed)));
  };
  hud.querySelectorAll<HTMLElement>('[data-sp]').forEach((b) => (b.onclick = () => setSpeed(Number(b.dataset.sp))));
  $<HTMLElement>(hud, '#mute').onclick = () => { $(hud, '#mute').textContent = toggleMute() ? '🔇' : '🔊'; };
  if (src.mode === 'remote') {
    hud.querySelectorAll<HTMLElement>('[data-sp]').forEach((b) => (b.style.display = 'none'));
    const leave = $<HTMLElement>(hud, '#leave');
    leave.style.display = '';
    leave.onclick = () => opts.onExit('menu'); // onExit destroys the battle, which closes the socket
  }

  // minimap
  const mini = $<HTMLCanvasElement>(hud, '#mini'), mctx = mini.getContext('2d')!;
  mini.onpointerdown = (e) => {
    const r = mini.getBoundingClientRect(), S = view.mapSize;
    view.flyTo(((e.clientX - r.left) / r.width - 0.5) * S, ((e.clientY - r.top) / r.height - 0.5) * S, undefined, 600);
  };
  function drawMini(st: any) {
    const W = mini.width, S = view.mapSize, k = W / S, c = mctx;
    const m = W / 170;
    c.fillStyle = '#1d2a1c'; c.fillRect(0, 0, W, W);
    c.strokeStyle = '#3b5a37'; c.strokeRect(0.5, 0.5, W - 1, W - 1);
    for (const r of scn.map.rivers ?? []) { c.strokeStyle = '#3d6fa8'; c.lineWidth = 1; c.beginPath(); r.pts.forEach(([x, z]: number[], i: number) => (i ? c.lineTo((x + S / 2) * k, (z + S / 2) * k) : c.moveTo((x + S / 2) * k, (z + S / 2) * k))); c.stroke(); }
    c.lineWidth = 1;
    for (const w of scn.map.woods ?? []) { c.fillStyle = '#254a27'; c.beginPath(); c.arc((w.x + S / 2) * k, (w.z + S / 2) * k, w.r * k, 0, 6.3); c.fill(); }
    for (const z of st.zones) { c.strokeStyle = z.owner === 0 ? SIDE_COLOR[0] : z.owner === 1 ? SIDE_COLOR[1] : '#bbb'; c.beginPath(); c.arc((z.x + S / 2) * k, (z.z + S / 2) * k, z.r * k, 0, 6.3); c.stroke(); }
    for (const u of st.units) { if (st.fog && u.side !== me && !st.seen?.[me]?.includes(u.id)) continue; c.fillStyle = u.routed ? '#999' : SIDE_COLOR[u.side]; c.fillRect(Math.round((u.x + S / 2) * k) - 1, Math.round((u.z + S / 2) * k) - 1, 2, 2); }
    c.strokeStyle = '#fff'; c.strokeRect(Math.round((view.cam.x + S / 2) * k - 12 * m), Math.round((view.cam.z + S / 2) * k - 9 * m), Math.round(24 * m), Math.round(18 * m));
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
    $(el, 'small').textContent = scn.date; $(el, 'p').textContent = `${scn.hint ?? ''} Victory: hold more objectives when time runs out, or break the enemy army.`;
    $(el, 'h1').innerHTML = [...scn.title].map((c: string) => `<span>${c === ' ' ? '&nbsp;' : c}</span>`).join('');
    view.cam.x = first.x; view.cam.z = first.z; view.cam.dist = 160; view.cam.yaw = 0.5;
    src.paused = true;
    intro = createTimeline({ onComplete: endIntro })
      .add('#fade', { opacity: [1, 0], duration: 1400, ease: 'inOutQuad' }, 0)
      .add(el, { opacity: [0, 1], duration: 500 }, 300)
      .add($(el, 'small'), { opacity: [0, 1], translateY: [10, 0], duration: 600 }, 400)
      .add(el.querySelectorAll('h1 span'), { opacity: [0, 1], translateY: [24, 0], rotateX: [70, 0], duration: 700, delay: stagger(45), ease: 'outBack' }, 600)
      .add($(el, 'p'), { opacity: [0, 1], duration: 700 }, 1500)
      .add(view.cam, { x: start.x, z: start.z, dist: 60, yaw: 0, duration: 3600, ease: 'inOutCubic' }, 700)
      .add(el, { opacity: 0, duration: 700, ease: 'inQuad' }, 3300);
  }
  function endIntro() {
    intro = null;
    $<HTMLElement>(hud, '#intro').style.display = 'none';
    $<HTMLElement>(hud, '#fade').style.display = 'none';
    lastLogT = src.state.t;
    if (src.mode === 'local') setSpeed(1);
  }
  function skipIntro() { const t = intro; intro = null; t?.complete(); endIntro(); view.cam.x = start.x; view.cam.z = start.z; view.cam.dist = 60; view.cam.yaw = 0; }
  if (src.mode === 'local') playIntro(); else { $<HTMLElement>(hud, '#fade').style.display = 'none'; $<HTMLElement>(hud, '#intro').style.display = 'none'; view.cam.x = start.x; view.cam.z = start.z; view.cam.dist = 60; }

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
    const title = draw ? 'DRAW' : won ? (r.decisive ? 'DECISIVE VICTORY' : 'VICTORY') : r.decisive ? 'CRUSHING DEFEAT' : 'DEFEAT';
    const next = opts.campaign ? `<button id="rcont">Continue the campaign</button>${won ? '' : '<button id="rretry" class="alt">Retry battle</button>'}` : '<button id="rmenu">Back to menu</button>';
    el.innerHTML = `<div class="card ${draw ? 'draw' : won ? 'win' : 'loss'}"><h2>${title}</h2><p>${scn.title}, ${scn.date}</p>
      <table><tr><th></th><th>${SIDE_NAME[me]} (you)</th><th>${SIDE_NAME[1 - me]}</th></tr>
      <tr><td>Score</td><td class="n" data-v="${Number(r.score[me])}">0</td><td class="n" data-v="${Number(r.score[1 - me])}">0</td></tr>
      <tr><td>Men lost</td><td class="n" data-v="${Number(r.lost[me])}">0</td><td class="n" data-v="${Number(r.lost[1 - me])}">0</td></tr></table>
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
    cue(won ? 'capture' : 'alert');
  }

  // ---------------------------------------------------------------- per-frame
  let last = performance.now(), hudAcc = 0, lastWx = '', lastClk = '';
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const st = src.state;
    if (st.t < prevT - 1) { lastLogT = st.t; ended = false; $<HTMLElement>(hud, '#result').style.display = 'none'; } // remote room restarted
    prevT = st.t;

    // camera pan
    const sp = view.cam.dist * 0.9 * dt;
    let dx = 0, dz = 0;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) dx -= sp;
    if (keys.has('KeyD') || keys.has('ArrowRight')) dx += sp;
    if (keys.has('KeyW') || keys.has('ArrowUp')) dz -= sp;
    if (keys.has('KeyS') || keys.has('ArrowDown')) dz += sp;
    if (!view.guide && keys.has('KeyQ')) view.cam.yaw += dt * 1.2;
    if (!view.guide && keys.has('KeyE')) view.cam.yaw -= dt * 1.2;
    if (dx || dz) view.pan(dx, dz);

    src.update(dt);
    const evs = src.drainEvents();
    view.sync(st, dt, me, evs);
    playEvents(evs, view.cam.x, view.cam.z);
    view.render();

    for (const e of evs) {
      if (e.k === 'arrive') { popup(e); say(e.side === me ? 'Reinforcements have arrived, sir.' : 'Enemy reinforcements spotted.', 1); }
      else if (e.k === 'aid') aidCue(e);
      else if (e.k === 'flank' && e.side === me) say(e.kind === 2 ? 'They are in our rear!' : 'We are being flanked!', 1);
      else if (e.k === 'rank' && e.side === me) say(`${e.name} has earned its stripes.`);
      else if (e.k === 'rout') say(e.side === me ? `${e.name} is breaking, sir!` : 'Enemy regiment is routing!', 1);
      else if (e.k === 'dead') say(e.side === me ? `We have lost ${e.name}.` : 'Enemy regiment destroyed!', 1);
      else if (e.k === 'special' && e.side === me) say(({ volley: 'Present! Fire!', sprint: 'Skirmishers, advance!', charge: 'Charge!', canister: 'Load canister!', rally: 'Rally to me!' } as any)[e.kind] ?? 'Yes sir!');
      else if (e.k === 'shot' && e.side !== me && st.t - lastContact > 40 && Math.hypot(e.x - view.cam.x, e.z - view.cam.z) < 70) { lastContact = st.t; say('Contact! Enemy in range.'); }
      else if (e.k === 'weather') banner(TUNING.weather[e.w].label, 'The weather turns', '#9fb4d0');
    }
    // new log lines -> toasts (zone captures get their own banner)
    for (const l of st.log) if (l.t > lastLogT) { if (!/ is taken by /.test(l.msg)) toast(l.msg); }
    if (st.log.length) lastLogT = Math.max(lastLogT, st.log[st.log.length - 1].t);

    for (const z of st.zones) {
      if (z.owner !== prevOwner[z.id]) {
        prevOwner[z.id] = z.owner;
        paintPip(z, true);
        if (z.owner != null) say(z.owner === me ? `${z.name} is ours, sir.` : `We have lost ${z.name}!`, 1);
        if (z.owner != null) { banner(`${z.name} captured`, `${SIDE_NAME[z.owner]} · +${z.value}/s`, SIDE_COLOR[z.owner]); cue(z.owner === me ? 'capture' : 'alert'); }
      }
    }

    // HUD refresh at ~8 Hz
    hudAcc += dt;
    if (hudAcc > 0.12) {
      hudAcc = 0;
      renderSel();
      const sd = st.side[me];
      tweenNumbers([st.side[0].score, st.side[1].score], sd.rp);
      const hr = parseInt(scn.clock.start) + (st.t / scn.duration) * scn.clock.hours;
      const clk = `${pad(hr)}:${pad((hr % 1) * 60)}`;
      if (clk !== lastClk) { $(hud, '#clk').textContent = clk; lastClk = clk; }
      if (st.weather !== lastWx) { $(hud, '#wx').textContent = TUNING.weather[st.weather].label; lastWx = st.weather; }
      const rem = Math.max(0, scn.duration - st.t);
      $(hud, '#left').textContent = `${Math.floor(rem / 60)}:${pad(rem % 60)} left`;
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
    }
    if (st.over && !ended) showResult(st);
  }
  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      cancelAnimationFrame(raf); music(false);
      removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp);
      removeEventListener('keydown', keydown); removeEventListener('keyup', keyup);
      dom.removeEventListener('wheel', wheel); dom.removeEventListener('pointerdown', onDown); dom.removeEventListener('contextmenu', onCtx);
      dom.style.cursor = '';
      hud.remove(); box.remove();
      view.setSelection([]);
      view.setReticle(null);
      src.close();
    },
  };
}
