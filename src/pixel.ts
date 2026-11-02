// Pixel-art UI helpers from the style guide: 12x12 icons drawn from character grids, scaled up with image-rendering: pixelated.
const PAL: Record<string, string> = { K: '#2b2b30', k: '#6b6b74', Y: '#ffd45a', o: '#e8872a', R: '#c23a2e', W: '#e9e4d6', B: '#2f55b8', g: '#9ca3ad', S: '#b8bcc4', s: '#7b808a' };
export const ICONS: Record<string, string[]> = {
  barrage: ['........Y...', '.......Yo...', '......o.....', '....KKKK....', '...KKKKKK...', '..KkKKKKKK..', '..KkKKKKKK..', '..KKKKKKKK..', '..KKKKKKKK..', '...KKKKKK...', '....KKKK....', '............'],
  rockets: ['........WW..', '.......WWR..', '......WSSR..', '.....WSSs...', '....WSSs....', '...WSSs.....', '..oSSs......', '.oYo........', 'oYYo........', '.oo.........', '............', '............'],
  cavalry: ['..SSSSSSSS..', '.SSsssssSSS.', 'SSs.....sSS.', 'SS........SS', 'SS........SS', 'Ss........sS', 'SS........SS', 'SS..Y..Y..SS', 'SS........SS', 'SS........SS', 'ss........ss', '............'],
};
export function pxCanvas(rows: string[], scale = 3): HTMLCanvasElement {
  const h = rows.length, w = rows[0].length, c = document.createElement('canvas');
  c.width = w; c.height = h; c.style.width = w * scale + 'px'; c.style.height = h * scale + 'px'; c.style.imageRendering = 'pixelated';
  const g = c.getContext('2d')!;
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (PAL[ch]) { g.fillStyle = PAL[ch]; g.fillRect(x, y, 1, 1); } }));
  return c;
}
