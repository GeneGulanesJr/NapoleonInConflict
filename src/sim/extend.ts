// A scenario can build on another: its small JSON names a base with `extends` and overrides only what differs (map, forces, zones and the rest come from the base).
export const extend = (base: any, patch: any) => { const { extends: _base, ...own } = patch; return { ...base, ...own }; };
/** Resolves a raw scenario against `load`, which fetches the raw JSON of a base by id (for node scripts; the browser imports and extends directly). */
export const resolve = (raw: any, load: (id: string) => any): any => (raw.extends ? extend(resolve(load(raw.extends), load), raw) : raw);
