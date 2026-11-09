// Narration for the documentary: turns the spoken (blockquote) lines of a script in docs/ into MiniMax speech, one clip per paragraph,
// then joins them with pauses into one track and writes a timing manifest (chapter and paragraph start times) for the video.
// Usage: MINIMAX_API_KEY=... node scripts/narrate.ts audition [voice ...]          -> out/narration/audition/<voice>.mp3 (the cold open, to choose a voice)
//        MINIMAX_API_KEY=... node scripts/narrate.ts full <voice> [script=docs/lodi-script.md] [speed=0.95]   -> out/narration/<name>.mp3 + <name>.json
// The key is read from the environment only and is never written anywhere.
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ffmpeg from 'ffmpeg-static';

const KEY = process.env.MINIMAX_API_KEY;
if (!KEY) throw new Error('set MINIMAX_API_KEY');
const BASE = process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io';
const MODEL = process.env.MINIMAX_TTS_MODEL ?? 'speech-2.8-hd';
const [mode, ...rest] = process.argv.slice(2);
const FF = ffmpeg as unknown as string;
const OUT = 'out/narration';

/** The spoken text of a script: the blockquote paragraphs of each numbered chapter heading (## 0. ... to ## 7. ...), emphasis marks removed. The end card (chapter 8) is on screen only. */
function spoken(file: string): { chapter: string; paras: string[] }[] {
  const out: { chapter: string; paras: string[] }[] = []; let cur: { chapter: string; paras: string[] } | null = null, para: string[] = [];
  const flush = () => { if (cur && para.length) cur.paras.push(para.join(' ').replace(/\*/g, '').replace(/\s+/g, ' ').trim()); para = []; };
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const h = /^## (\d+)\. (.+?)(?: \(|$)/.exec(line);
    if (h) { flush(); cur = Number(h[1]) <= 7 ? { chapter: h[2], paras: [] } : null; if (cur) out.push(cur); continue; }
    if (!cur) continue;
    if (line.startsWith('>')) { const t = line.replace(/^>\s?/, ''); if (t.trim()) para.push(t.trim()); else flush(); } else flush();
  }
  flush();
  return out;
}

async function tts(text: string, voice: string, speed: number): Promise<Buffer> {
  const r = await fetch(`${BASE}/v1/t2a_v2`, {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, text, stream: false, output_format: 'hex',
      voice_setting: { voice_id: voice, speed, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    }),
  });
  const j: any = await r.json();
  if (!r.ok || j.base_resp?.status_code || !j.data?.audio) throw new Error(`${voice}: ${r.status} ${JSON.stringify(j.base_resp)}`); // MiniMax answers 200 with the error in base_resp
  return Buffer.from(j.data.audio, 'hex');
}
const secs = (file: string) => { const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(spawnSync(FF, ['-i', file], { encoding: 'utf8' }).stderr); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0; };
/** a clip of silence, same format as the speech, so the pieces can be joined without a re-encode surprise */
const silence = (file: string, s: number) => spawnSync(FF, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', String(s), '-c:a', 'libmp3lame', '-b:a', '128k', file]);

mkdirSync(OUT, { recursive: true });
if (mode === 'audition') {
  mkdirSync(`${OUT}/audition`, { recursive: true });
  const voices = rest.length ? rest : ['English_expressive_narrator', 'English_Deep-VoicedGentleman', 'English_CaptivatingStoryteller'];
  const text = spoken('docs/lodi-script.md')[0].paras.join(' ');
  for (const v of voices) { writeFileSync(`${OUT}/audition/${v}.mp3`, await tts(text, v, 0.95)); console.log(`${OUT}/audition/${v}.mp3 (${text.split(' ').length} words)`); }
} else if (mode === 'full') {
  const [voice, script = 'docs/lodi-script.md', speed = '0.95'] = rest;
  if (!voice) throw new Error('usage: narrate.ts full <voice> [script] [speed]');
  const name = script.replace(/^.*\//, '').replace(/\.md$/, '').replace(/-script$/, '') + '-narration', dir = `${OUT}/${name}`;
  mkdirSync(dir, { recursive: true });
  const list: string[] = [], manifest: { chapter: string; start: number; paras: { start: number; seconds: number; text: string }[] }[] = [];
  silence(`${dir}/gap.mp3`, 0.7); silence(`${dir}/chapter-gap.mp3`, 1.8);
  let t = 0;
  for (const [ci, ch] of spoken(script).entries()) {
    const entry = { chapter: ch.chapter, start: Math.round(t * 100) / 100, paras: [] as { start: number; seconds: number; text: string }[] };
    for (const [pi, text] of ch.paras.entries()) {
      const f = `${dir}/${createHash('sha1').update(`${voice}|${speed}|${text}`).digest('hex').slice(0, 12)}.mp3`; // named by its text, voice and speed, so an edited paragraph is re-rendered and an unchanged one is reused
      if (!existsSync(f)) writeFileSync(f, await tts(text, voice, Number(speed)));
      const s = secs(f); entry.paras.push({ start: Math.round(t * 100) / 100, seconds: Math.round(s * 100) / 100, text });
      list.push(f); t += s; if (pi < ch.paras.length - 1) { list.push(`${dir}/gap.mp3`); t += 0.7; }
      console.log(`chapter ${ci} paragraph ${pi}: ${s.toFixed(1)} s`);
    }
    manifest.push(entry); if (ci < spoken(script).length - 1) { list.push(`${dir}/chapter-gap.mp3`); t += 1.8; }
  }
  writeFileSync(`${dir}/list.txt`, list.map((f) => `file '${f.replace(/^.*\//, '')}'`).join('\n'));
  const out = `${OUT}/${name}.mp3`;
  const r = spawnSync(FF, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', `${dir}/list.txt`, '-c:a', 'libmp3lame', '-b:a', '160k', out], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed to join the clips');
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify({ voice, speed: Number(speed), seconds: Math.round(t * 100) / 100, chapters: manifest }, null, 1));
  console.log(`${out}: ${(t / 60).toFixed(1)} minutes; timings in ${OUT}/${name}.json`);
  if (existsSync(`${dir}/list.txt`)) rmSync(`${dir}/list.txt`);
} else throw new Error('usage: narrate.ts audition [voice ...]   |   narrate.ts full <voice> [script] [speed]');
