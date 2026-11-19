import { Room, Client, CloseCode } from "colyseus";
import { WorldState, PlayerState } from "./schema/WorldState.js";
import {
  FX_MAX_LEN,
  FX_PER_SECOND,
  GUEST_ID_PREFIX,
  HOOK_MAX_LEN,
  LOOK_MAX_LEN,
  MACH_MAX_LEN,
  NAME_MAX,
  PEN_MAX_LEN,
  PFP_MAX_LEN,
  PLOT_COUNT,
  POS_MAX,
  RECONNECT_SECONDS,
  ROOM_MAX_CLIENTS,
  SPEED_MAX,
} from "../constants.js";
import { getPlayers, type PlayerDoc } from "../db.js";
import { sanitizeSave } from "../baitSave.js";
import { verifyAdReward, verifyGameToken, type VerifiedUser } from "../boxity.js";
import { forgetStats, recordProgress, totalsOf, trackStats, type Totals } from "../leaderboards.js";

// What the rewarded ad grants (the client applies it once the server has checked the ad's token).
export const AD_REWARD = { potion: "cash", minutes: 10 } as const;

function sanitizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.slice(0, NAME_MAX) : "";
}

function sanitizePfp(raw: unknown): string {
  return typeof raw === "string" && raw.length <= PFP_MAX_LEN && /^https?:\/\//i.test(raw) ? raw : "";
}

// A finite number clamped to +-max, or null (the field is left as it was).
function num(raw: unknown, max: number): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(-max, Math.min(max, raw)) : null;
}

// A relayed JSON blob (look, pen, machines, hook): a string under `max` that parses as JSON. The
// server never reads inside it; it is visual state for the other clients, which parse it defensively.
function blob(raw: unknown, max: number): string | null {
  if (typeof raw !== "string" || raw.length > max) return null;
  if (raw === "") return "";
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return null;
  }
}

// `fx` event types the clients may relay to each other (client remote.js plays them on the
// sender's plot): bait machine pump / level up / claim, Auto Machine tank claim, pass and
// machine purchases, the harpoon (arm, disarm, fire, the catch delivered) and training reps.
// Emotes (Boxity's picker plays them on the sender; replicated here): emote { id }, emoteStop.
const FX_TYPES = new Set(["pump", "level", "claim", "claimAuto", "bought", "arm", "disarm", "fire", "caught", "rep", "emote", "emoteStop"]);

/**
 * Room every client joins via `client.joinOrCreate("world", { userId, username, pfp })`. Loads and
 * saves each signed-in player's game state (MongoDB, see db.ts): the client's whole state `S`
 * rides in `saveProgress { save }` and comes back as `progress { save }`. The game is
 * client-authoritative: no gameplay rules live here, saves are only bounded (baitSave.ts).
 *
 * Presence: one room = one hub of PLOT_COUNT plots, one player each (maxClients = PLOT_COUNT; the
 * Bloxity matchmaker fills a room, then starts the next). Each player gets a `plot` and streams
 * their character (`move`), Bloxity look (`look`) and base display (`base`) into the roster, plus
 * one-off effects (`fx`, relayed to the others). All of it is visual, only bounded here.
 */
export class WorldRoom extends Room<{ state: WorldState }> {
  state = new WorldState();
  maxClients = ROOM_MAX_CLIENTS;

  // sessionId -> user id (Bloxity id). Deliberately NOT part of WorldState: it only gates this
  // room's own Mongo reads/writes. Guests have no entry.
  userIds = new Map<string, string>();

  // sessionIds that already got a progress/noProgress answer for their current identity.
  private identified = new Set<string>();
  // sessionIds whose current identity's save has been read: only these may write. A save sent
  // before the load answered would overwrite the stored progress with a fresh player's defaults.
  private loaded = new Set<string>();
  // sessionId -> [window start ms, fx events in it]: the per-player `fx` rate limit.
  private fxRate = new Map<string, [number, number]>();
  // sessionId -> the totals of the save loaded / last accepted this session (leaderboard deltas).
  private totals = new Map<string, Totals | null>();
  // sessionId -> the outfit key Boxity verified with the player's token (preferred over the client's).
  private outfits = new Map<string, string>();
  // sessionIds with a rewarded-ad check in flight (one at a time).
  private adChecks = new Set<string>();

