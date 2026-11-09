// Documentary renderer: one chapter at a time, frame by frame. scripts/film.ts resolves the chapter spec (src/data/lodi-film.json) against the narration timings,
// calls __doc.chapter(c) once, then __doc.frame(u) for every video frame (u = seconds into the chapter) and takes a screenshot of each.
// The battle is the directed one (scripted orders, src/data/lodi-orders.json); the camera follows keyframes and the cards come from the spec.
import { createView } from './render.ts';
import { SCENARIOS, TUNING } from './campaign.ts';
import { createSim, step } from './sim/sim.ts';
import { DT } from './sim/replay.ts';
import { directed } from './sim/orders.ts';
import { offline, at, playEvents, renderOffline } from './audio.ts';
import ORDERS from './data/lodi-orders.json';

type Key = { u: number; x: number; z: number; dist: number; yaw: number; tilt: number; cut?: boolean };
type Card = { u0: number; u1: number; kind: string; text: string; sub?: string };
type Chapter = { idx: number; last?: boolean; dur: number; fps: number; sim: [number, number]; keys: Key[]; cards: Card[]; end?: string };

const q = new URLSearchParams(location.search);
const view = createView(document.getElementById('view')!, { crowd: Number(q.get('crowd') ?? 2.2), smoke: Number(q.get('smoke') ?? 0.7) });
const $ = (id: string) => document.getElementById(id)!, clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
let g: any, run: () => void, ch: Chapter, els: HTMLElement[] = [], fi = 0;

const html = (c: Card) => c.kind === 'title' ? `${c.text}<small>${c.sub ?? ''}</small>` : c.kind === 'quote' ? `“${c.text}”<small>${c.sub ?? ''}</small>` : c.kind === 'source' ? `<b>${c.sub ?? 'SOURCES DISAGREE'}</b>${c.text}` : c.text;

(window as any).__doc = {
  chapter(c: Chapter) {
    ch = c; fi = 0;
    const scn = SCENARIOS.lodi;
    view.setScenario(scn, TUNING); // fresh men and ground each chapter, so nothing slides in from the last one
    g = createSim(scn, TUNING, { seed: 1 }); run = directed(g, ORDERS as any, { lock: true }); // the sim is the stage: movement, firing and falling men are its own, the outcome is the script's
    while (g.s.t < c.sim[0] && !g.s.over) { step(g, DT); run(); } // the part before this chapter's footage: sim only
    g.s.events.length = 0;
    $('cards').innerHTML = ''; els = c.cards.map((k) => { const e = document.createElement('div'); e.className = `card ${k.kind}`; e.innerHTML = html(k); $('cards').appendChild(e); return e; });
    $('end').style.display = c.end ? 'flex' : 'none'; if (c.end) $('endtext').innerHTML = c.end; $('rec').style.display = c.end ? 'none' : '';
    offline(c.dur + 1, 'fr'); // sound effects only; the music tick is never called
    view.cam.x = c.keys[0].x; view.cam.z = c.keys[0].z; view.cam.dist = c.keys[0].dist; view.cam.yaw = c.keys[0].yaw; view.tilt.v = c.keys[0].tilt;
    view.sync(g.s, 0, 0, []); view.render();
  },
  frame(u: number) {
    const evs: any[] = [];
    if (!ch.end) {
      const target = ch.sim[0] + (ch.sim[1] - ch.sim[0]) * clamp(u / ch.dur);
      while (g.s.t < target && !g.s.over) { step(g, DT); run(); evs.push(...g.s.events.splice(0)); }
      const ks = ch.keys; let i = 0; while (i + 1 < ks.length && ks[i + 1].u <= u) i++;
      const a = ks[i], b = ks[Math.min(i + 1, ks.length - 1)];
      let s = b.cut || b.u <= a.u ? 0 : clamp((u - a.u) / (b.u - a.u)); s = s * s * (3 - 2 * s); // smoothstep; a cut holds until its time
      const L = (p: number, r: number) => p + (r - p) * s;
      view.cam.x = L(a.x, b.x); view.cam.z = L(a.z, b.z); view.cam.dist = L(a.dist, b.dist); view.tilt.v = L(a.tilt, b.tilt);
      view.cam.yaw = a.yaw + Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw)) * s;
      at(u); playEvents(evs, view.cam.x, view.cam.z);
      view.sync(g.s, 1 / ch.fps, 0, evs); view.render();
    }
    ch.cards.forEach((k, j) => { els[j].style.opacity = String(k.kind === 'tag' ? 0.9 : clamp(Math.min((u - k.u0) / 0.5, (k.u1 - u) / 0.5))); });
    const fin = ch.idx === 0 ? 1.5 : 0.4, fout = ch.end || ch.last ? 1.5 : 0.4; // dip to black at each chapter's ends, slower at the very start and end
    $('fade').style.opacity = String(Math.max(0, 1 - u / fin, 1 - (ch.dur - u) / fout));
    fi++;
  },
  /** the chapter's sound effects as a 16-bit stereo WAV, base64 */
  async audio(): Promise<string> {
    const b = await renderOffline(), n = Math.min(b.length, Math.ceil(ch.dur * b.sampleRate)), L = b.getChannelData(0), R = b.getChannelData(1);
    const w = new DataView(new ArrayBuffer(44 + n * 4)), s = (p: number, t: string) => [...t].forEach((c, i) => w.setUint8(p + i, c.charCodeAt(0)));
    s(0, 'RIFF'); w.setUint32(4, 36 + n * 4, true); s(8, 'WAVEfmt '); w.setUint32(16, 16, true); w.setUint16(20, 1, true); w.setUint16(22, 2, true);
    w.setUint32(24, b.sampleRate, true); w.setUint32(28, b.sampleRate * 4, true); w.setUint16(32, 4, true); w.setUint16(34, 16, true); s(36, 'data'); w.setUint32(40, n * 4, true);
    const c16 = (x: number) => Math.round(clamp(x, -1, 1) * 32767);
    for (let i = 0; i < n; i++) { w.setInt16(44 + i * 4, c16(L[i]), true); w.setInt16(46 + i * 4, c16(R[i]), true); }
    let bin = ''; const u8 = new Uint8Array(w.buffer); for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(bin);
  },
};
(window as any).__docReady = true;
