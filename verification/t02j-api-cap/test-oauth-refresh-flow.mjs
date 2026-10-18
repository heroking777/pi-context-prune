import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBudget, wrapFetch } from "./api-send-cap.mjs";

const oauthModule = process.env.PI_AI_OAUTH_MODULE;
if (!oauthModule?.startsWith("file:")) throw new Error("Set PI_AI_OAUTH_MODULE to the installed pi-ai OAuth module file URL");
const { openaiCodexOAuth } = await import(oauthModule);

const directory = mkdtempSync(join(tmpdir(), "pi-oauth-refresh-flow-"));
const statePath = join(directory, "state.json");
const initial = { limit: 8, used: 0, attempts: 0, dryRunBlocks: 0, capBlocks: 0 };
writeFileSync(statePath, `${JSON.stringify(initial)}\n`);
const budget = createBudget(directory, false);
let underlyingFetchCalls = 0;
let blockedCallbackCalls = 0;
globalThis.fetch = wrapFetch(async () => {
  underlyingFetchCalls++;
  return new Response("unexpected", { status: 200 });
}, budget, () => blockedCallbackCalls++);
await assert.rejects(
  openaiCodexOAuth.refresh({ type: "oauth", refresh: "", access: "", expires: 0 }, AbortSignal.timeout(1000)),
  /token refresh error: OAuth refresh prohibited/,
);
assert.equal(underlyingFetchCalls, 0);
assert.equal(blockedCallbackCalls, 1);
assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), initial);
const events = readFileSync(join(directory, "events.jsonl"), "utf8");
assert.match(events, /oauth-refresh-blocked-before-network/);
console.log(JSON.stringify({
  piOAuthRefreshPathReachedGuard: true,
  underlyingFetchCalls,
  blockedCallbackCalls,
  sendCounterUnchanged: true,
  networkRequest: false,
}));
