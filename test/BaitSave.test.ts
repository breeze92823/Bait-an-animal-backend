import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { CURRENCY_MAX } from "../src/constants.js";
import { SAVE_LIMITS, sanitizeSave } from "../src/baitSave.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { __setPlayersForTest } from "../src/db.js";
import { fakePlayers, sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("sanitizeSave (Bait an Animal game state)", () => {
  it("rejects non-objects and bounds the numbers", () => {
    assert.strictEqual(sanitizeSave(null), null);
    assert.strictEqual(sanitizeSave([1]), null);
    const now = 1_000_000;
    const out = sanitizeSave({ money: 1e40, earned: -3, catches: 4.8, offerEnds: 9e15, hack: 1, baitReady: "yes" }, now)!;
    assert.strictEqual(out.money, CURRENCY_MAX);
    assert.strictEqual(out.earned, 0);
    assert.strictEqual(out.catches, 4);
    assert.strictEqual(out.offerEnds, now + SAVE_LIMITS.futureMs);
    assert.ok(!("hack" in out));
    assert.ok(!("baitReady" in out));
  });

  it("keeps well-formed baits, animals, passes and pets", () => {
    const out = sanitizeSave({
      machine: { p: 7.6, xp: 12.5 },
      baits: [0, 3, "x", 4.2, NaN],
      animals: [
        { uid: 1, species: "fox", shiny: true },
        { uid: 1, species: "bunny" },
        { uid: 2, species: "Bad Id!" },
        { uid: 3, species: "cow", shiny: "no" },
      ],
      passes: { x2cash: true, x2luck: false, "bad key": true, autoClick: 1 },
      pets: { owned: ["dino", "chick", "dino"], equipped: ["chick", "mammoth"] },
      index: { fox: { n: 3, shiny: true }, cow: { n: "2" } },
      up: { mult: 3, xp: -1 },
      auto: [{ p: 2, xp: 1, ready: true }, "x", { p: -4 }],
      best: { species: "fox", shiny: true },
      gym: { owned: true, level: 3, strength: 120.5, junk: "x" },
    })!;
    assert.deepStrictEqual(out.machine, { p: 7, xp: 12.5 });
    assert.deepStrictEqual(out.baits, [0, 3, 4]);
    assert.deepStrictEqual(out.animals, [
      { uid: 1, species: "fox", shiny: true },
      { uid: 3, species: "cow", shiny: false },
    ]);
    assert.deepStrictEqual(out.passes, { x2cash: true, x2luck: false });
    assert.deepStrictEqual(out.pets, { owned: ["dino", "chick"], equipped: ["chick"] }, "only owned pets stay equipped");
    assert.deepStrictEqual(out.index, { fox: { n: 3, shiny: true } });
    assert.deepStrictEqual(out.up, { mult: 3, xp: 0 });
    assert.deepStrictEqual(out.auto, [{ p: 2, xp: 1, ready: true }, { p: 0, xp: 0, ready: false }]);
    assert.deepStrictEqual(out.best, { species: "fox", shiny: true });
    assert.deepStrictEqual(out.gym, { owned: true, level: 3, strength: 120.5 });
  });

  it("keeps a full Pet Index (the client has 63 species)", () => {
    const species = Array.from({ length: 63 }, (_, i) => `animal${i}`);
    const index = Object.fromEntries(species.map((id) => [id, { n: 1, shiny: false }]));
    const claimed = Object.fromEntries(species.map((id) => [id, true]));
    const out = sanitizeSave({ index, claimed })!;
    assert.strictEqual(Object.keys(out.index as object).length, 63);
    assert.strictEqual(Object.keys(out.claimed as object).length, 63);
  });

  it("keeps every key the client's default state has (claimed Index rewards, the waiting Next Shot)", () => {
    const out = sanitizeSave({ claimed: { fox: true, cow: false, "bad key": true, bear: 1 }, nextShot: true })!;
    assert.deepStrictEqual(out.claimed, { fox: true, cow: false });
    assert.strictEqual(out.nextShot, true);
    assert.strictEqual(sanitizeSave({ nextShot: "yes" })!.nextShot, undefined);
  });

  it("keeps the tutorial step (so a finished or skipped tutorial never shows again)", () => {
    assert.strictEqual(sanitizeSave({ tutorial: 100 })!.tutorial, 100);
    assert.strictEqual(sanitizeSave({ tutorial: 2.7 })!.tutorial, 2);
    assert.strictEqual(sanitizeSave({ tutorial: -5 })!.tutorial, 0);
    assert.strictEqual(sanitizeSave({ tutorial: "done" })!.tutorial, undefined);
  });
});

describe("game save over the room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());
  afterEach(() => __setPlayersForTest(null));

  it("stores the sanitized save and sends it back on the next join", async () => {
    const fake = fakePlayers();
    __setPlayersForTest(fake);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const c = await colyseus.connectTo(room, { token: "t-b1", username: "Ann" });
    c.onMessage("noProgress", () => {});
    fake.release();
    await sleep(150);
    c.send("saveProgress", { save: { money: 500, passes: { x2luck: true }, packBought: true, animals: [{ uid: 1, species: "bear" }] } });
    await sleep(150);
    const doc = fake.docs.get("b1") as any;
    assert.strictEqual(doc.save.money, 500);
    assert.strictEqual(doc.save.passes.x2luck, true);

    await c.leave();
    await sleep(100);
    // A later session: the stored doc is read back (a gated fake, so the handler is in place first).
    const later = fakePlayers([doc]);
    __setPlayersForTest(later);
    const room2 = await colyseus.createRoom<WorldState>("world", {});
    const again = await colyseus.connectTo(room2, { token: "t-b1" });
    let got: any = null;
    again.onMessage("progress", (m: any) => (got = m));
    later.release();
    await sleep(150);
    assert.strictEqual(got?.save?.money, 500);
    assert.strictEqual(got?.save?.packBought, true);
    assert.deepStrictEqual(got?.save?.animals, [{ uid: 1, species: "bear", shiny: false }]);
  });
});
