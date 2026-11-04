// A scenario can build on another: its small JSON names a base with `extends` and overrides only what differs (map, forces, zones and the rest come from the base).
import { scaleScenario } from './skirmish.ts';

export const extend = (base: any, patch: any) => { const { extends: _base, ...own } = patch; return { ...base, ...own }; };
/** The finished scenario: a JSON with `scale` has its whole map stretched by that factor (see scaleScenario), once, after any `extends` has merged: what a derived scenario overrides is written in its base's frame. */
export const prepare = (j: any) => { if (!j.scale) return j; const { scale, ...rest } = structuredClone(j); return scaleScenario(rest, scale); };
const merge = (raw: any, load: (id: string) => any): any => (raw.extends ? extend(merge(load(raw.extends), load), raw) : raw);
/** Resolves a raw scenario against `load`, which fetches the raw JSON of a base by id (for node scripts; the browser imports its JSON and uses extend + prepare). */
export const resolve = (raw: any, load: (id: string) => any): any => prepare(merge(raw, load));
