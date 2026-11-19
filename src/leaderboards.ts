// Boxity leaderboards and profile stats, reported from this server (docs.bloxity.io: Leaderboards,
// "Report your game's stats"). Every number comes from a save this server loaded or accepted
// (bounded by baitSave.ts), never straight from a client packet. Only verified accounts rank
// ("legion_<id>"); guests are skipped. Nothing is sent outside a Boxity deployment
// (no BLOXITY_REPORT_TOKEN), so local runs and tests stay offline.
//
// Boards (the client declares the same list with Legion.SDK.leaderboard.define so the trophy
// button shows; the first declaration creates a board, later edits happen in the dashboard):
//   earned   Money Earned    sum of cash earned, weekly + all time
//   catches  Animals Caught  sum of catches, weekly + all time
//   strength Strength        best, all time
//   index    Pet Index       best (species discovered), all time
// Stats (the player's Boxity profile, "Only in this game"): Cash, Animals Caught, Strength, Pet Index.
import { boxity, legionId, postReport } from "./boxity.js";

export const BOARDS = [
  { id: "earned", label: "Money Earned", order: "desc", mode: "sum", format: "compact", reset: "weekly" },
  { id: "catches", label: "Animals Caught", order: "desc", mode: "sum", format: "number", reset: "weekly" },
  { id: "strength", label: "Strength", order: "desc", mode: "best", format: "compact", reset: "none" },
  { id: "index", label: "Pet Index", order: "desc", mode: "best", format: "number", reset: "none" },
] as const;

export const STATS = [
  { key: "cash", label: "Cash", type: "currency", sortOrder: 1 },
  { key: "catches", label: "Animals Caught", type: "number", sortOrder: 2 },
  { key: "strength", label: "Strength", type: "number", sortOrder: 3 },
  { key: "pet_index", label: "Pet Index", type: "number", sortOrder: 4 },
] as const;
// Above these the stats endpoint REJECTS a value (a clamped one would become a permanent max).
const STAT_CEILING = { number: 1e9, currency: 1e12 } as const;

export const LEADERBOARD_EVERY_MS = 15_000;
export const STATS_EVERY_MS = 60_000;
const BATCH = 200;

export type Totals = { money: number; earned: number; catches: number; strength: number; index: number };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

// The numbers the boards and stats read from a (sanitized) save.
export function totalsOf(save: Record<string, unknown> | null | undefined): Totals {
  const s = save ?? {};
  const gym = (s.gym ?? {}) as Record<string, unknown>;
  const index = (s.index ?? {}) as Record<string, { n?: unknown }>;
  return {
    money: num(s.money),
    earned: num(s.earned),
    catches: num(s.catches),
    strength: num(gym.strength),
    index: Object.values(index).filter((e) => num(e?.n) > 0).length,
  };
}

// --- Leaderboards ---------------------------------------------------------------------------
// legion id -> what to send next: sums are added up until flushed, bests are the latest value.
const pending = new Map<string, { earned: number; catches: number; strength: number | null; index: number | null }>();
const lastBest = new Map<string, { strength: number; index: number }>();

// A verified player's save moved from `prev` (the one loaded / last accepted this session; null for
// an account with no save yet) to `next`: queue what they gained.
export function recordProgress(accountId: string, prev: Totals | null, next: Totals): void {
  if (!accountId) return;
  const id = legionId(accountId);
  const p = pending.get(id) ?? { earned: 0, catches: 0, strength: null, index: null };
  p.earned += Math.max(0, next.earned - (prev?.earned ?? 0));
  p.catches += Math.max(0, next.catches - (prev?.catches ?? 0));
  const best = lastBest.get(id);
  if (next.strength > 0 && next.strength !== best?.strength) p.strength = next.strength;
  if (next.index > 0 && next.index !== best?.index) p.index = next.index;
  pending.set(id, p);
  stats.set(id, next);
}

export async function flushLeaderboards(): Promise<void> {
  if (!boxity.reportToken() || !pending.size) return;
  const scores: { board: string; userId: string; score: number }[] = [];
  for (const [userId, p] of pending) {
    if (p.earned > 0) scores.push({ board: "earned", userId, score: p.earned });
    if (p.catches > 0) scores.push({ board: "catches", userId, score: p.catches });
    if (p.strength !== null) scores.push({ board: "strength", userId, score: p.strength });
    if (p.index !== null) scores.push({ board: "index", userId, score: p.index });
    const b = lastBest.get(userId) ?? { strength: 0, index: 0 };
    if (p.strength !== null) b.strength = p.strength;
    if (p.index !== null) b.index = p.index;
    lastBest.set(userId, b);
  }
  pending.clear();
  const url = `${boxity.apiUrl()}/v1/leaderboards/hosted/${encodeURIComponent(boxity.gameId())}/report`;
  for (let i = 0; i < scores.length; i += BATCH) {
    const res = await postReport(url, { boards: BOARDS, scores: scores.slice(i, i + BATCH) });
    if (res) console.log("[leaderboards] report", JSON.stringify(res).slice(0, 400));
  }
}

// --- Profile stats ----------------------------------------------------------------------------
// legion id -> the player's current totals (from their latest accepted save). Players who left
// stay until the next flush has sent their final values.
const stats = new Map<string, Totals>();
const leftSinceFlush = new Set<string>();

export function trackStats(accountId: string, totals: Totals): void {
  if (accountId) stats.set(legionId(accountId), totals);
}
export function forgetStats(accountId: string): void {
  if (accountId) leftSinceFlush.add(legionId(accountId));
}

const valid = (v: number, type: keyof typeof STAT_CEILING) => Number.isFinite(v) && v >= 0 && v <= STAT_CEILING[type];

export async function flushStats(): Promise<void> {
  if (!boxity.reportToken() || !stats.size) return;
  const players: { userId: string; values: Record<string, number> }[] = [];
  for (const [userId, t] of stats) {
    const values: Record<string, number> = {};
    if (valid(t.money, "currency")) values.cash = Math.floor(t.money);
    if (valid(t.catches, "number")) values.catches = Math.floor(t.catches);
    if (valid(t.strength, "number")) values.strength = Math.floor(t.strength);
    if (valid(t.index, "number")) values.pet_index = t.index;
    if (Object.keys(values).length) players.push({ userId, values });
  }
  for (const id of leftSinceFlush) stats.delete(id);
  leftSinceFlush.clear();
  const url = `${boxity.apiUrl()}/v1/games/${encodeURIComponent(boxity.gameId())}/stats`;
  for (let i = 0; i < players.length; i += BATCH) {
    const res = await postReport(url, { definitions: STATS, players: players.slice(i, i + BATCH) });
    if (res) console.log("[stats] report", JSON.stringify(res).slice(0, 400));
  }
}

// --- Timers ------------------------------------------------------------------------------------
let timers: NodeJS.Timeout[] = [];
export function installScoreReporters(): void {
  if (!boxity.reportToken() || timers.length) return;
  timers = [setInterval(() => void flushLeaderboards(), LEADERBOARD_EVERY_MS), setInterval(() => void flushStats(), STATS_EVERY_MS)];
  for (const t of timers) t.unref();
  console.log("[boxity] reporting leaderboards every 15s and profile stats every 60s");
}
// On shutdown / drain: send what is queued, or up to a full interval of progress is lost.
export async function flushScores(): Promise<void> {
  await Promise.allSettled([flushLeaderboards(), flushStats()]);
}

// Test-only.
export function __pendingForTest() {
  return { pending, stats };
}
export function __resetScoresForTest(): void {
  pending.clear();
  lastBest.clear();
  stats.clear();
  leftSinceFlush.clear();
}
