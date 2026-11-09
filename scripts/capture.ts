// Renders a Short: opens capture.html in headless Chrome, steps the battle one video frame at a time, pipes screenshots into ffmpeg.
// Usage: node scripts/capture.ts <scenario> <seed> <from> <to> [out.mp4] [--title "..."] [--sub "..."] [--x N --z N] [--speed 2] [--dist 110] [--fps 30] [--music fr|gb|off] [--narrate 1] [--crowd 2.2] [--max 58] [--w 1080 --h 1920]
// Take scenario/seed/from/to/x/z straight from scripts/moments.ts output. Needs Chrome or Edge installed (CHROME env var to override).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import ffmpeg from 'ffmpeg-static';

const pos: string[] = [], f: Record<string, string> = {};
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) av[i].startsWith('--') ? (f[av[i].slice(2)] = av[++i]) : pos.push(av[i]);
const [scn, seed, from, to, out = `short-${scn}-${seed}-${from}.mp4`] = pos;
if (!scn || !to) throw new Error('usage: node scripts/capture.ts <scenario> <seed> <from> <to> [out.mp4] [--title ..] [--sub ..] [--x N --z N] [--speed 2] [--dist 110] [--fps 30]');
const music = f.music ?? 'fr'; // fr | gb | off
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
  await page.goto(`http://localhost:5199/capture.html?crowd=${f.crowd ?? 2.2}`); // crowd: men shown per sim man in the line and guard (the game shows 1.4)
  await page.waitForFunction('window.__cineReady', { timeout: 60000 });
  const x = f.x == null ? 0 : Number(f.x), z = f.z == null ? 0 : Number(f.z);
  await page.evaluate((o) => (window as any).__cine.init(o), { scn, seed: Number(seed), from: Number(from), to: Number(to), fps, speed, x, z, dist: Number(f.dist ?? 110), title: f.title, sub: f.sub, music, maxSec: Number(f.max ?? 58) });

  const narrate = f.narrate === 'true' || f.narrate === '1'; // read the story captions aloud (Windows speech synthesis), at their times
  const silent = music === 'off' && !narrate, vid = silent ? out : `${out}.video.mp4`, wav = `${out}.wav`;
  const run = (args: string[], stdio: any = 'inherit') => spawn(ffmpeg as unknown as string, ['-y', '-loglevel', 'error', ...args], { stdio });
  const ff = run(['-f', 'image2pipe', '-framerate', String(fps), '-i', '-', '-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', vid], ['pipe', 'inherit', 'inherit']);
  const done = new Promise<number>((r) => ff.on('close', r));
  let n = 0;
  while (await page.evaluate(() => (window as any).__cine.frame())) {
    const png = await page.screenshot({ type: 'jpeg', quality: 95 }) as Uint8Array;
    if (!ff.stdin!.write(png)) await new Promise((r) => ff.stdin!.once('drain', r));
    if (++n % 30 === 0) console.log(`${n} frames (${(n / fps).toFixed(1)}s)`);
  }
  ff.stdin!.end();
  let code = await done;
  if (!silent && code === 0) { // the soundtrack was rendered offline on the same clock as the frames: mux it in (with the narration, if asked)
    const inputs = ['-i', vid], tmp: string[] = [], chain: string[] = [], mix: string[] = [];
    if (music !== 'off') { writeFileSync(wav, Buffer.from(await page.evaluate(() => (window as any).__cine.audio()), 'base64')); inputs.push('-i', wav); tmp.push(wav); chain.push(`[1:a]volume=${narrate ? 0.5 : 1}[m]`); mix.push('[m]'); }
    const lines: { t: number; text: string }[] = narrate ? await page.evaluate(() => (window as any).__cine.shown()) : [];
    if (lines.length && process.platform === 'win32') {
      const jf = `${out}.lines.txt`; writeFileSync(jf, lines.map((l) => l.text.replace(/\s+/g, ' ')).join('\n')); // one caption per line (PowerShell 5.1 wraps a JSON array into a single object)
      const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 0; $l = @(Get-Content -Encoding utf8 '${jf}'); for ($i = 0; $i -lt $l.Count; $i++) { $s.SetOutputToWaveFile('${out}.n' + $i + '.wav'); $s.Speak($l[$i]) }; $s.Dispose()`;
      const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
      tmp.push(jf);
      if (r.status === 0) lines.forEach((l, i) => { const w = `${out}.n${i}.wav`, k = inputs.length / 2; inputs.push('-i', w); tmp.push(w); chain.push(`[${k}:a]adelay=${Math.round(l.t * 1000)}|${Math.round(l.t * 1000)},volume=1.6[n${i}]`); mix.push(`[n${i}]`); });
      else console.error('narration: speech synthesis failed, continuing without it');
    } else if (lines.length) console.error('narration needs Windows speech synthesis: skipped');
    if (mix.length) {
      chain.push(`${mix.join('')}amix=inputs=${mix.length}:normalize=0:duration=longest[x]`, '[x]loudnorm=I=-14:TP=-1.5:LRA=11[a]');
      code = await new Promise<number>((r) => run([...inputs, '-filter_complex', chain.join(';'), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-ar', '44100', '-c:a', 'aac', '-b:a', '160k', '-shortest', out]).on('close', r));
    } else code = await new Promise<number>((r) => run(['-i', vid, '-c', 'copy', out]).on('close', r));
    for (const t of [vid, ...tmp]) rmSync(t, { force: true });
  }
  console.log(`ffmpeg exit ${code}: ${out} (${n} frames, ${(n / fps).toFixed(1)}s${silent ? ', silent' : narrate ? ', with sound and narration' : ', with sound'})`);
} finally {
  await browser.close(); await server.close();
}
