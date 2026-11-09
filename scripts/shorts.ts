// One command, N Shorts: finds the best moments, renders each to out/. Usage: node scripts/shorts.ts [scenario|all] [seed] [top=3] [windowSec=40]
// A 40 s window at the default 2x speed is a 20 s Short. Each clip is titled from the scenario and captioned from what happens in it.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';

const [scn = 'all', seed = '1', top = '3', win = '40'] = process.argv.slice(2);
const run = (args: string[]) => execFileSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 26 });
const data = (id: string) => JSON.parse(readFileSync(new URL(`../src/data/${id}.json`, import.meta.url), 'utf8'));
const NAME: Record<string, string> = { charge: 'charges', flank: 'flank attacks', rout: 'routs', dead: 'regiments destroyed', falter: 'faltering charges' };

const moments: any[] = JSON.parse(run(['scripts/moments.ts', scn, seed, win, top]));
mkdirSync('out', { recursive: true });
for (const m of moments.slice(0, scn === 'all' ? Number(top) : moments.length)) {
  const d = data(m.scn), file = `out/${m.scn}-${m.seed}-${m.from}.mp4`;
  const sub = Object.entries(m.tags).filter(([k]) => NAME[k]).sort((a: any, b: any) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${n} ${NAME[k]}`).join(' · ');
  console.log(`\n== ${file}  (score ${m.score})`);
  console.log(run(['scripts/capture.ts', m.scn, String(m.seed), String(m.from), String(m.to), file, '--x', String(m.x), '--z', String(m.z), '--title', `${d.title ?? m.scn}${d.date ? ', ' + d.date : ''}`, '--sub', sub]).trim().split('\n').pop());
}
