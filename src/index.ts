import { listen } from "@colyseus/tools";

import app from "./app.config.js";
import { connectDb } from "./db.js";
import { flushScores, installScoreReporters } from "./leaderboards.js";
import { installRoomReporter } from "./legion-room-reporter.js";

// Player-progress persistence (src/db.ts) connects before the room accepts
// players; connectDb() itself never throws or hangs (degrades to "no persistence").
await connectDb();

// Listens on PORT (or 2567).
await listen(app);

// Boxity hosting (no-ops locally: they need the injected BLOXITY_REPORT_TOKEN): the Open Rooms
// directory, leaderboards and profile stats.
installRoomReporter();
installScoreReporters();
// A deploy or scale-down sends SIGTERM: send what is queued before the pod goes, or up to a full
// interval of everyone's progress here is lost. (Colyseus runs its own graceful shutdown too.)
process.once("SIGTERM", () => void flushScores());
