import { schema, t, type SchemaType } from "@colyseus/schema";

// The live roster: who is in the room, which plot each player has, where their character is and
// what their base shows. Durable progress lives in Mongo (src/db.ts). Everything here is
// client-reported and only bounded (WorldRoom.ts): the game is client-authoritative and these
// fields are purely visual for the other players.
// To sync something new about a player, add a field here and accept it in a WorldRoom message.
export const PlayerState = schema(
  {
    username: t.string().default(""), // client-reported Bloxity displayName/username, not validated
    signedIn: t.boolean().default(false), // has a Bloxity id: only signed-in players are saved
    pfp: t.string().default(""), // Bloxity profile picture URL ("" = none), http(s) only
    // The player's Boxity account id, from their VERIFIED token ("" = guest). Public: Boxity chat
    // messages carry the sender's id, so clients match overhead chat bubbles to characters by it.
    uid: t.string().default(""),

    // The plot (0..PLOT_COUNT-1) the server gave this player: one base + Lane each, unique per
    // room. Assigned on join, kept across a reconnect, freed when the player leaves.
    plot: t.number().default(-1),

    // Character, in the player's OWN frame (their plot at x = 0, as every client builds its hub;
    // the client maps it onto its own layout). yaw = facing (rad). speed / vy / grounded drive the
    // walk cycle and jumps on the other screens. `move` messages, ~10 per second.
    x: t.number().default(0),
    y: t.number().default(0),
    z: t.number().default(0),
    yaw: t.number().default(0),
    speed: t.number().default(0),
    vy: t.number().default(0),
    grounded: t.boolean().default(true),

    // The catch hooked on this player's harpoon while it is reeled in: JSON
    // {"s": species, "h": shiny 0/1} ("" = nothing hooked), its mouth at hx/hy/hz (own frame).
    hook: t.string().default(""),
    hx: t.number().default(0),
    hy: t.number().default(0),
    hz: t.number().default(0),

    // The Bloxity look as JSON {"k": outfit key, "e": equipped ids, "p": proportions}: the outfit
    // key dresses the rig through the SDK's character kit, the ids are the manual fallback.
    look: t.string().default(""),
    // What the player's base shows, as JSON written by the client (game.js baseSnapshot()):
    // `pen` = the animals in the pen + the equipped pets (changes rarely), `mach` = the bait
    // machine, Auto Machine, pass tanks and training ring (changes a few times a second).
    pen: t.string().default(""),
    mach: t.string().default(""),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const WorldState = schema(
  {
    players: t.map(PlayerState), // keyed by sessionId
  },
  "WorldState",
);
export type WorldState = SchemaType<typeof WorldState>;
