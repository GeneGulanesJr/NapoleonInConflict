import './style.css';
import { animate, createTimeline, stagger } from 'animejs';
import { createView } from './render.ts';
import { runBattle, type Outcome } from './battle.ts';
import { localSource, remoteSource } from './game.ts';
import { unlock } from './audio.ts';
import {
  CAMPAIGN, SCENARIOS, TUNING, newCampaign, load, save, clearSave, applyResult, freshRoster, wonMap, fogOn, setFog, EXTRA_BATTLES, makeSkirmish, type CampaignState,
} from './campaign.ts';

const app = document.getElementById('app')!;
const viewHost = document.getElementById('view')!;
const menu = document.getElementById('menu')!;
const view = createView(viewHost);
let battle: { destroy(): void } | null = null;

// idle backdrop: slowly orbiting battlefield behind the menus
let backdrop = 0;
function startBackdrop() {
  view.setScenario(SCENARIOS.waterloo, TUNING);
  view.cam.dist = 130; view.cam.x = 0; view.cam.z = 0;
  const idle = { sync: { t: 0, units: [], zones: SCENARIOS.waterloo.zones, smoke: [], fx: [], weather: 'clear' } };
  let last = performance.now();
  const loop = (n: number) => {
    backdrop = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (n - last) / 1000); last = n;
    view.cam.yaw += dt * 0.05;
    view.sync(idle.sync, dt, 0, []);
    view.render();
  };
  backdrop = requestAnimationFrame(loop);
}
const stopBackdrop = () => cancelAnimationFrame(backdrop);

function screen(html: string, bind: (el: HTMLElement) => void) {
  menu.style.display = 'flex';
  menu.innerHTML = `<div class="screen">${html}</div>`;
  const el = menu.firstElementChild as HTMLElement;
  bind(el);
  createTimeline()
    .add(el, { opacity: [0, 1], translateY: [20, 0], duration: 500, ease: 'outQuad' })
    .add(el.querySelectorAll('.stag'), { opacity: [0, 1], translateX: [-24, 0], duration: 450, delay: stagger(70), ease: 'outQuad' }, 150);
}
const hideMenu = () => { menu.style.display = 'none'; menu.innerHTML = ''; };

// ------------------------------------------------------------------ title
function title() {
  const saved = load();
  screen(`
    <h1 class="logo">NAPOLEON <em>IN CONFLICT</em></h1>
    <p class="sub stag">The Waterloo Campaign — June 1815</p>
    <div class="btns">
      <button class="stag" id="new">New Campaign</button>
      ${saved ? `<button class="stag" id="cont">Continue Campaign <small>(battle ${Math.min(saved.idx + 1, 5)} of 5)</small></button>` : ''}
      <button class="stag alt" id="quick">Quick Battle</button>
      <button class="stag alt" id="mp">Multiplayer</button>
      <button class="stag alt" id="fog">Fog of war: ${fogOn() ? 'ON' : 'OFF'}</button>
    </div>
    <p class="help stag">Left-click / drag: select · Right-click: move or attack · WASD: pan · Q/E or middle-drag: rotate · Wheel: zoom · P: render quality · V: unit special · R: radio · T: dusk · Y/U: silhouette / top-down check<br>
    Z/X/C: line/column/square · B: auto-square · N: replenish (on a held objective) · G: stance · H: halt · Shift+right-click: waypoint · right-click a farm: garrison · 1/2/3: tactical aid · Space: pause · F: focus selection · M: mute</p>`, (el) => {
    el.querySelector<HTMLElement>('#new')!.onclick = () => { unlock(); clearSave(); const c = newCampaign(); save(c); campaignScreen(c); };
    el.querySelector<HTMLElement>('#cont')?.addEventListener('click', () => { unlock(); campaignScreen(saved!); });
    el.querySelector<HTMLElement>('#quick')!.onclick = () => { unlock(); quickScreen(); };
    el.querySelector<HTMLElement>('#mp')!.onclick = () => { unlock(); mpScreen(); };
    el.querySelector<HTMLElement>('#fog')!.onclick = (e) => { setFog(!fogOn()); (e.currentTarget as HTMLElement).textContent = `Fog of war: ${fogOn() ? 'ON' : 'OFF'}`; };
  });
}