  messages = {
    // Debounced push of the client's whole game state: { save }. Upserts, so a first save creates
    // the document.
    saveProgress: async (client: Client, msg: { save?: unknown }) => {
      const p = this.state.players.get(client.sessionId);
      const save = sanitizeSave(msg?.save);
      if (!p || !save || !this.loaded.has(client.sessionId)) return;

      const userId = this.userIds.get(client.sessionId);
      if (!userId) return;
      // Leaderboards + profile stats, from the save this server just accepted (never the raw packet).
      const next = totalsOf(save as Record<string, unknown>);
      recordProgress(userId, this.totals.get(client.sessionId) ?? null, next);
      this.totals.set(client.sessionId, next);
      const players = getPlayers();
      if (!players) return; // Mongo unset/unreachable -- degrade silently
      try {
        await players.updateOne(
          { _id: userId },
          {
            // Display name comes from this connection's own PlayerState, not `msg`.
            $set: { save, username: p.username || "Player", updatedAt: new Date() },
            $setOnInsert: { version: 1 },
          },
          { upsert: true },
        );
      } catch (err) {
        console.warn("[WorldRoom] saveProgress failed", err);
      }
    },
    // Presence: the character's position / facing / gait (own frame), plus the hooked catch's
    // mouth while it is reeled in. ~10 per second; non-numbers are ignored field by field.
    move: (client: Client, msg: Record<string, unknown>) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !msg || typeof msg !== "object") return;
      const set = (key: "x" | "y" | "z" | "yaw" | "speed" | "vy" | "hx" | "hy" | "hz", max: number) => {
        const v = num(msg[key], max);
        if (v !== null) p[key] = v;
      };
      set("x", POS_MAX);
      set("y", POS_MAX);
      set("z", POS_MAX);
      set("yaw", 100);
      set("speed", SPEED_MAX);
      set("vy", SPEED_MAX);
      set("hx", POS_MAX);
      set("hy", POS_MAX);
      set("hz", POS_MAX);
      if (typeof msg.grounded === "boolean") p.grounded = msg.grounded;
    },
    // The Bloxity look: { look: '{"k": outfitKey, "e": equipped, "p": proportions}' }.
    look: (client: Client, msg: { look?: unknown }) => {
      const p = this.state.players.get(client.sessionId);
      let look = blob(msg?.look, LOOK_MAX_LEN);
      if (!p || look === null) return;
      // The platform-verified outfit key wins over the one the client sent.
      const verified = this.outfits.get(client.sessionId);
      if (look && verified) {
        const parsed = JSON.parse(look) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") look = JSON.stringify({ ...parsed, k: verified });
        if (look.length > LOOK_MAX_LEN) return;
      }
      p.look = look;
    },
    // What the player's base shows: { pen?, mach?, hook? } (JSON strings, see WorldState.ts).
    base: (client: Client, msg: { pen?: unknown; mach?: unknown; hook?: unknown }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !msg) return;
      const pen = blob(msg.pen, PEN_MAX_LEN);
      if (pen !== null) p.pen = pen;
      const mach = blob(msg.mach, MACH_MAX_LEN);
      if (mach !== null) p.mach = mach;
      const hook = blob(msg.hook, HOOK_MAX_LEN);
      if (hook !== null) p.hook = hook;
    },
    // A one-off effect on the sender's plot (FX_TYPES), relayed to everyone else as
    // fx { s: sessionId, t, d }. Rate-limited per player; oversized payloads are dropped.
    fx: (client: Client, msg: { t?: unknown; d?: unknown }) => {
      if (!this.state.players.has(client.sessionId)) return;
      if (typeof msg?.t !== "string" || !FX_TYPES.has(msg.t)) return;
      const now = Date.now();
      const rate = this.fxRate.get(client.sessionId);
      if (!rate || now - rate[0] >= 1000) this.fxRate.set(client.sessionId, [now, 1]);
      else if (++rate[1] > FX_PER_SECOND) return;
      let d: unknown = null;
      if (msg.d !== undefined) {
        try {
          if (JSON.stringify(msg.d).length > FX_MAX_LEN) return;
        } catch {
          return;
        }
        d = msg.d;
      }
      this.broadcast("fx", { s: client.sessionId, t: msg.t, d }, { except: client });
    },
    // Re-states identity after a login/logout that happens AFTER join (a guest who signs in
    // mid-session). The server answers with progress/noProgress for the new identity.
    // { token?, username?, pfp? }: the new Boxity token is verified; only its user._id counts.
    identify: async (client: Client, msg: { username?: string; token?: string; pfp?: string }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      if (typeof msg?.username === "string") p.username = sanitizeName(msg.username);
      if (typeof msg?.pfp === "string") p.pfp = sanitizePfp(msg.pfp);
      if (!msg || !("token" in msg)) return;
      const user = await verifyGameToken(msg.token);
      if (this.state.players.get(client.sessionId) !== p) return; // left while verifying
      this.setIdentity(client, p, user);
    },
    // Rewarded ad watched: { rewardToken } from Legion.SDK.ads.showRewarded. Boxity checks the token
    // (once, this game only, within 5 min); only then is the reward granted: adReward { ok, ... }.
    adReward: async (client: Client, msg: { rewardToken?: unknown }) => {
      if (!this.state.players.has(client.sessionId) || this.adChecks.has(client.sessionId)) return;
      this.adChecks.add(client.sessionId);
      try {
        const v = await verifyAdReward(msg?.rewardToken);
        const me = this.userIds.get(client.sessionId) || null;
        // A token issued to another signed-in account is not this player's to spend.
        const ok = v.valid && (!v.userId || !me || v.userId === me);
        client.send("adReward", ok ? { ok: true, ...AD_REWARD } : { ok: false });
      } finally {
        this.adChecks.delete(client.sessionId);
      }
    },
  };

  // Server identity: the join's Boxity token (Legion.SDK.auth.getToken()) is verified with the
  // platform; only the returned user._id is an account. No token / refused = a guest. A userId in
  // the join options is never trusted. The result lands in client.auth.
  async onAuth(_client: Client, options: { token?: unknown }) {
    return { user: await verifyGameToken(options?.token) };
  }

  onJoin(client: Client, options?: { username?: string; pfp?: string }) {
    const p = new PlayerState();
    p.username = sanitizeName(options?.username);
    p.pfp = sanitizePfp(options?.pfp);
    p.plot = this.freePlot();
    this.state.players.set(client.sessionId, p);
    this.setIdentity(client, p, (client.auth as { user?: VerifiedUser | null } | undefined)?.user ?? null);
  }

  // A deliberate `room.leave()` closes with CONSENTED -- drop the player at once. Anything
  // else (WiFi blip, backgrounded tab) gets RECONNECT_SECONDS to reconnect with the same session.
  async onLeave(client: Client, code?: number) {
    if (code === CloseCode.CONSENTED) {
      this.forgetSession(client.sessionId);
      return;
    }
    try {
      await this.allowReconnection(client, RECONNECT_SECONDS);
    } catch {
      this.forgetSession(client.sessionId);
    }
  }

  // The lowest plot nobody in the room holds (a reconnecting player keeps theirs: their
  // PlayerState stays in the map during allowReconnection). maxClients = PLOT_COUNT, so there is
  // always one; -1 only if the two ever drift apart.
  private freePlot(): number {
    const taken = new Set<number>();
    this.state.players.forEach((pl) => taken.add(pl.plot));
    for (let i = 0; i < PLOT_COUNT; i++) if (!taken.has(i)) return i;
    return -1;
  }

  // Drops a session's per-connection bookkeeping (its plot is free again).
  private forgetSession(sessionId: string) {
    forgetStats(this.userIds.get(sessionId) ?? "");
    this.totals.delete(sessionId);
    this.outfits.delete(sessionId);
    this.adChecks.delete(sessionId);
    this.state.players.delete(sessionId);
    this.userIds.delete(sessionId);
    this.identified.delete(sessionId);
    this.loaded.delete(sessionId);
    this.fxRate.delete(sessionId);
  }

  // The player's VERIFIED Boxity identity (null = guest: nothing is loaded or saved for them).
  // Called from both onJoin and `identify`; answers with progress / noProgress / serverError.
  private setIdentity(client: Client, p: PlayerState, user: VerifiedUser | null) {
    let userId = user?.id.slice(0, 128) ?? "";
    if (userId.startsWith(GUEST_ID_PREFIX)) userId = "";
    p.uid = userId;
    if (user) {
      const name = sanitizeName(user.displayName || user.username);
      if (name) p.username = name;
      const pfp = sanitizePfp(user.pfp);
      if (pfp) p.pfp = pfp;
    }
    if (user?.outfitKey) this.outfits.set(client.sessionId, user.outfitKey);
    else this.outfits.delete(client.sessionId);
    const prev = this.userIds.get(client.sessionId) || "";
    // No change (e.g. a username-only identify) -- but the very first call must still answer.
    if (userId === prev && this.identified.has(client.sessionId)) return;
    this.identified.add(client.sessionId);
    this.loaded.delete(client.sessionId); // no writes until the new identity's save is read
    p.signedIn = !!userId;

    if (userId) {
      // Evict any OTHER live session already claiming this account, so one account never has
      // two racing Mongo writers (a crashed tab lingers up to RECONNECT_SECONDS via
      // allowReconnection in onLeave).
      for (const [sid, uid] of this.userIds) {
        if (sid === client.sessionId || uid !== userId) continue;
        this.forgetSession(sid);
        const stale = this.clients.find((c) => c.sessionId === sid);
        if (stale) {
          try {
            stale.leave(CloseCode.CONSENTED);
          } catch {
            // Already gone -- nothing to clean up.
          }
        }
      }
      this.userIds.set(client.sessionId, userId);
    } else {
      // No identity: stop persisting for this connection. (The client flushes a final
      // saveProgress under the OLD id before sending `identify`.)
      this.userIds.delete(client.sessionId);
    }

    void this.loadProgress(client, userId, p);
  }

  // Sends the saved game state to just this client so it can hydrate ("progress" { save }), or
  // "noProgress" when there is nothing to load (new account, guest, or Mongo unset). A failed read
  // sends "serverError" and keeps saving off, so a save that could not be read is never overwritten.
  private async loadProgress(client: Client, userId: string, p: PlayerState) {
    const players = getPlayers();
    let doc: PlayerDoc | null = null;
    if (userId && players) {
      try {
        doc = await players.findOne({ _id: userId });
      } catch (err) {
        console.warn("[WorldRoom] loadProgress failed", err);
        client.send("serverError", {});
        return;
      }
    }
    // The player may have left, or switched identity again, while the read was in flight.
    if (this.state.players.get(client.sessionId) !== p || (this.userIds.get(client.sessionId) ?? "") !== userId) return;

    this.loaded.add(client.sessionId);
    const now = Date.now();
    const save = sanitizeSave(doc?.save, now);
    // Leaderboard baseline: progress made before this session was already counted.
    const base = save ? totalsOf(save as Record<string, unknown>) : null;
    this.totals.set(client.sessionId, base);
    if (userId && base) trackStats(userId, base);
    if (save) client.send("progress", { save, serverTime: now });
    else client.send("noProgress", { serverTime: now });
  }
}
