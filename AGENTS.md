# Agent guide: Napoleon In Conflict

Browser RTS: TypeScript, three.js, Anime.js, Vite. One deterministic sim (`src/sim/`) runs in the browser and on the Node server (`server/server.ts`).

## Always apply the demoscene techniques

Whenever you add or change rendering, audio, content generation or anything performance-sensitive, use the techniques from these two projects wherever they fit:

- **.kkrieger / .werkkzeug3** (farbrausch): https://github.com/jaromil/kkrieger-werkkzeug3
- **q1k3** (phoboslab's 13 KB Quake): https://github.com/phoboslab/q1k3

What that means here:

- **Content is code, not files.** Generate textures, sprites, meshes and sounds at load from small recipes: OpenKTG-style seeded noise and cells, TTT-style draw ops, box-modelled meshes. No image or audio assets when a recipe can do it. Examples already in the repo:
  - `detailPixels()`, the fx sprite sheet and the box-built figures in `src/render.ts`
  - the WebAudio synth in `src/audio.ts`
- **Precompute at load, not per frame.** Bake anything expensive once per scenario: height grids, sound buffers, texture tiles, merged geometry. Example: the cached height grid in `src/sim/world.ts`.
- **Fixed-size pools in shader uniforms** instead of many engine objects. Example: the 16-light gunfire pool (`flashHook` in `src/render.ts`).
- **Instancing and shared buffers.** One instanced mesh per part. Twins (ink hull, shadow proxy) share `instanceMatrix`. Upload only the used slice (`addUpdateRange`). Skip off-screen regiments.
- **Determinism everywhere in the sim.** Seeded integer hashes, never `Math.random`, so client and server agree.
- **Small and lean.** Prefer the smallest code that does the job, as both projects do.

Don't port their size-coding tools (kkrunchy, lekktor, Roadroller): Vite already handles the bundle.

Measure before and after. Use `node --cpu-prof scripts/headless.ts`, or headless Chrome on the real GPU. Keep a change only if the numbers hold up.

## Working rules

- **Verify:** `npx tsc --noEmit`, `npm test` (unit tests run on a flat `arena()`; pass a `map` to test terrain), `node scripts/headless.ts [seed]`. Build into a temp directory, never `dist/`.
- **Tuning:** gameplay numbers live in `src/data/tuning.json`.
- **Scenarios:** each is a JSON file in `src/data/`. Scale is 1 unit = 10 m, +x = east, +z = south, hill height = real relief in metres / 4.
- **Server input:** `server/server.ts` `clean()` must accept every new command field, validated.
- **Bots:** they play through the same `command()` API as humans (`src/sim/bot.ts`).
