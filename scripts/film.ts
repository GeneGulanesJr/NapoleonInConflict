// Renders the documentary: 16:9, one chapter at a time (out/film/ch<N>.mp4 + ch<N>.wav, so a run can be resumed), then joins them and mixes the narration over the sound effects.
// Usage: node scripts/film.ts [--chapters 0,1,5] [--force] [--fps 24] [--w 1920] [--h 1080] [--out out/lodi-documentary.mp4]
//        node scripts/film.ts --still <chapter> <seconds[,seconds...]>     (one PNG in out/film/, to check a shot)
// Needs out/narration/lodi-narration.json and .mp3 (scripts/narrate.ts) and Chrome or Edge. The chapter spec is src/data/lodi-film.json.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import ffmpeg from 'ffmpeg-static';

const f: Record<string, string> = {}, av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) if (av[i].startsWith('--')) f[av[i].slice(2)] = av[i + 1]?.startsWith('--') || av[i + 1] == null ? 'true' : av[++i];
const fps = Number(f.fps ?? 24), W = Number(f.w ?? 1920), H = Number(f.h ?? 1080), FF = ffmpeg as unknown as string;
const spec = JSON.parse(readFileSync('src/data/lodi-film.json', 'utf8')), man = JSON.parse(readFileSync('out/narration/lodi-narration.json', 'utf8'));
const out = f.out ?? 'out/lodi-documentary.mp4', dir = 'out/film';
mkdirSync(dir, { recursive: true });
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

// chapter start/length on the narration clock (the opening gets `lead` seconds of quiet before the voice; the last chapter a `tail` after it)
const starts: number[] = spec.chapters.map((_: any, i: number) => (i === 0 ? 0 : man.chapters[i].start + spec.lead));
const durs: number[] = spec.chapters.map((_: any, i: number) => (i < spec.chapters.length - 1 ? starts[i + 1] : man.seconds + spec.lead + spec.tail) - starts[i]);
const when = (i: number, t: any): number => t.u ?? man.chapters[i].paras[t.p].start + spec.lead + (t.off ?? 0) - starts[i];
function chapterFor(i: number) {
  if (i === spec.chapters.length) return { idx: i, dur: spec.endDur, fps, sim: [470, 470], keys: [{ u: 0, x: 0, z: 0, dist: 200, yaw: 0, tilt: 0.6 }], cards: [], end: spec.end };
  const c = spec.chapters[i];
  const keys = c.keys.map((k: any) => ({ ...k, u: when(i, k) })).sort((a: any, b: any) => a.u - b.u);
  const cards = c.cards.map((k: any) => { const u0 = when(i, k); return { u0, u1: u0 + k.dur, kind: k.kind, text: k.text, sub: k.sub }; });
  if (i > 0) cards.push({ u0: 0.5, u1: 5, kind: 'chapter', text: `${ROMAN[i]} · ${c.title}` });
  return { idx: i, last: i === spec.chapters.length - 1, dur: durs[i], fps, sim: c.sim, keys, cards };
}

const chrome = process.env.CHROME ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!chrome) throw new Error('no Chrome/Edge found: set CHROME to its path');
const server = await createServer({ server: { port: 5197 }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page:', e));
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.goto('http://localhost:5197/doc.html?crowd=2.2&smoke=0.7');
  await page.waitForFunction('window.__docReady', { timeout: 90000 });
  const total = spec.chapters.length + 1;

  if (f.still != null) { // one shot, to check the camera and the cards
    const ci = Number(av[av.indexOf('--still') + 1]), us = String(av[av.indexOf('--still') + 2]).split(',').map(Number); // several moments in one chapter, in increasing order
    await page.evaluate((c) => (window as any).__doc.chapter(c), chapterFor(ci) as any);
    for (const u of us) { await page.evaluate((t) => (window as any).__doc.frame(t), u); const file = `${dir}/still-${ci}-${u}.png`; await page.screenshot({ path: file }); console.log(file); }
  } else {
    const only = f.chapters ? f.chapters.split(',').map(Number) : null;
    for (let i = 0; i < total; i++) {
      if (only && !only.includes(i)) continue;
      const vid = `${dir}/ch${i}.mp4`, wav = `${dir}/ch${i}.wav`;
      if (existsSync(vid) && existsSync(wav) && f.force !== 'true') { console.log(`chapter ${i}: already rendered`); continue; }
      const c = chapterFor(i), frames = Math.ceil(c.dur * fps), t0 = Date.now();
      await page.evaluate((cc) => (window as any).__doc.chapter(cc), c as any);
      const ff = spawn(FF, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-', '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-pix_fmt', 'yuv420p', `${vid}.tmp.mp4`], { stdio: ['pipe', 'inherit', 'inherit'] });
      const done = new Promise<number>((r) => ff.on('close', r));
      for (let n = 0; n < frames; n++) {
        await page.evaluate((t) => (window as any).__doc.frame(t), n / fps);
        const jpg = await page.screenshot({ type: 'jpeg', quality: 92 }) as Uint8Array;
        if (!ff.stdin!.write(jpg)) await new Promise((r) => ff.stdin!.once('drain', r));
        if (n % 240 === 239) console.log(`chapter ${i}: ${n + 1}/${frames} frames`);
      }
      ff.stdin!.end();
      if ((await done) !== 0) throw new Error(`ffmpeg failed on chapter ${i}`);
      writeFileSync(wav, Buffer.from(await page.evaluate(() => (window as any).__doc.audio()), 'base64'));
      spawnSync(FF, ['-y', '-loglevel', 'error', '-i', `${vid}.tmp.mp4`, '-c', 'copy', vid]); rmSync(`${vid}.tmp.mp4`);
      console.log(`chapter ${i} (${c.dur.toFixed(1)} s) done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    }
    if (!only) { // all chapters rendered: join them and mix the narration over the sound effects
      const vlist = `${dir}/videos.txt`, alist = `${dir}/sfx.txt`;
      writeFileSync(vlist, Array.from({ length: total }, (_, i) => `file 'ch${i}.mp4'`).join('\n')); writeFileSync(alist, Array.from({ length: total }, (_, i) => `file 'ch${i}.wav'`).join('\n'));
      spawnSync(FF, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', vlist, '-c', 'copy', `${dir}/all.mp4`], { stdio: 'inherit' });
      spawnSync(FF, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', alist, '-c', 'copy', `${dir}/sfx.wav`], { stdio: 'inherit' });
      const ms = Math.round(spec.lead * 1000);
      const r = spawnSync(FF, ['-y', '-loglevel', 'error', '-i', `${dir}/all.mp4`, '-i', `${dir}/sfx.wav`, '-i', 'out/narration/lodi-narration.mp3', '-filter_complex',
        `[1:a]volume=0.3[a1];[2:a]adelay=${ms}|${ms},volume=1.0[a2];[a1][a2]amix=inputs=2:normalize=0:duration=longest[x];[x]loudnorm=I=-16:TP=-1.5:LRA=11[a]`,
        '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', out], { stdio: 'inherit' });
      console.log(r.status === 0 ? `done: ${out}` : 'the final mix failed');
    }
  }
} finally {
  await browser.close(); await server.close();
}
