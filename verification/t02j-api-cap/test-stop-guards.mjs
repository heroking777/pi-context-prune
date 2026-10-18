import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const preload = `--import=${new URL("./preload.mjs", import.meta.url).href}`;
const oauthModule = process.env.PI_AI_OAUTH_MODULE;
if (!oauthModule?.startsWith("file:")) throw new Error("Set PI_AI_OAUTH_MODULE to the installed pi-ai OAuth module file URL");
const runCase = (state, source, locked = false, dryRun = false) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-send-stop-"));
  const initial = { limit: 8, used: state.used, attempts: 0, dryRunBlocks: 0, capBlocks: 0 };
  writeFileSync(join(dir, "state.json"), `${JSON.stringify(initial)}\n`);
  if (locked) writeFileSync(join(dir, "state.lock"), "held");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, NODE_OPTIONS: preload, PI_API_SEND_CAP_DIR: dir, PI_API_SEND_CAP_DRY_RUN: dryRun ? "1" : "0" },
    encoding: "utf8",
  });
  const eventsPath = join(dir, "events.jsonl");
  return { ...child, state: JSON.parse(readFileSync(join(dir, "state.json"), "utf8")), events: existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "" };
};
const refresh = runCase({ used: 0 }, `const {openaiCodexOAuth}=await import(process.env.PI_AI_OAUTH_MODULE); await openaiCodexOAuth.refresh({type:"oauth",refresh:"",access:"",expires:0},AbortSignal.timeout(1000));`, false, true);
assert.equal(refresh.status, 78, refresh.stderr);
assert.equal(refresh.state.used, 0);
assert.match(refresh.events, /oauth-refresh-blocked-before-network/);
const cap = runCase({ used: 8 }, `globalThis.__PI_API_SEND_CAP_RESPONSE_CREATE({send(){process.stdout.write("RAW_SEND")}},"payload","wss://api.openai.com/codex");`);
assert.equal(cap.status, 78, cap.stderr);
assert.equal(cap.state.used, 8);
assert.equal(cap.state.capBlocks, 1);
assert.doesNotMatch(cap.stdout, /RAW_SEND/);
assert.match(cap.events, /limit-8/);
const lock = runCase({ used: 0 }, `globalThis.__PI_API_SEND_CAP_RESPONSE_CREATE({send(){process.stdout.write("RAW_SEND")}},"payload","wss://api.openai.com/codex");`, true);
assert.equal(lock.status, 78);
assert.equal(lock.state.used, 0);
assert.doesNotMatch(lock.stdout, /RAW_SEND/);
console.log(JSON.stringify({
  oauthRefreshExit: refresh.status,
  oauthRefreshNetworkCalls: 0,
  oauthRefreshCounterUsed: refresh.state.used,
  ninthSendExit: cap.status,
  ninthRawSendCalls: 0,
  ninthCapBlocks: cap.state.capBlocks,
  lockUnavailableExit: lock.status,
  lockUnavailableNetworkCalls: 0,
}));
