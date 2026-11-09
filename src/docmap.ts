// A schematic map of the 1796 campaign for the documentary's second chapter: the places and rivers are placed by latitude and longitude, the routes are the ones the
// sources describe, and everything is drawn as SVG that doc.ts reveals in step with the narration. It is a diagram, not a survey: rivers are rough polylines.
export const W = 1920, H = 1080;
const LON0 = 7.35, LON1 = 11.0, LAT0 = 44.05, LAT1 = 45.8, K = Math.cos((45 * Math.PI) / 180); // the box shown; degrees of longitude are shorter than degrees of latitude by K

/** longitude, latitude to the 1920 x 1080 picture (equirectangular, fitted into the frame with a margin) */
export function project(lon: number, lat: number): [number, number] {
  const mx = 150, my = 110, w = (LON1 - LON0) * K, h = LAT1 - LAT0, s = Math.min((W - 2 * mx) / w, (H - 2 * my) / h);
  return [Math.round(W / 2 + (lon - (LON0 + LON1) / 2) * K * s), Math.round(H / 2 - (lat - (LAT0 + LAT1) / 2) * s)];
}

export const TOWNS: Record<string, [number, number, string, number?]> = { // lon, lat, label, label offset (px, default to the right)
  genoa: [8.93, 44.41, 'Genoa'], savona: [8.48, 44.31, 'Savona'], montenotte: [8.38, 44.36, 'Montenotte'], millesimo: [8.2, 44.37, 'Millesimo'], dego: [8.31, 44.41, 'Dego'],
  mondovi: [7.82, 44.39, 'Mondovì'], cherasco: [7.86, 44.65, 'Cherasco'], turin: [7.69, 45.07, 'Turin'], alessandria: [8.61, 44.91, 'Alessandria'], valenza: [8.64, 45.01, 'Valenza'],
  pavia: [9.16, 45.19, 'Pavia'], piacenza: [9.7, 45.05, 'Piacenza'], fombio: [9.72, 45.15, 'Fombio · Codogno'], lodi: [9.5, 45.31, 'LODI'], milan: [9.19, 45.46, 'Milan'],
  crema: [9.68, 45.36, 'Crema'], cremona: [10.02, 45.13, 'Cremona'], mantua: [10.79, 45.16, 'Mantua'],
};
export const RIVERS: Record<string, { pts: [number, number][]; name: string; at: [number, number] }> = {
  po: { pts: [[7.4, 44.95], [7.69, 45.07], [7.9, 45.19], [8.45, 45.13], [8.65, 45.0], [9.0, 45.08], [9.25, 45.12], [9.7, 45.05], [10.03, 45.13], [10.4, 45.05], [11.0, 45.05]], name: 'Po', at: [10.45, 45.02] },
  adda: { pts: [[9.3, 45.8], [9.4, 45.7], [9.5, 45.5], [9.5, 45.31], [9.63, 45.2], [9.78, 45.12]], name: 'Adda', at: [9.36, 45.66] },
  ticino: { pts: [[8.72, 45.8], [8.95, 45.3], [9.16, 45.15]], name: 'Ticino', at: [8.8, 45.62] },
  tanaro: { pts: [[7.9, 44.5], [8.3, 44.75], [8.62, 44.9]], name: 'Tanaro', at: [8.1, 44.6] },
};
const COAST: [number, number][] = [[7.35, 43.9], [7.9, 43.95], [8.1, 44.1], [8.48, 44.3], [8.93, 44.4], [9.3, 44.35], [9.7, 44.12], [10.0, 44.05], [11.0, 44.05]];
export type Route = { pts: string[]; color: string; dash?: boolean; width: number; label: string; at: [number, number] };
export const ROUTES: Record<string, Route> = {
  april: { pts: ['montenotte', 'millesimo', 'dego', 'mondovi', 'cherasco'], color: '#6f9bff', width: 5, label: 'April: Montenotte to Mondovì, then the armistice', at: [7.4, 44.2] },
  feint: { pts: ['cherasco', 'alessandria', 'valenza'], color: '#e0c060', dash: true, width: 4, label: 'The feint at Valenza', at: [8.0, 44.98] },
  march: { pts: ['cherasco', 'piacenza'], color: '#6f9bff', width: 5, label: 'The real march: some 80 km to Piacenza', at: [8.85, 44.7] },
  final: { pts: ['piacenza', 'fombio', 'lodi'], color: '#6f9bff', width: 7, label: '7 to 10 May', at: [9.9, 45.25] },
  austrian: { pts: ['pavia', 'lodi', 'crema'], color: '#ff6a5c', dash: true, width: 4, label: 'Beaulieu falls back behind the Adda', at: [9.85, 45.42] },
};
const pt = (id: string) => project(TOWNS[id][0], TOWNS[id][1]);
const path = (ps: [number, number][]) => ps.map(([a, b], i) => `${i ? 'L' : 'M'}${a},${b}`).join(' ');

/** The SVG markup. Every element that is revealed carries an id: base, rivers, town-<id>, route-<id>, label-<id>; doc.ts fades or draws them. */
export function mapSvg(): string {
  const sea = path([...COAST.map(([a, b]) => project(a, b)), project(LON1, LAT0 - 0.5), project(LON0, LAT0 - 0.5)]) + ' Z';
  const rivers = Object.entries(RIVERS).map(([id, r]) => {
    const [lx, ly] = project(r.at[0], r.at[1]);
    return `<path d="${path(r.pts.map(([a, b]) => project(a, b)))}" fill="none" stroke="#5f86a6" stroke-width="${id === 'po' ? 9 : 5}" stroke-linecap="round" opacity=".9"/><text x="${lx}" y="${ly}" fill="#7fa6c6" font-size="22" font-style="italic">${r.name}</text>`;
  }).join('');
  const towns = Object.entries(TOWNS).map(([id, [, , label]]) => {
    const [x, y] = pt(id), big = id === 'lodi';
    return `<g id="town-${id}"><circle cx="${x}" cy="${y}" r="${big ? 13 : 7}" fill="${big ? '#c9a24a' : '#e9e4d6'}" stroke="#111" stroke-width="2"/><text x="${x + 16}" y="${y + 7}" fill="#f3efe4" font-size="${big ? 36 : 25}" ${big ? 'font-weight="bold"' : ''} style="paint-order:stroke" stroke="#111" stroke-width="5">${label}</text></g>`;
  }).join('');
  const routes = Object.entries(ROUTES).map(([id, r]) => {
    const [lx, ly] = project(r.at[0], r.at[1]);
    return `<path id="route-${id}" d="${path(r.pts.map(pt))}" fill="none" stroke="${r.color}" stroke-width="${r.width}" stroke-linecap="round" stroke-linejoin="round" ${r.dash ? 'data-dash="1"' : ''}/><text id="label-${id}" x="${lx}" y="${ly}" fill="${r.color}" font-size="26" style="paint-order:stroke" stroke="#111" stroke-width="5">${r.label}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#1b2128"/><g id="base"><path d="${sea}" fill="#151c25"/><text x="${project(8.3, 43.98)[0]}" y="${project(8.3, 43.98)[1]}" fill="#4d6378" font-size="30" font-style="italic" letter-spacing="6">LIGURIAN SEA</text></g><g id="rivers">${rivers}</g>${routes}<g id="towns">${towns}</g></svg>`;
}
