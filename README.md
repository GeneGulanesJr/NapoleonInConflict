# Napoleon In Conflict

Browser tactical game of the Waterloo campaign (15-18 June 1815), WiC-inspired: no base building, capture and hold objectives, role-based units, cooldown tactical aid.
Five linked battles: **Charleroi → Quatre Bras → Ligny → Genappe → Waterloo**. Your regiments' losses carry over between battles.

## Run
    npm install
    npm run dev        # game at http://localhost:5173
    npm run server     # multiplayer server (ws://localhost:8080), optional
    npm run sim        # headless bot-vs-bot balance run over all five battles
    npm run build      # type-check + production build

## Controls
Left-click / drag-box select · right-click move or attack · WASD pan · Q/E or middle-drag rotate · wheel zoom ·
Z/X/C line/column/square · H halt · 1/2/3 barrage/rockets/cavalry reserve (then click target) · Space pause · F focus · M mute.

## Tuning
All gameplay numbers: `src/data/tuning.json`. Battles: `src/data/<battle>.json` (map, zones, forces, reinforcement timeline, weather).
Campaign order and roster: `src/data/campaign.json`.

## Layout
`src/sim/` pure deterministic simulation + bot (shared by browser and server) · `src/render.ts` Three.js view ·
`src/battle.ts` input/HUD/Anime.js presentation · `src/main.ts` menus + campaign flow · `server/server.ts` authoritative WebSocket server.

Original code and placeholder geometry only; no assets from World in Conflict or any other game.
