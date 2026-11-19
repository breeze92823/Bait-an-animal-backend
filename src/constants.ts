// Keep in step with the client's src/config.js by hand.
// The game's Boxity slug / hosting id (client GAME_SLUG): token checks, ad rewards, reports.
export const GAME_SLUG = "bait-an-animal";
// One room = one hub with PLOT_COUNT plots (a base + Lane each): one player per plot, so a room
// holds exactly that many. The deploy sends it as Legion's roomSize (.github/workflows/deploy.yml).
export const PLOT_COUNT = 5;
export const ROOM_MAX_CLIENTS = 5;

// Bounds for the relayed presence (WorldRoom.ts). Positions are metres in the player's own frame;
// the hub + the Lane fit well inside POS_MAX.
export const POS_MAX = 2000;
export const SPEED_MAX = 100;
export const LOOK_MAX_LEN = 4096; // {"k": outfit key, "e": equipped ids, "p": proportions}
export const PEN_MAX_LEN = 8192; // the pen's animals + the equipped pets
export const MACH_MAX_LEN = 4096; // machines, tanks, passes, training ring
export const HOOK_MAX_LEN = 128;
// `fx` events (pump, claim, harpoon arm/fire, catch...) relayed to the others, per second per player.
export const FX_PER_SECOND = 20;
export const FX_MAX_LEN = 512;

// Longest accepted strings.
export const NAME_MAX = 64;
// Profile picture URL (Bloxity `pfp`).
export const PFP_MAX_LEN = 512;

// Colyseus drops the whole connection for a WebSocket message above this (default 4 KB). The
// whole game state rides in one `saveProgress` (~10 KB at most, see baitSave.ts).
export const MAX_PAYLOAD_BYTES = 128 * 1024;

// How long a dropped connection (WiFi blip, backgrounded tab) may reconnect with the same session.
export const RECONNECT_SECONDS = 20;

// Upper bound for saved money / XP, so a forged payload cannot store a bogus number. A generous
// ceiling, not a game rule.
export const CURRENCY_MAX = 1e33;

// Ids from the client's catalogs (animal species, passes, pets, potions, upgrades): camelCase
// slugs, so nothing odd is stored.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// The client's per-browser fallback id for players who are not signed in to Bloxity.
// Guests are never persisted.
export const GUEST_ID_PREFIX = "guest-";