// ------------------------------------------------------------------ campaign
const ROUTE: Record<string, [number, number]> = { charleroi: [46, 88], quatrebras: [36, 50], ligny: [66, 58], genappe: [38, 30], waterloo: [46, 10] };
/** Little pixel map of the campaign: the route Charleroi to Waterloo, with the current battle pulsing. */
function routeMap(c: CampaignState) {
  const pts = CAMPAIGN.battles.map((b: string) => ROUTE[b] ?? [50, 50]);
  const dots = CAMPAIGN.battles.map((b: string, i: number) => {
    const [x, y] = pts[i], cls = i < c.idx ? 'done' : i === c.idx ? 'now' : 'lock';
    return `<rect class="dot ${cls}" x="${x - 3}" y="${y - 3}" width="6" height="6"/><text x="${x + 6}" y="${y + 2}" class="lbl ${cls}">${SCENARIOS[b].title}</text>`;
  }).join('');
  return `<svg class="cmap stag" viewBox="0 0 100 100" shape-rendering="crispEdges"><polyline points="${pts.map((p: number[]) => p.join(',')).join(' ')}" class="route"/>${dots}</svg>`;
}
function campaignScreen(c: CampaignState) {
  if (c.ended) return endingScreen(c);
  const id = CAMPAIGN.battles[c.idx], scn = SCENARIOS[id];
  const byType: Record<string, { n: number; men: number; max: number }> = {};
  for (const u of c.roster) { const b = (byType[u.type] ??= { n: 0, men: 0, max: 0 }); b.n++; b.men += u.men; b.max += u.maxMen; }
  const total = c.roster.reduce((a, u) => a + u.men, 0), totalMax = Object.keys(CAMPAIGN.roster).reduce((a, t) => a + CAMPAIGN.roster[t].length * TUNING.types[t].men, 0);
  const mark: Record<string, string> = { win: '✔', draw: '≈', loss: '✘' };
  screen(`
    <h2 class="stag">${CAMPAIGN.title}</h2>
    <p class="sub stag">${CAMPAIGN.subtitle}</p>
    ${c.idx === 0 ? `<p class="intro-text stag">${CAMPAIGN.intro}</p>` : ''}
    <div class="cols">
      <div class="col">
        ${routeMap(c)}
        ${CAMPAIGN.battles.map((b: string, i: number) => `<div class="bcard stag ${i === c.idx ? 'now' : i < c.idx ? 'done' : 'lock'}"><b>${i < c.idx ? mark[c.results[b]] : i + 1}</b><span>${SCENARIOS[b].title}</span><small>${SCENARIOS[b].date}</small></div>`).join('')}
      </div>
      <div class="col wide">
        <div class="brief stag"><h3>${scn.title} <small>${scn.date}</small></h3><p>${scn.blurb}</p><p class="hint">${scn.hint}</p><p class="hint">Victory: hold more objectives when time runs out (60% of the verdict, the rest is points banked), or break the enemy army.</p></div>
        <div class="roster stag"><h4>Your army: ${Math.round((total / totalMax) * 100)}% strength <small>(${c.roster.length} regiments)</small></h4>
          ${Object.entries(byType).map(([t, b]) => `<div class="rrow"><span>${TUNING.types[t].label} ×${b.n}</span><i><s data-w="${(b.men / b.max) * 100}"></s></i></div>`).join('')}
          <small>Losses carry over to the next battle; rest restores ${Math.round(CAMPAIGN.healFraction * 100)}% of the missing men.</small></div>
        <div class="btns row"><button id="go" class="stag">Begin battle</button><button id="back" class="stag alt">Main menu</button></div>
      </div>
    </div>`, (el) => {
    el.querySelectorAll<HTMLElement>('.rrow s').forEach((s, i) => animate(s, { width: ['0%', `${s.dataset.w}%`], duration: 900, delay: 400 + i * 80, ease: 'outExpo' }));
    el.querySelector<HTMLElement>('#go')!.onclick = () => startCampaignBattle(c);
    el.querySelector<HTMLElement>('#back')!.onclick = title;
  });
}

function fadeOutMenu(done: () => void) {
  animate(menu, { opacity: 0, duration: 400, ease: 'inQuad', onComplete: () => { hideMenu(); menu.style.opacity = ''; done(); } });
}
function enterBattle(src: any, scn: any, campaign: boolean, onExit: (o: Outcome) => void) {
  stopBackdrop();
  app.classList.add('inbattle');
  battle = runBattle(app, view, src, scn, { campaign, onExit: (o) => { battle?.destroy(); battle = null; app.classList.remove('inbattle'); startBackdrop(); onExit(o); } });
}

