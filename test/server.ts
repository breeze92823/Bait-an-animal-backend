import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";
import { __setVerifyForTest } from "../src/boxity.js";

// Tests never call the platform: a Boxity token "t-<id>" verifies as account <id>, anything else is
// refused (a guest). The join options' userId is ignored by the server, as in production.
export const fakeVerify = async (token: string) =>
  token.startsWith("t-") ? { id: token.slice(2), username: "", displayName: "", pfp: "", outfitKey: token.includes("outfit") ? "o1_verified" : "" } : null;
__setVerifyForTest(fakeVerify);

// One test server for every test file: booting appConfig twice in one mocha run breaks the second
// boot. Mocha's --exit tears it down at the end.
let server: Promise<ColyseusTestServer<typeof appConfig>> | null = null;
export const testServer = () => (server ??= boot(appConfig));
