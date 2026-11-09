// Render benchmark. Usage: node scripts/bench.ts [--root <dir>] [--crowd 1.4] [--frames 150]
// --root: another checkout of the repo (with bench.html, src/bench.ts and a node_modules next to it) to compare an older commit.
import { existsSync } from 'node:fs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const f: Record<string, string> = {}, av = process.argv.slice(2);
for (let i = 0; i < av.length; i += 2) f[av[i].slice(2)] = av[i + 1];
const chrome = process.env.CHROME ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!chrome) throw new Error('no Chrome/Edge found: set CHROME to its path');
const server = await createServer({ root: f.root, server: { port: 5198 }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page:', e));
  await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
  await page.goto(`http://localhost:5198/bench.html?crowd=${f.crowd ?? 1.4}`);
  await page.waitForFunction('window.__benchReady', { timeout: 60000 });
  for (const dist of [110, 220]) {
    const r: any = await page.evaluate((n, d) => (window as any).__bench.run(n, d), Number(f.frames ?? 150), dist);
    console.log(`dist ${dist}: mean ${r.mean.toFixed(1)} ms  p95 ${r.p95.toFixed(1)} ms  max ${r.max.toFixed(1)} ms  (${r.units} units, ${r.gpu})`);
  }
} finally {
  await browser.close(); await server.close();
}
