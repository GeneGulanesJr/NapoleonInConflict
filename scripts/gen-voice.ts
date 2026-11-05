// Renders the officer-radio lines (src/battle.ts say(...)) with MiniMax TTS so you can audition voices.
// Usage: MINIMAX_API_KEY=... node scripts/gen-voice.ts [voice_id ...]   -> audio-preview/<voice>/<slug>[.fr].mp3 + n-<name>.mp3 + index.html
// To ship a voice: copy audio-preview/<voice>/*.mp3 into src/voice/ (say() in src/audio.ts bundles and plays them).
// Each line is rendered in English (accented by a French voice) and in French. A line with a regiment or zone name is
// played as the name clip (n-<name>.mp3, rendered once) plus a fragment clip, so the names are collected from the sim below.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createSim, step } from '../src/sim/sim.ts';
import { makeBot } from '../src/sim/bot.ts';
import { makeSkirmish } from '../src/sim/skirmish.ts';

const KEY = process.env.MINIMAX_API_KEY;
if (!KEY) throw new Error('set MINIMAX_API_KEY');
const BASE = process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io';
const MODEL = process.env.MINIMAX_TTS_MODEL ?? 'speech-2.8-hd';
const OUT = 'audio-preview';
const VOICES = process.argv.length > 2 ? process.argv.slice(2) : ['French_MaleNarrator'];
const LINES: [en: string, fr: string][] = [
  ['Guns, fire for effect!', 'Canons, feu à volonté !'], ['Rockets away!', 'Fusées, feu !'],
  ['Cavalry, charge!', 'Cavalerie, chargez !'], ['Incoming fire! Take cover!', 'Tir ennemi ! À couvert !'],
  ['Reinforcements have arrived, sir.', 'Les renforts sont arrivés, mon général.'], ['Enemy reinforcements spotted.', 'Renforts ennemis en vue.'],
  ['They are in our rear!', 'Ils sont sur nos arrières !'], ['We are being flanked!', 'On nous prend de flanc !'],
  ['Enemy regiment is routing!', 'Le régiment ennemi est en déroute !'], ['Enemy regiment destroyed!', 'Régiment ennemi anéanti !'],
  ['Present! Fire!', 'En joue ! Feu !'], ['Skirmishers, advance!', 'Tirailleurs, en avant !'],
  ['Charge!', 'À la charge !'], ['Load canister!', 'Chargez à mitraille !'],
  ['Rally to me!', 'Ralliez-vous à moi !'], ['Yes sir!', 'À vos ordres, mon général !'],
  ['Contact! Enemy in range.', 'Contact ! Ennemi à portée.'],
  // fragments that go next to a name clip (FRAG in src/audio.ts): "<name> has earned its stripes." "We have lost <name>."
  ['has earned its stripes.', 'a gagné ses galons.'], ['is breaking, sir!', 'plie, mon général !'],
  ['We have lost', 'Nous avons perdu'], ['is ours, sir.', 'est à nous, mon général.'],
  ['They are counter-attacking', 'Contre-attaque ennemie sur'], // + the zone's name clip
];
// keep in step with slug() in src/audio.ts
const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Every regiment and zone name the game can say: the campaign roster, the scenarios and a few random skirmishes. */
function collectNames(): string[] {
  const J = (f: string) => JSON.parse(readFileSync(`src/data/${f}.json`, 'utf8'));
  const tu = J('tuning'), camp = J('campaign'), out = new Set<string>(Object.values(camp.roster).flat() as string[]);
  const scns = [...[...camp.battles, 'hougoumont', 'wavre'].map((id) => ({ scn: J(id), run: true })), ...Array.from({ length: 30 }, (_, s) => ({ scn: makeSkirmish(s + 1), run: false }))];
  for (const { scn, run } of scns) {
    const sim = createSim(scn, tu, { seed: 1 }), bots = [makeBot(sim, 0), makeBot(sim, 1)];
    for (const z of sim.s.zones) out.add(z.name);
    for (const u of sim.s.units) out.add(u.name);
    for (let k = 0; run && !sim.s.over && sim.s.t < scn.duration + 5; k++) { // reinforcements only appear as the battle runs
      step(sim, 0.05); bots[0](0.05); bots[1](0.05);
      if (k % 20 === 0) for (const u of sim.s.units) out.add(u.name);
    }
  }
  return [...out].filter(Boolean);
}

async function tts(text: string, voice: string, fr: boolean): Promise<Buffer> {
  const r = await fetch(`${BASE}/v1/t2a_v2`, {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, text, stream: false, output_format: 'hex', ...(fr && { language_boost: 'French' }),
      voice_setting: { voice_id: voice, speed: 1.05, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    }),
  });
  const j: any = await r.json();
  // MiniMax answers 200 with the error in base_resp, so check it
  if (!r.ok || j.base_resp?.status_code || !j.data?.audio) throw new Error(`${voice} "${text}": ${r.status} ${JSON.stringify(j.base_resp)}`);
  return Buffer.from(j.data.audio, 'hex');
}
/** Render a clip, or reuse the one already shipped in src/voice (delete it there to re-render), so a new line costs only itself. */
async function clip(file: string, voice: string, text: string, fr: boolean) {
  const shipped = `src/voice/${file}`;
  writeFileSync(`${OUT}/${voice}/${file}`, voice === 'French_MaleNarrator' && existsSync(shipped) ? readFileSync(shipped) : await tts(text, voice, fr));
  console.log(`${voice}/${file}`);
}

const names = collectNames();
console.log(`${names.length} names`);
if (process.env.LIST_NAMES) { console.log(names.join(' | ')); process.exit(); }
let html = '<meta charset=utf-8><title>voices</title><body style="font:14px sans-serif;background:#111;color:#ddd">';
for (const v of VOICES) {
  mkdirSync(`${OUT}/${v}`, { recursive: true });
  html += `<h2>${v}</h2>`;
  for (const [en, fr] of LINES) {
    await clip(`${slug(en)}.mp3`, v, en, false);
    await clip(`${slug(en)}.fr.mp3`, v, fr, true);
    html += `<div>${en} / ${fr} <audio controls preload=none src="${v}/${slug(en)}.mp3"></audio> <audio controls preload=none src="${v}/${slug(en)}.fr.mp3"></audio></div>`;
  }
  html += '<h3>names</h3>';
  for (const n of names) { // the name is a proper noun, so one clip serves both languages
    await clip(`n-${slug(n)}.mp3`, v, n, false);
    html += `<div>${n} <audio controls preload=none src="${v}/n-${slug(n)}.mp3"></audio></div>`;
  }
}
writeFileSync(`${OUT}/index.html`, html);
console.log(`open ${OUT}/index.html`);
