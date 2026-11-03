// Pixel-art UI helpers from the style guide: 12x12 icons drawn from character grids, scaled up with image-rendering: pixelated.
const PAL: Record<string, string> = { K: '#2b2b30', k: '#6b6b74', Y: '#ffd45a', o: '#e8872a', R: '#c23a2e', W: '#e9e4d6', B: '#2f55b8', g: '#9ca3ad', S: '#b8bcc4', s: '#7b808a', b: '#8cc4ff' };
export const ICONS: Record<string, string[]> = {
  barrage: ['........Y...', '.......Yo...', '......o.....', '....KKKK....', '...KKKKKK...', '..KkKKKKKK..', '..KkKKKKKK..', '..KKKKKKKK..', '..KKKKKKKK..', '...KKKKKK...', '....KKKK....', '............'],
  rockets: ['........WW..', '.......WWR..', '......WSSR..', '.....WSSs...', '....WSSs....', '...WSSs.....', '..oSSs......', '.oYo........', 'oYYo........', '.oo.........', '............', '............'],
  cavalry: ['..SSSSSSSS..', '.SSsssssSSS.', 'SSs.....sSS.', 'SS........SS', 'SS........SS', 'Ss........sS', 'SS........SS', 'SS..Y..Y..SS', 'SS........SS', 'SS........SS', 'ss........ss', '............'],
  // order cursors (what a right-click would do) and unit status marks; pxUrl rings them with a dark outline
  sword: ['WS.........', '.WS........', '..WS.......', '...WS......', '....WS.....', '.....WS..Y.', '......W.Y..', '.......Y...', '......Y.o..', '.....Y...o.', '..........Y'],
  house: ['.....R.....', '....RRR....', '...RRRRR...', '..RRRRRRR..', '.RRRRRRRRR.', 'RRRRRRRRRRR', '.WWWWWWWWW.', '.WkWWWWWkW.', '.WWWWkWWWW.', '.WWWWkWWWW.', '.WWWWkWWWW.'],
  march: ['....YYo....', '....YYo....', '....YYo....', '....YYo....', '.YYYYYYYYo.', '..YYYYYYo..', '...YYYYo...', '....YYo....', '.....Y.....'],
  posted: ['SSSSS', 'SWSSs', 'SWSSs', '.SSs.', '..s..'],
  shaken: ['o.Y.o', '.ooo.', 'YoWoY', '.ooo.', 'o.Y.o'],
  stun: ['.Y...', 'YWY..', '.Y.Y.', '..YWY', '...Y.'],
  tired: ['..b..', '.bbb.', 'bbbbb', 'bWbbb', '.bbb.'],
  charge: ['W...W', '.W.W.', '..W..', '.Y.Y.', 'o...o'],
  waver: ['..R..', '..R..', 'RRRRR', '.RRR.', '..R..'],
  routed: ['sWWW.', 'sWWWW', 'sWW..', 's....', 's....'],
};
export function pxCanvas(rows: string[], scale = 3): HTMLCanvasElement {
  const h = rows.length, w = rows[0].length, c = document.createElement('canvas');
  c.width = w; c.height = h; c.style.width = w * scale + 'px'; c.style.height = h * scale + 'px'; c.style.imageRendering = 'pixelated';
  const g = c.getContext('2d')!;
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (PAL[ch]) { g.fillStyle = PAL[ch]; g.fillRect(x, y, 1, 1); } }));
  return c;
}
const urls: Record<string, string> = {};
/** ICONS[name] as a data URL, `scale` px per cell, ringed with a 1px dark outline so it reads on any ground; built once */
export function pxUrl(name: string, scale = 1) {
  const key = name + scale, r = ICONS[name], on = (x: number, y: number) => !!PAL[r[y]?.[x] ?? ''];
  if (urls[key]) return urls[key];
  const rows = Array.from({ length: r.length + 2 }, (_, y) => Array.from({ length: r[0].length + 2 }, (_, x) => (on(x - 1, y - 1) ? r[y - 1][x - 1] : on(x - 2, y - 1) || on(x, y - 1) || on(x - 1, y - 2) || on(x - 1, y) ? 'K' : '.')).join(''));
  const c = document.createElement('canvas'), g = c.getContext('2d')!;
  c.width = rows[0].length * scale; c.height = rows.length * scale; g.imageSmoothingEnabled = false;
  g.drawImage(pxCanvas(rows), 0, 0, c.width, c.height);
  return (urls[key] = c.toDataURL());
}
/** a CSS cursor from an icon, hot spot at cell (hx, hy) of the icon's grid */
export const pxCursor = (name: string, hx: number, hy: number, scale = 2) => `url(${pxUrl(name, scale)}) ${(hx + 1) * scale} ${(hy + 1) * scale}, auto`;
