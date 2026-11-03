# Napoleon In Conflict

Browser tactical game of the Waterloo campaign (15-18 June 1815), WiC-inspired: no base building, capture and hold objectives, role-based units, cooldown tactical aid.
Five linked battles: **Charleroi → Quatre Bras → Ligny → Genappe → Waterloo**. Your regiments' losses carry over between battles.

## Modes
- **Campaign** (French): losses and veterancy carry over. Each battle earns glory (win 90, draw 60, loss 40), spent between battles on replacements or on raising a destroyed regiment again. A battle in progress is saved every 15 s; quit and resume it from the campaign screen.
- **Quick Battle**: any of the seven battles or a random skirmish, as the French or the Coalition. Nothing is saved.
- **Multiplayer**: team vs team on one battlefield; an empty side is played by the bot.
- **Replays**: after a single-player battle, "Watch replay" plays it back from the recorded orders (the sim is deterministic).
- **Settings** (title screen or the in-battle menu): music and effects volume, radio voice, edge scrolling, render quality, difficulty (enemy at 80 / 100 / 125% strength), fog of war.

## Run
    npm install
    npm run dev        # game at http://localhost:5173
    npm run server     # multiplayer server (ws://localhost:8080), optional
    npm run sim        # headless bot-vs-bot run over every battle
    npm run build      # type-check + production build
    npm test           # unit rules, bot, campaign roster, replay determinism, multiplayer server

## Controls
Press **?** or **F10** in battle for the full list.

- **Camera**: WASD / arrows / screen edge pan · Q/E or middle-drag rotate · wheel zoom · F focus selection · Backspace last alert
- **Select**: left-click / drag · Shift adds · double-click all of that kind · Ctrl+A all · Shift+1-9 save group, 1-9 recall · I next idle
- **Orders**: right-click move or attack · right-drag form a line · Shift+right-click waypoint · right-click a farm to garrison · A then click attack-move · H halt · G stance
- **Formations**: Z/X/C line / column / square · B auto-square · V unit special · K + click bayonet charge
- **Aid and reserves**: F1/F2/F3 tactical aid · N replenish · reserves panel to call in a regiment
- **Game**: Space pause · +/- speed (1-8×) · Esc menu (restart, quit, settings) · M mute · R radio

## Tuning
All gameplay numbers: `src/data/tuning.json`. Battles: `src/data/<battle>.json` (map, zones, forces, reinforcement timeline, weather).
Campaign order, roster and glory: `src/data/campaign.json`.

## Layout
`src/sim/` pure deterministic simulation, bot, campaign roster and replay recorder (shared by browser and server) · `src/render.ts` Three.js view ·
`src/battle.ts` input/HUD/Anime.js presentation · `src/settings.ts` settings buttons · `src/main.ts` menus + campaign flow · `server/server.ts` authoritative WebSocket server.

Original code and placeholder geometry only; no assets from World in Conflict or any other game.
