// Boxity cross-pod room directory: pushes this pod's live rooms to the matchmaker every ~2 s so the
// game page's "Open Rooms" list (and its Join button = `?roomId=`), friend joins and join-by-id work
// across pods. Bloxity-hosted games must run this: the list is NOT filled automatically without it.
// A no-op unless deployed by Boxity hosting (BLOXITY_REPORT_TOKEN + MATCHMAKER_REPORT_URL are
// injected; POD_NAME names the pod), so it is safe locally and in tests. installRoomReporter() runs
// after listen() (src/index.ts). Best effort: a failed push is ignored and the next one repairs it.
// The same file the Boxity starter ships (docs.bloxity.io, "Show your live rooms").
import { matchMaker } from "colyseus";

import { boxity } from "./boxity.js";

const REPORT_EVERY_MS = 2000;
const TIMEOUT_MS = 4000;

let fetcher: typeof fetch = (...args) => fetch(...args);

// Where and how to report, or null outside a Bloxity deployment.
function target(): { url: string; token: string; podName: string } | null {
  const base = process.env.MATCHMAKER_REPORT_URL;
  const token = process.env.BLOXITY_REPORT_TOKEN;
  if (!base || !token) return null;
  return {
    url: `${base.replace(/\/$/, "")}/${encodeURIComponent(boxity.gameId())}/rooms`,
    token,
    podName: process.env.POD_NAME || process.env.HOSTNAME || "",
  };
}

// Pushes this pod's rooms once. True when the matchmaker accepted it. Never throws.
export async function reportRoomsOnce(): Promise<boolean> {
  const t = target();
  if (!t) return false;
  try {
    const listings = await matchMaker.query({});
    const rooms = listings.map((listing) => {
      const metadata = (listing.metadata || {}) as Record<string, unknown>;
      return {
        colyseusRoomId: listing.roomId,
        name: listing.name || undefined,
        clients: listing.clients ?? 0,
        maxClients: listing.maxClients ?? 0,
        locked: !!listing.locked,
        private: !!listing.private, // the directory never lists private rooms
        started: !!metadata.started,
        metadata: listing.metadata || undefined,
      };
    });
    const players = rooms.reduce((total, room) => total + (room.clients || 0), 0);
    const res = await fetcher(t.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t.token}` },
      body: JSON.stringify({ podName: t.podName, players, rooms }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false; // the directory tolerates gaps
  }
}

let timer: NodeJS.Timeout | null = null;

export function installRoomReporter(): void {
  if (!target() || timer) return;
  timer = setInterval(() => void reportRoomsOnce(), REPORT_EVERY_MS);
  timer.unref();
  void reportRoomsOnce();
  console.log(`[rooms] reporting this pod's rooms to the Bloxity matchmaker every ${REPORT_EVERY_MS / 1000}s`);
}

// Test-only: swap fetch.
export function __setFetchForTest(f: typeof fetch | null): void {
  fetcher = f ?? ((...args) => fetch(...args));
}
