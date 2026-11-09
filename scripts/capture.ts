// Renders a Short: opens capture.html in headless Chrome, steps the battle one video frame at a time, pipes screenshots into ffmpeg.
// Usage: node scripts/capture.ts <scenario> <seed> <from> <to> [out.mp4] [--title "..."] [--sub "..."] [--x N --z N] [--speed 2] [--dist 110] [--fps 30] [--w 1080 --h 1920]
// Take scenario/seed/from/to/x/z straight from scripts/moments.ts output. Needs Chrome or Edge installed (CHROME env var to override).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import ffmpeg from 'ffmpeg-static';

const pos: string[] = [], f: Record<string, string> = {};
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) av[i].startsWith('--') ? (f[av[i].slice(2)] = av[++i]) : pos.push(av[i]);
const [scn, seed, from, to, out = `short-${scn}-${seed}-${from}.mp4`] = pos;
if (!scn || !to) throw new Error('usage: node scripts/capture.ts <scenario> <seed> <from> <to> [out.mp4] [--title ..] [--sub ..] [--x N --z N] [--speed 2] [--dist 110] [--fps 30]');
const fps = Number(f.fps ?? 30), W = Number(f.w ?? 1080), H = Number(f.h ?? 1920), speed = Number(f.speed ?? 2);
const chrome = process.env.CHROME ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!chrome) throw new Error('no Chrome/Edge found: set CHROME to its path');

const server = await createServer({ server: { port: 5199 }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] }); // swiftshader = software WebGL fallback if there is no GPU
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page:', e));
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.goto('http://localhost:5199/capture.html');
  await page.waitForFunction('window.__cineReady', { timeout: 60000 });
  const x = f.x == null ? 0 : Number(f.x), z = f.z == null ? 0 : Number(f.z);
  await page.evaluate((o) => (window as any).__cine.init(o), { scn, seed: Number(seed), from: Number(from), to: Number(to), fps, speed, x, z, dist: Number(f.dist ?? 110), title: f.title, sub: f.sub });

  const ff = spawn(ffmpeg as unknown as string, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise<number>((r) => ff.on('close', r));
  let n = 0;
  while (await page.evaluate(() => (window as any).__cine.frame())) {
    const png = await page.screenshot({ type: 'jpeg', quality: 95 }) as Uint8Array;
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
    if (++n % 30 === 0) console.log(`${n} frames (${(n / fps).toFixed(1)}s)`);
  }
  ff.stdin.end();
  console.log(`ffmpeg exit ${await done}: ${out} (${n} frames, ${(n / fps).toFixed(1)}s)`);
} finally {
  await browser.close(); await server.close();
}
