// Model lab: close-up stills of the figures on flat ground, to judge the models while changing them.
// Usage: node scripts/lab.ts [out-dir=out/lab]   -> infantry, guard, cavalry, gunners from front, side and wide
import { mkdirSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const dir = process.argv[2] ?? 'out/lab';
mkdirSync(dir, { recursive: true });
const chrome = process.env.CHROME ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if (!chrome) throw new Error('no Chrome/Edge found: set CHROME to its path');
const server = await createServer({ server: { port: 5199 }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page:', e));
  await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
  await page.goto('http://localhost:5199/capture.html?crowd=1.4&smoke=0.6');
  await page.waitForFunction('window.__cineReady', { timeout: 60000 });
  const T = (35 * Math.PI) / 180;
  const sets: [string, string[]][] = [['inf', ['line:fr', 'line:gb', 'guard:fr']], ['cav', ['cuirassier:fr', 'lancer:fr', 'commander:fr']], ['art', ['artillery:fr', 'skirmisher:fr']]];
  for (const [name, kinds] of sets) {
    const us: any[] = await page.evaluate((k) => (window as any).__cine.lab(k), kinds);
    for (const [i, u] of us.entries()) {
      for (const [view, dist, yaw, tilt] of [['front', 24, -Math.PI / 4, T * 0.7], ['three-quarter', 24, 0, T * 0.9], ['side', 24, Math.PI / 4, T * 0.6], ['back', 24, (3 * Math.PI) / 4, T * 0.8]] as const) {
        await page.evaluate((a) => (window as any).__cine.snap(...a), [u.x, u.z, dist, yaw, tilt] as const);
        await page.screenshot({ path: `${dir}/${name}-${i}-${u.type}-${view}.png` });
      }
    }
  }
  console.log(`stills in ${dir}`);
} finally {
  await browser.close(); await server.close();
}