function startCampaignBattle(c: CampaignState) {
  const id = CAMPAIGN.battles[c.idx], scn = SCENARIOS[id];
  fadeOutMenu(() => {
    const src = localSource(scn, { roster: c.roster, won: wonMap(c) });
    enterBattle(src, scn, true, (o) => {
      if (o === 'retry') return startCampaignBattle(c);
      const next = applyResult(c, id, src.state);
      save(next);
      campaignScreen(next);
    });
  });
}

function endingScreen(c: CampaignState) {
  const text = CAMPAIGN.endings[c.ended!];
  const won = c.ended!.endsWith('win');
  screen(`<h1 class="logo ${won ? '' : 'sad'}">${won ? 'VICTORY AT WATERLOO' : c.ended!.endsWith('draw') ? 'THE FIELD IS HELD' : 'WATERLOO'}</h1>
    <p class="intro-text stag">${text}</p>
    <div class="rrow stag"><span>Results</span><span>${CAMPAIGN.battles.map((b: string) => `${SCENARIOS[b].title}: ${c.results[b] ?? '-'}`).join(' · ')}</span></div>
    <div class="btns"><button id="again" class="stag">New campaign</button><button id="menu" class="stag alt">Main menu</button></div>`, (el) => {
    el.querySelector<HTMLElement>('#again')!.onclick = () => { clearSave(); const n = newCampaign(); save(n); campaignScreen(n); };
    el.querySelector<HTMLElement>('#menu')!.onclick = () => { clearSave(); title(); };
  });
}

// ------------------------------------------------------------------ quick battle (no campaign effects)
function quickScreen() {
  screen(`<h2 class="stag">Quick Battle</h2><p class="sub stag">Fresh full-strength army. Nothing is saved.</p>
    <div class="btns">${CAMPAIGN.battles.map((b: string) => `<button class="stag" data-b="${b}">${SCENARIOS[b].title} <small>${SCENARIOS[b].date}</small></button>`).join('')}
    ${EXTRA_BATTLES.map((b: string) => `<button class="stag alt" data-b="${b}">${SCENARIOS[b].title} <small>${SCENARIOS[b].date}</small></button>`).join('')}
    <button class="stag alt" id="rnd">Random skirmish <small>new map every time</small></button>
    <button class="stag alt" id="back">Back</button></div>`, (el) => {
    el.querySelector<HTMLElement>('#rnd')!.onclick = () => {
      const scn = makeSkirmish(Date.now() & 0x7fffffff);
      fadeOutMenu(() => { const src = localSource(scn, { roster: freshRoster() }); enterBattle(src, scn, false, () => quickScreen()); });
    };
    el.querySelectorAll<HTMLElement>('[data-b]').forEach((b) => (b.onclick = () => {
      const scn = SCENARIOS[b.dataset.b!];
      fadeOutMenu(() => {
        const src = localSource(scn, { roster: freshRoster() });
        enterBattle(src, scn, false, () => quickScreen());
      });
    }));
    el.querySelector<HTMLElement>('#back')!.onclick = title;
  });
}

// ------------------------------------------------------------------ multiplayer
function mpScreen(msg = '') {
  const host = location.hostname || 'localhost';
  screen(`<h2 class="stag">Multiplayer</h2>
    <p class="sub stag">Team vs team on one battlefield. Run <code>npm run server</code> first. Players are split across the French and Coalition; an empty side is played by a bot.</p>
    <div class="form stag"><label>Server <input id="url" value="ws://${host}:8080"></label>
    <label>Battle <select id="sc">${CAMPAIGN.battles.map((b: string) => `<option value="${b}" ${b === 'waterloo' ? 'selected' : ''}>${SCENARIOS[b].title}</option>`).join('')}</select></label></div>
    <p class="err stag" id="err">${msg}</p>
    <div class="btns"><button id="join" class="stag">Join</button><button id="back" class="stag alt">Back</button></div>`, (el) => {
    el.querySelector<HTMLElement>('#back')!.onclick = title;
    el.querySelector<HTMLElement>('#join')!.onclick = async () => {
      const url = (el.querySelector('#url') as HTMLInputElement).value.trim();
      const id = (el.querySelector('#sc') as HTMLSelectElement).value;
      el.querySelector('#err')!.textContent = 'Connecting…';
      try {
        const src = await remoteSource(url, id);
        fadeOutMenu(() => enterBattle(src, SCENARIOS[id], false, () => mpScreen()));
      } catch (e) { el.querySelector('#err')!.textContent = (e as Error).message; }
    };
  });
}

startBackdrop();
title();
