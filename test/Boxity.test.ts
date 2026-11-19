import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { __setAdRewardForTest, __setFetchForTest } from "../src/boxity.js";
import { BOARDS, STATS, __pendingForTest, __resetScoresForTest, flushLeaderboards, flushStats, recordProgress, totalsOf } from "../src/leaderboards.js";
import { reportRoomsOnce, __setFetchForTest as __setRoomFetchForTest } from "../src/legion-room-reporter.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

// A fetch that records what it was sent and answers 200 { ok: true }.
function recordingFetch() {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ ok: true, accepted: 1, dropped: {} }), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}

describe("boxity integration", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
    __resetScoresForTest();
  });
  afterEach(() => {
    __setPlayersForTest(null);
    __setFetchForTest(null);
    __setRoomFetchForTest(null);
    __setAdRewardForTest(null);
    delete process.env.BLOXITY_REPORT_TOKEN;
    delete process.env.MATCHMAKER_REPORT_URL;
  });

  it("only a verified token makes an account; a userId in the join options is ignored", async () => {
    const fake = fakePlayers([{ _id: "victim", save: { v: 1, money: 999 }, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const forger = await colyseus.connectTo(room, { userId: "victim" });
    let leaked: any = null;
    forger.onMessage("progress", (m: any) => (leaked = m));
    forger.onMessage("noProgress", () => {});
    await sleep(150);
    assert.strictEqual(leaked, null, "a forged id never loads someone's save");
    const pf = room.state.players.get(forger.sessionId)!;
    assert.strictEqual(pf.signedIn, false);
    assert.strictEqual(pf.uid, "");
    forger.send("saveProgress", { save: { money: 0 } });
    await sleep(100);
    assert.strictEqual((fake.docs.get("victim") as any).save.money, 999, "nor overwrites it");

    const real = await colyseus.connectTo(room, { token: "t-victim" });
    let got: any = null;
    real.onMessage("progress", (m: any) => (got = m));
    fake.release();
    await sleep(150);
    assert.strictEqual(got?.save?.money, 999);
    assert.strictEqual(room.state.players.get(real.sessionId)!.uid, "victim", "the verified id is public for chat bubbles");

    const refused = await colyseus.connectTo(room, { token: "bogus" });
    refused.onMessage("noProgress", () => {});
    await sleep(100);
    assert.strictEqual(room.state.players.get(refused.sessionId)!.signedIn, false, "a refused token is a guest");
  });

  it("prefers the verified outfit key over the one the client sends", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { token: "t-outfit1" });
    c.onMessage("noProgress", () => {});
    await sleep(100);
    c.send("look", { look: JSON.stringify({ k: "o1_forged", e: null }) });
    await sleep(100);
    assert.strictEqual(JSON.parse(room.state.players.get(c.sessionId)!.look).k, "o1_verified");
  });

  it("grants the rewarded-ad reward only for a token Boxity accepts", async () => {
    __setAdRewardForTest(async (t) => ({ valid: t === "good", userId: null, placement: "cash" }));
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, {});
    const answers: any[] = [];
    c.onMessage("adReward", (m: any) => answers.push(m));
    c.onMessage("noProgress", () => {});
    await sleep(50);
    c.send("adReward", { rewardToken: "bad" });
    await sleep(80);
    c.send("adReward", { rewardToken: "good" });
    await sleep(80);
    c.send("adReward", {});
    await sleep(80);
    assert.deepStrictEqual(answers, [{ ok: false }, { ok: true, potion: "cash", minutes: 10 }, { ok: false }]);
  });

  it("queues leaderboard gains from accepted saves, from the loaded baseline", async () => {
    const fake = fakePlayers([{ _id: "lb1", save: { v: 1, earned: 1000, catches: 4, gym: { strength: 12 }, index: { cow: { n: 2, shiny: false } } }, version: 1, updatedAt: new Date() }]);
    __setPlayersForTest(fake);
    fake.release();
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { token: "t-lb1" });
    c.onMessage("progress", () => {});
    await sleep(150);
    c.send("saveProgress", { save: { earned: 1600, catches: 6, gym: { strength: 30 }, index: { cow: { n: 2, shiny: false }, fox: { n: 1, shiny: false } } } });
    await sleep(120);
    const p = __pendingForTest().pending.get("legion_lb1")!;
    assert.deepStrictEqual(p, { earned: 600, catches: 2, strength: 30, index: 2 }, "only what was gained this session sums");

    // A guest never ranks.
    const g = await colyseus.connectTo(room, {});
    g.onMessage("noProgress", () => {});
    await sleep(100);
    g.send("saveProgress", { save: { earned: 5e6 } });
    await sleep(100);
    assert.strictEqual(__pendingForTest().pending.size, 1);
  });

  it("reports boards and stats to Boxity only when deployed, batched, guests and bad values out", async () => {
    const { f, calls } = recordingFetch();
    __setFetchForTest(f);
    recordProgress("a1", null, totalsOf({ money: 5, earned: 50, catches: 3, gym: { strength: 2 }, index: { cow: { n: 1 } } }));
    await flushLeaderboards();
    assert.strictEqual(calls.length, 0, "no report token = local dev: nothing sent");

    process.env.BLOXITY_REPORT_TOKEN = "rt";
    process.env.BLOXITY_GAME_ID = "bait-an-animal";
    recordProgress("a1", null, totalsOf({ money: 2e12, earned: 50, catches: 3, gym: { strength: 2 }, index: { cow: { n: 1 } } }));
    await flushLeaderboards();
    await flushStats();
    delete process.env.BLOXITY_GAME_ID;
    const [lb, st] = calls;
    assert.match(lb.url, /\/v1\/leaderboards\/hosted\/bait-an-animal\/report$/);
    assert.strictEqual(lb.headers.authorization, "Bearer rt");
    assert.deepStrictEqual(lb.body.boards.map((b: any) => b.id), BOARDS.map((b) => b.id));
    const score = (id: string) => lb.body.scores.find((s: any) => s.board === id)?.score;
    assert.strictEqual(score("earned"), 100, "two recorded gains of 50 sum up");
    assert.strictEqual(score("strength"), 2);
    assert.ok(lb.body.scores.every((s: any) => s.userId === "legion_a1"));
    assert.match(st.url, /\/v1\/games\/bait-an-animal\/stats$/);
    assert.deepStrictEqual(st.body.definitions.map((d: any) => d.key), STATS.map((d) => d.key));
    assert.deepStrictEqual(st.body.players, [{ userId: "legion_a1", values: { catches: 3, strength: 2, pet_index: 1 } }], "cash above the currency ceiling is left out, not clamped");
  });

  it("pushes this pod's rooms to the matchmaker directory only when deployed", async () => {
    const { f, calls } = recordingFetch();
    __setRoomFetchForTest(f);
    assert.strictEqual(await reportRoomsOnce(), false, "local: no-op");
    process.env.BLOXITY_REPORT_TOKEN = "rt";
    process.env.MATCHMAKER_REPORT_URL = "https://mm.example/v1/dir/";
    const room = await colyseus.createRoom<WorldState>("world", {});
    await colyseus.connectTo(room, {});
    await sleep(50);
    assert.strictEqual(await reportRoomsOnce(), true);
    const body = calls[0].body;
    assert.strictEqual(calls[0].url, "https://mm.example/v1/dir/bait-an-animal/rooms");
    const listed = body.rooms.find((r: any) => r.colyseusRoomId === room.roomId);
    assert.strictEqual(listed.maxClients, 5);
    assert.strictEqual(listed.clients, 1);
  });
});
