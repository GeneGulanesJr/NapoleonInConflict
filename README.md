# Napoleon In Conflict

Browser tactical game of the Waterloo campaign (15-18 June 1815), WiC-inspired: no base building, capture and hold objectives, role-based units, cooldown tactical aid.
Five linked battles: **Charleroi → Quatre Bras → Ligny → Genappe → Waterloo**. Your regiments' losses carry over between battles.

## Modes
- **Campaign** (French): losses and veterancy carry over. Each battle earns glory (win 90, draw 60, loss 40), spent between battles on replacements or on raising a destroyed regiment again. A battle in progress is saved every 15 s; quit and resume it from the campaign screen. The first battle (Charleroi) has a step-by-step tutorial (skip it with its button; Settings > Tutorial hints brings it back).
- **Grouchy's orders**: after Ligny the campaign asks once what Marshal Grouchy does. *Pursue the Prussians* (history): six regiments miss Waterloo, and the Prussians come 40-60 min later and weaker. *Screen them lightly*: two regiments miss it, the Prussians are 20-30 min late. *March to the sound of the guns*: everyone fights, Gérard's corps arrives about 18:00, and the Prussians come on time.
- **Quick Battle**: any of the ten battles or a random skirmish, as the French or the Coalition. Nothing is saved.
- **Hold the Bridge** (quick battle): a timed objective. The Coalition rearguard wins the moment it still holds Genappe Bridge when five minutes are up; the French win by taking it first. The HUD counts down to the deadline.
- **Rearguard at Quatre Bras** (quick battle): the Coalition must keep 40% of everything it has fielded fighting when the clock runs out; the French win by grinding it below that. The bot rearguard falls back toward its own edge instead of holding ground.
- **Last Stand of the Old Guard** (quick battle): endless waves of British and Prussian troops, a little bigger every half minute, march in on three Old Guard battalions and a battery. There is nothing to win by killing: the score is how long the Guard lasts (the result screen shows time held and waves faced), and holding out to the end of the clock is a victory.
- **The Bridge of Lodi** (quick battle, 10 May 1796): Sebottendorf's Austrian rearguard and 14 guns on the east bank of the Adda, Bonaparte's advance guard, 24 guns and the arriving divisions of Masséna and Augereau in Lodi, one narrow wooden bridge between them and a ford upstream. Built from the order of battle (sources and uncertain numbers in docs/lodi.md); the French take the bridge or the Austrians hold it until 19:00.
- **Multiplayer** (work in progress, disabled in the menu for now): team vs team on one battlefield; an empty side is played by the bot. The server and the screen are still in the code; to turn it back on, remove `disabled` from the `#mp` button in `src/main.ts`.
- **Replays**: after a single-player battle, "Watch replay" plays it back from the recorded orders (the sim is deterministic). The replay bar has play/pause, 1-16×, a scrubber you can click or drag to jump, and a marker per turning point. "Save replay" downloads a .json file; Quick Battle → "Watch a replay file…" plays one (only the scenario id or skirmish seed is stored; the scenario is rebuilt from the game's own data, and files are checked before they play).
- **Deployment**: local battles open paused. Place your regiments inside the blue zone around your starting positions (right-click or drag; they stand there at once, fronting the enemy), then Start battle / Enter.
- **Settings** (title screen or the in-battle menu): music and effects volume, radio voice, edge scrolling, render quality, difficulty (enemy at 80 / 100 / 125% strength), fog of war, march in column (on), courier orders (off: orders to regiments far from their general take time to arrive), deployment phase, tutorial hints, interface size (Auto / Larger / Largest), colour-blind sides (blue / orange).

## Battle rules worth knowing
- Regiments route round deep rivers (by the bridges), woods and villages, and columns, guns and horse take the roads when that is quicker.
- A long march is made in column and the line forms again on arrival (or as soon as the enemy is within musket range). A group order marches at its slowest member's pace. A short order to the rear steps back facing the enemy when one is close; otherwise the regiment turns and marches.
- Orders the game cannot carry out (a shaken regiment reforming, a full farm, too few points for a draft) say so in a message. Restart and Quit (without saving) ask twice. Halt (H) leaves a garrison in its farm.
- **Hold fire** (G): line, guard and guns wait until the enemy is close, then give a heavy first volley, which can make a charge falter.
- Fire shakes what it hits in proportion to the losses (slower reload, weaker fire, no reforming); a cavalry charge stuns foot that is not in square (a square takes about 3 s to form, and one caught still forming is slaughtered; formed, it marches very slowly); night falls late in the long battles.
- **Objectives** start neutral unless a regiment is standing on them (Quatre Bras's Piraumont and Waterloo's Plancenoit start French), so the defender has to earn them too. Held objectives earn points every second.
- **The Imperial Guard** is the best infantry on the field: 500 men, heavier fire, 60 rounds, high morale and a `tough` stat that cuts the casualties it takes. One regiment beats two line regiments, but not three.
- **Artillery** is poor at long range: round shot falls short or wide far more often the further it flies. A battery that keeps firing at one target ranges in (up to 45% fewer misses after four rounds); limbering and moving lose the range.
- **Ammunition**: line, guard, skirmishers and guns carry a fixed number of volleys or rounds (30 / 36 / 40 / 40) and cannot fire when dry. Resting on an objective your side holds, with no casualties for a few seconds, they take on powder and shot (faster while replenishing). The unit card shows Ammo; the bot pulls dry regiments back to a depot.
- **Army break point**: when the men still fighting fall under 30% of everything a side has fielded, "the army wavers": every regiment loses morale faster per casualty and recovers slower, more so the deeper under the line it is.
- **Pursuit and leadership**: horse cut down routed men harder than the other arms do. A regiment under a general who stands within 40 units of the enemy fights and holds a little better, and the general is shot at.
- **Difficulty** also changes how the bot plays: Hard thinks faster and uses tactical aid earlier, Easy the reverse.
- The end screen shows objectives held beside points: the verdict weighs objectives 60% and points 40%, so a side can win with fewer points.
- With regiments selected, the cursor shows what a right-click does: sword = attack, house = garrison, arrow = march. Icons beside a regiment's plate: shield posted, burst shaken, stars stunned, drop tired, crossed blades charging, red arrow wavering, white flag routed. Select one regiment for its full card.

## Run
    npm install
    npm run dev        # game at http://localhost:5173
    npm run server     # multiplayer server (ws://localhost:8080), optional
    npm run sim        # headless bot-vs-bot run over every battle
    npm run build      # type-check + production build
    npm test           # unit rules, bot, campaign roster, pathfinding, deployment, replay determinism, multiplayer server

## Shorts (vertical videos from the engine)
Needs Chrome or Edge installed; ffmpeg comes with `npm install` (`ffmpeg-static`). The sim is deterministic, so a battle is a recipe (scenario + seed) and every frame is rendered offline, one at a time.

    node scripts/moments.ts bridge 1 40 3        # best 40 s windows of a battle (scenario|all, seed, window, top)
    node scripts/capture.ts lodi 1 105 145 out/lodi.mp4 --x -14 --z -13 --title "THE BRIDGE OF LODI" --sub "10 May 1796" --narrate 1
    node scripts/shorts.ts bridge 1 3            # find the top 3 and render them all to out/
    node scripts/moments.ts battle.json 30 3     # the same on a replay saved from the game ("Save replay")
    node scripts/capture.ts --replay battle.json --from 100 --to 140 out/mine.mp4

The capture page (`capture.html`, `src/capture.ts`) runs a small director that cuts the story from the battle's own events (wide opening, charges followed from behind, volley push-ins, slow-motion on routs and kills, flank whips, a pull-out), shows turning points from the chronicle as captions, and renders the soundtrack offline from the game's synth. `--narrate 1` reads the captions aloud with Windows speech synthesis. Options: `--crowd` (men per sim man, 2.2), `--music fr|gb|off`, `--speed`, `--max` seconds.
`node scripts/lab.ts` renders close-up stills of every unit type and nation on flat ground to judge model changes; `node scripts/bench.ts` times the renderer on mid-battle Hougoumont (`--root` compares another checkout).

## Controls
Press **?** or **F10** in battle for the full list.

- **Camera**: WASD / arrows / screen edge pan · Q/E or middle-drag rotate · wheel zooms at the cursor · F focus selection · O follow the selection · Ctrl+F5-F8 save a view, F5-F8 fly back to it · Backspace last alert · Tab big map, drag on the minimap to pan
- **Select**: left-click / drag · Shift adds · double-click all of that kind · Ctrl+A all · Shift+1-9 save group, 1-9 recall · I next idle
- **Orders**: right-click move or attack · right-drag draw a front (the drag is the width the group fills: wider spreads the regiments out, narrower packs them, then a second rank forms behind, then column, then single file; ghosts show where each will stand and in what formation) · double right-click double time · Alt+right-click/drag move as a block · Ctrl+right-click face that way · Shift+right-click waypoint · right-click a farm to garrison · A then click attack-move · H halt · G stance (hold / attack / hold fire)
- **Formations**: Z/X/C line / column / square (horse: Z squadron, X wedge: hits and shocks harder once formed, but wheels slowly and takes more fire) · V unit special · K + click bayonet charge
- **Aid and reserves**: F1/F2/F3 tactical aid · N replenish (not in combat or with the enemy near) · reserves panel to call in a regiment
- **Game**: Space pause · +/- speed (1-8×) · Enter start the battle (deployment) · Esc menu (restart, quit, settings) · J message log · M mute · R radio

## Tuning
All gameplay numbers: `src/data/tuning.json`. Battles: `src/data/<battle>.json` (map, zones, forces, reinforcement timeline, weather). A battle can build on another with `"extends": "<id>"` (see `bridge.json`, `retreat.json`, `laststand.json`) and override only what differs; `hold: {zone, side, t}` is a timed objective `survive: {side, share}` a rearguard's goal, and `waves` an endless, escalating stream of reinforcements. A river bridge is `[x, z]` or `[x, z, halfWidth]` (7 by default): the half-width is how much of the river it keeps dry, and the drawn deck follows it.
Campaign order, roster, glory and Grouchy's orders: `src/data/campaign.json`. Waterloo's timeline events take `delayIfGrouchy`, `ifGrouchy` and `unlessGrouchy`.

## Layout
`src/sim/` pure deterministic simulation, bot, campaign roster, route finding (`path.ts`: per-map movement-cost grid, A*, string-pulled waypoints) and replay recorder (shared by browser and server) · `src/render.ts` Three.js view ·
`src/battle.ts` input/HUD/Anime.js presentation · `src/tutorial.ts` first-battle tutorial · `src/settings.ts` settings buttons · `src/main.ts` menus + campaign flow · `server/server.ts` authoritative WebSocket server.

Music: a procedural fife-and-drum march in your own army's tune: *La Marseillaise* for the French, *God Save the King* for the Coalition (Prussia's *Heil dir im Siegerkranz* is the same melody).

Original code and placeholder geometry only; no assets from World in Conflict or any other game.
