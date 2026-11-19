import { CURRENCY_MAX, ID_PATTERN } from "./constants.js";

// Bait an Animal's whole save (client src/game.js state `S`), carried by `saveProgress` as `save`
// and stored as the doc's `save` field. Client-authoritative like the rest: only shape and bounds
// are enforced, so a malformed or forged payload can never corrupt the sender's document.
// Unknown keys are dropped; missing ones are left out (the client fills its defaults).

export const SAVE_LIMITS = {
  baitLevel: 10_000, // overall bait level index p
  baits: 12, // carried baits (client BAITS.carryMax = 6)
  animals: 64, // pen animals (client UPGRADES.slot.max = 12)
  ids: 128, // keys of the id maps (index / claimed per species: the client has 63, passes, pets, upgrades)
  equipped: 8, // pets equipped at once (client PETS.equipMax)
  upgradeLevel: 10_000,
  count: 1e12, // catches, index counts
  futureMs: 366 * 24 * 3600 * 1000, // timers (potions, offers) at most this far ahead
  uid: 1e12,
} as const;

// The extra numbers a game system keeps (e.g. the training ring) are bounded generically.
const NESTED_KEYS_MAX = 16;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isId = (v: unknown): v is string => typeof v === "string" && ID_PATTERN.test(v);
const num = (v: number, max: number) => Math.min(max, Math.max(0, v));
const int = (v: number, max: number) => Math.min(max, Math.max(0, Math.floor(v)));
const ids = (raw: unknown, max: number) => (Array.isArray(raw) ? [...new Set(raw.filter(isId))].slice(0, max) : []);

// { id: number } maps (upgrade levels): slug keys, whole bounded values.
function levels(raw: unknown, max: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= SAVE_LIMITS.ids) break;
    if (isId(k) && finite(v)) out[k] = int(v, max);
  }
  return out;
}
// { id: boolean } maps (passes).
function flags(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= SAVE_LIMITS.ids) break;
    if (isId(k) && typeof v === "boolean") out[k] = v;
  }
  return out;
}
// { id: epoch ms } timers (potion end times).
function timers(raw: unknown, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= SAVE_LIMITS.ids) break;
    if (isId(k) && finite(v)) out[k] = int(v, now + SAVE_LIMITS.futureMs);
  }
  return out;
}
// A small flat object of numbers / booleans (a game system's own state, e.g. `gym`).
function flat(raw: unknown): Obj | undefined {
  if (!isObj(raw)) return undefined;
  const out: Obj = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= NESTED_KEYS_MAX) break;
    if (!isId(k)) continue;
    if (typeof v === "boolean") out[k] = v;
    else if (finite(v)) out[k] = num(v, CURRENCY_MAX);
  }
  return out;
}
const animal = (a: unknown) =>
  isObj(a) && isId(a.species) && finite(a.uid) ? { uid: int(a.uid, SAVE_LIMITS.uid), species: a.species, shiny: a.shiny === true } : null;

export function sanitizeSave(raw: unknown, now = Date.now()): Obj | null {
  if (!isObj(raw)) return null;
  const out: Obj = { v: 1 };
  const money = (k: string) => finite(raw[k]) && (out[k] = num(raw[k] as number, CURRENCY_MAX));
  const count = (k: string) => finite(raw[k]) && (out[k] = int(raw[k] as number, SAVE_LIMITS.count));
  const bool = (k: string) => typeof raw[k] === "boolean" && (out[k] = raw[k]);
  const time = (k: string) => finite(raw[k]) && (out[k] = int(raw[k] as number, now + SAVE_LIMITS.futureMs));

  money("money");
  money("earned");
  count("catches");
  count("selected");
  bool("baitReady");
  bool("indexSeen");
  bool("freeClaimed");
  bool("packBought");
  bool("nextShot"); // the bought Next Shot 100x Luck, waiting for the next throw
  time("offerEnds");
  time("packEnds");
  time("lastSeen");

  if (isObj(raw.machine) && finite(raw.machine.p) && finite(raw.machine.xp))
    out.machine = { p: int(raw.machine.p, SAVE_LIMITS.baitLevel), xp: num(raw.machine.xp, CURRENCY_MAX) };
  if (Array.isArray(raw.baits)) out.baits = raw.baits.filter(finite).slice(0, SAVE_LIMITS.baits).map((p) => int(p, SAVE_LIMITS.baitLevel));
  if (raw.up !== undefined) out.up = levels(raw.up, SAVE_LIMITS.upgradeLevel);
  if (raw.passes !== undefined) out.passes = flags(raw.passes);
  if (raw.potions !== undefined) out.potions = timers(raw.potions, now);
  // species -> true once its Pet Index reward is claimed (so it can't be claimed twice).
  if (raw.claimed !== undefined) out.claimed = flags(raw.claimed);
  if (Array.isArray(raw.auto))
    out.auto = raw.auto
      .slice(0, 3)
      .filter(isObj)
      .map((t) => ({ p: finite(t.p) ? int(t.p, SAVE_LIMITS.baitLevel) : 0, xp: finite(t.xp) ? num(t.xp, CURRENCY_MAX) : 0, ready: t.ready === true }));
  if (Array.isArray(raw.animals)) {
    const seen = new Set<number>();
    out.animals = raw.animals
      .map(animal)
      .filter((a): a is NonNullable<ReturnType<typeof animal>> => !!a && !seen.has(a.uid) && !!seen.add(a.uid))
      .slice(0, SAVE_LIMITS.animals);
  }
  if (isObj(raw.pets)) {
    const owned = ids(raw.pets.owned, SAVE_LIMITS.ids);
    out.pets = { owned, equipped: ids(raw.pets.equipped, SAVE_LIMITS.equipped).filter((id) => owned.includes(id)) };
  }
  if (isObj(raw.index)) {
    const index: Record<string, { n: number; shiny: boolean }> = {};
    for (const [k, e] of Object.entries(raw.index)) {
      if (Object.keys(index).length >= SAVE_LIMITS.ids) break;
      if (isId(k) && isObj(e) && finite(e.n)) index[k] = { n: int(e.n, SAVE_LIMITS.count), shiny: e.shiny === true };
    }
    out.index = index;
  }
  if (raw.best === null) out.best = null;
  else if (isObj(raw.best) && isId(raw.best.species)) out.best = { species: raw.best.species, shiny: raw.best.shiny === true };
  const gym = flat(raw.gym);
  if (gym) out.gym = gym;
  return out;
}
