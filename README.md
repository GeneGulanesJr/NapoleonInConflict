# Napoleon In Conflict

Browser tactical game of the Waterloo campaign (15-18 June 1815), WiC-inspired: no base building, capture and hold objectives, role-based units, cooldown tactical aid.
Five linked battles: **Charleroi → Quatre Bras → Ligny → Genappe → Waterloo**. Your regiments' losses carry over between battles.

## Modes
- **Campaign** (French): losses and veterancy carry over. Each battle earns glory (win 90, draw 60, loss 40), spent between battles on replacements or on raising a destroyed regiment again. A battle in progress is saved every 15 s; quit and resume it from the campaign screen. The first battle (Charleroi) has a step-by-step tutorial (skip it with its button; Settings > Tutorial hints brings it back).
- **Grouchy's orders**: after Ligny the campaign asks once what Marshal Grouchy does. *Pursue the Prussians* (history): six regiments miss Waterloo, and the Prussians come 40-60 min later and weaker. *Screen them lightly*: two regiments miss it, the Prussians are 20-30 min late. *March to the sound of the guns*: everyone fights, Gérard's corps arrives about 18:00, and the Prussians come on time.
- **Quick Battle**: any of the seven battles or a random skirmish, as the French or the Coalition. Nothing is saved.
- **Multiplayer**: team vs team on one battlefield; an empty side is played by the bot.
- **Replays**: after a single-player battle, "Watch replay" plays it back from the recorded orders (the sim is deterministic). The replay bar has play/pause, 1-16×, a scrubber you can click or drag to jump, and a marker per turning point. "Save replay" downloads a .json file; Quick Battle → "Watch a replay file…" plays one (only the scenario id or skirmish seed is stored; the scenario is rebuilt from the game's own data, and files are checked before they play).
- **Deployment**: local battles open paused. Place your regiments inside the blue zone around your starting positions (right-click or drag; they stand there at once, fronting the enemy), then Start battle / Enter.
- **Settings** (title screen or the in-battle menu): music and effects volume, radio voice, edge scrolling, render quality, difficulty (enemy at 80 / 100 / 125% strength), fog of war, march in column (on), courier orders (off: orders to regiments far from their general take time to arrive), deployment phase, tutorial hints, interface size (Auto / Larger / Largest), colour-blind sides (blue / orange).

## Battle rules worth knowing
- Regiments route round deep rivers (by the bridges), woods and villages, and columns, guns and horse take the roads when that is quicker.
- A long march is made in column and the line forms again on arrival (or as soon as the enemy is within musket range). A group order marches at its slowest member's pace. A short order to the rear steps back facing the enemy.
- Orders the game cannot carry out (a shaken regiment reforming, a full farm, too few points for a draft) say so in a message. Restart and Quit (without saving) ask twice. Halt (H) leaves a garrison in its farm.
- **Hold fire** (G): line, guard and guns wait until the enemy is close, then give a heavy first volley, which can make a charge falter.
- Fire shakes what it hits in proportion to the losses (slower reload, weaker fire, no reforming); a cavalry charge stuns foot that is not in square (a square takes about 3 s to form, and one caught still forming is slaughtered; formed, it marches very slowly); night falls late in the long battles.
- With regiments selected, the cursor shows what a right-click does: sword = attack, house = garrison, arrow = march. Icons beside a regiment's plate: shield posted, burst shaken, stars stunned, drop tired, crossed blades charging, red arrow wavering, white flag routed. Select one regiment for its full card.

## Run
    npm install
    npm run dev        # game at http://localhost:5173
    npm run server     # multiplayer server (ws://localhost:8080), optional
    npm run sim        # headless bot-vs-bot run over every battle
    npm run build      # type-check + production build
    npm test           # unit rules, bot, campaign roster, pathfinding, deployment, replay determinism, multiplayer server

## Controls
Press **?** or **F10** in battle for the full list.

- **Camera**: WASD / arrows / screen edge pan · Q/E or middle-drag rotate · wheel zooms at the cursor · F focus selection · O follow the selection · Ctrl+F5-F8 save a view, F5-F8 fly back to it · Backspace last alert · Tab big map, drag on the minimap to pan
- **Select**: left-click / drag · Shift adds · double-click all of that kind · Ctrl+A all · Shift+1-9 save group, 1-9 recall · I next idle
- **Orders**: right-click move or attack · right-drag draw a front (the drag is the width the group fills: wider spreads the regiments out, narrower packs them, then a second rank forms behind, then column, then single file; ghosts show where each will stand and in what formation) · double right-click double time · Alt+right-click/drag move as a block · Ctrl+right-click face that way · Shift+right-click waypoint · right-click a farm to garrison · A then click attack-move · H halt · G stance (hold / attack / hold fire)
- **Formations**: Z/X/C line / column / square (horse: Z squadron, X wedge: hits and shocks harder once formed, but wheels slowly and takes more fire) · V unit special · K + click bayonet charge
- **Aid and reserves**: F1/F2/F3 tactical aid · N replenish (not in combat or with the enemy near) · reserves panel to call in a regiment
- **Game**: Space pause · +/- speed (1-8×) · Enter start the battle (deployment) · Esc menu (restart, quit, settings) · J message log · M mute · R radio

## Tuning
All gameplay numbers: `src/data/tuning.json`. Battles: `src/data/<battle>.json` (map, zones, forces, reinforcement timeline, weather).
Campaign order, roster, glory and Grouchy's orders: `src/data/campaign.json`. Waterloo's timeline events take `delayIfGrouchy`, `ifGrouchy` and `unlessGrouchy`.

## Layout
`src/sim/` pure deterministic simulation, bot, campaign roster, route finding (`path.ts`: per-map movement-cost grid, A*, string-pulled waypoints) and replay recorder (shared by browser and server) · `src/render.ts` Three.js view ·
`src/battle.ts` input/HUD/Anime.js presentation · `src/tutorial.ts` first-battle tutorial · `src/settings.ts` settings buttons · `src/main.ts` menus + campaign flow · `server/server.ts` authoritative WebSocket server.

Music: a procedural fife-and-drum march in your own army's tune: *La Marseillaise* for the French, *God Save the King* for the Coalition (Prussia's *Heil dir im Siegerkranz* is the same melody).

Original code and placeholder geometry only; no assets from World in Conflict or any other game.
