import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/app.config.js";
import { PLOT_COUNT, POS_MAX, ROOM_MAX_CLIENTS } from "../src/constants.js";
import { WorldState } from "../src/rooms/schema/WorldState.js";
import { sleep } from "./fakePlayers.js";
import { testServer } from "./server.js";

describe("presence (plots, characters, bases)", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  before(async () => (colyseus = await testServer()));
  beforeEach(async () => await colyseus.cleanup());

  it("holds one player per plot and gives each a different plot", async () => {
    assert.strictEqual(ROOM_MAX_CLIENTS, PLOT_COUNT);
    const room = await colyseus.createRoom<WorldState>("world", {});
    const clients = [];
    for (let i = 0; i < PLOT_COUNT; i++) clients.push(await colyseus.connectTo(room, { userId: `guest-${i}`, username: `P${i}` }));
    await sleep(50);
    const plots = clients.map((c) => room.state.players.get(c.sessionId)!.plot).sort();
    assert.deepStrictEqual(plots, [0, 1, 2, 3, 4]);
    await assert.rejects(colyseus.connectTo(room, { userId: "guest-x" }), "a sixth player does not fit");

    // A plot frees up when its player leaves, and the next player gets it.
    const leaver = clients[2];
    const freed = room.state.players.get(leaver.sessionId)!.plot;
    await leaver.leave(true);
    await sleep(50);
    const next = await colyseus.connectTo(room, { userId: "guest-y" });
    await sleep(50);
    assert.strictEqual(room.state.players.get(next.sessionId)!.plot, freed);
  });

  it("relays position, look and base display, bounded", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a", username: "Ann" });
    await sleep(50);
    const p = room.state.players.get(a.sessionId)!;

    a.send("move", { x: 3.5, y: 0.1, z: -20, yaw: 1.2, speed: 6, vy: -2, grounded: false, hx: 1, hy: 2, hz: -60 });
    await sleep(50);
    assert.deepStrictEqual([p.x, p.y, p.z, p.yaw, p.speed, p.vy, p.grounded, p.hz], [3.5, 0.1, -20, 1.2, 6, -2, false, -60]);

    a.send("move", { x: 1e9, z: "far", y: Number.NaN });
    await sleep(50);
    assert.strictEqual(p.x, POS_MAX, "positions are clamped");
    assert.strictEqual(p.z, -20, "non-numbers are ignored");
    assert.strictEqual(p.y, 0.1);

    a.send("look", { look: JSON.stringify({ k: "o1", e: { hatId: "12" } }) });
    a.send("base", { pen: JSON.stringify({ a: [[1, "cow", 0]], p: ["dino"] }), mach: '{"m":[0,0.5]}', hook: '{"s":"cow","h":0}' });
    await sleep(50);
    assert.strictEqual(JSON.parse(p.look).k, "o1");
    assert.strictEqual(JSON.parse(p.pen).p[0], "dino");
    assert.strictEqual(p.hook, '{"s":"cow","h":0}');

    a.send("base", { pen: "not json", mach: "x".repeat(100000) });
    a.send("look", { look: "{" });
    await sleep(50);
    assert.strictEqual(JSON.parse(p.pen).p[0], "dino", "invalid JSON is dropped");
    assert.strictEqual(p.mach, '{"m":[0,0.5]}', "oversized blobs are dropped");
    assert.strictEqual(JSON.parse(p.look).k, "o1");
  });

  it("relays known fx events to the others only, rate-limited", async () => {
    const room = await colyseus.createRoom<WorldState>("world", {});
    const a = await colyseus.connectTo(room, { userId: "guest-a" });
    const b = await colyseus.connectTo(room, { userId: "guest-b" });
    const seenByA: unknown[] = [];
    const seenByB: { s: string; t: string; d: unknown }[] = [];
    a.onMessage("fx", (m) => seenByA.push(m));
    b.onMessage("fx", (m) => seenByB.push(m));
    await sleep(50);

    a.send("fx", { t: "pump", d: { level: true } });
    a.send("fx", { t: "hack" });
    a.send("fx", { t: "fire", d: { pad: "x".repeat(2000) } });
    await sleep(80);
    assert.strictEqual(seenByA.length, 0, "the sender does not get its own events back");
    assert.deepStrictEqual(seenByB, [{ s: a.sessionId, t: "pump", d: { level: true } }]);

    for (let i = 0; i < 50; i++) a.send("fx", { t: "pump" });
    await sleep(120);
    assert.ok(seenByB.length <= 1 + 20, `rate-limited (${seenByB.length})`);
  });
});
