// Calls from this server to the Boxity platform (https://docs.bloxity.io): who a player is (their
// game token, verified), whether a rewarded ad really played, and where to report leaderboards,
// stats and rooms. Every URL comes from the environment Boxity hosting injects (BLOXITY_API_URL,
// BLOXITY_GAME_ID, BLOXITY_REPORT_TOKEN, MATCHMAKER_REPORT_URL), with the prod fallbacks only when
// nothing was told. Nothing here throws: a failed call means "not verified".
import { GAME_SLUG } from "./constants.js";

export const boxity = {
  apiUrl: () => (process.env.BLOXITY_API_URL || "https://api.bloxity.io").replace(/\/$/, ""),
  // The hosting id (= the game's slug) the platform files this game under.
  gameId: () => process.env.BLOXITY_GAME_ID || GAME_SLUG,
  reportToken: () => process.env.BLOXITY_REPORT_TOKEN || "",
};

// The platform identity of a player: the leaderboard / stats / directory key is "legion_<id>".
export const legionId = (accountId: string) => `legion_${accountId.replace(/#m.*$/, "")}`;

export type VerifiedUser = { id: string; username: string; displayName: string; pfp: string; outfitKey: string };

let fetcher: typeof fetch = (...args) => fetch(...args);
// Test seam: a fake verifier (token -> user or null) instead of the platform.
let verifyOverride: ((token: string) => Promise<VerifiedUser | null>) | null = null;
let rewardOverride: ((token: string) => Promise<{ valid: boolean; userId?: string | null; placement?: string }>) | null = null;

const str = (v: unknown, max = 512) => (typeof v === "string" ? v.slice(0, max) : "");

// Server identity (REQUIRED): POST {apiUrl}/v1/auth/game-token/verify with the player's Boxity
// token. Only the returned user._id is ever used as an account id. null = guest (no token, refused,
// or the platform could not be reached): never fall back to an id the client sent.
export async function verifyGameToken(token: unknown): Promise<VerifiedUser | null> {
  if (typeof token !== "string" || !token || token.length > 8192) return null;
  if (verifyOverride) return verifyOverride(token);
  try {
    const res = await fetcher(`${boxity.apiUrl()}/v1/auth/game-token/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ gameSlug: GAME_SLUG }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { user?: Record<string, unknown> };
    const u = body?.user;
    const id = str(u?._id, 128);
    if (!id) return null;
    return { id, username: str(u?.username, 64), displayName: str(u?.displayName, 64), pfp: str(u?.pfp), outfitKey: str(u?.outfitKey, 2048) };
  } catch (err) {
    console.warn("[boxity] token verify failed", (err as Error)?.message ?? err);
    return null;
  }
}

// Rewarded ads: POST {apiUrl}/v1/ads/reward/verify { gameSlug, rewardToken }. Each token verifies
// once, for this game, within 5 minutes of the ad. Grant only on valid: true.
export async function verifyAdReward(rewardToken: unknown): Promise<{ valid: boolean; userId: string | null; placement: string }> {
  const none: { valid: boolean; userId: string | null; placement: string } = { valid: false, userId: null, placement: "" };
  if (typeof rewardToken !== "string" || !rewardToken || rewardToken.length > 4096) return none;
  try {
    const v = rewardOverride
      ? await rewardOverride(rewardToken)
      : ((await (
          await fetcher(`${boxity.apiUrl()}/v1/ads/reward/verify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ gameSlug: GAME_SLUG, rewardToken }),
            signal: AbortSignal.timeout(6000),
          })
        ).json()) as { valid?: boolean; userId?: string | null; placement?: string });
    return { valid: v?.valid === true, userId: typeof v?.userId === "string" ? v.userId : null, placement: str(v?.placement, 64) };
  } catch (err) {
    console.warn("[boxity] ad reward verify failed", (err as Error)?.message ?? err);
    return none;
  }
}

// POSTs a report with the hosting report token. Resolves to the parsed answer (logged by callers),
// or null when not deployed by Boxity or the call failed. Never throws.
export async function postReport(url: string, body: unknown, timeoutMs = 8000): Promise<unknown | null> {
  const token = boxity.reportToken();
  if (!token) return null;
  try {
    const res = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text.slice(0, 500) };
    }
  } catch (err) {
    console.warn("[boxity] report failed", url, (err as Error)?.message ?? err);
    return null;
  }
}

// Test-only seams.
export function __setFetchForTest(f: typeof fetch | null): void {
  fetcher = f ?? ((...args) => fetch(...args));
}
export function __setVerifyForTest(f: ((token: string) => Promise<VerifiedUser | null>) | null): void {
  verifyOverride = f;
}
export function __setAdRewardForTest(f: ((token: string) => Promise<{ valid: boolean; userId?: string | null; placement?: string }>) | null): void {
  rewardOverride = f;
}
