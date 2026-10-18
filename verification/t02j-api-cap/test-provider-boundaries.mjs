import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputRoot = process.argv[2];
if (!outputRoot) throw new Error("Pass an evidence output directory");
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });

function readJsonl(path) {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function runTransport(transport) {
  const stateDir = mkdtempSync(join(outputRoot, `${transport}-`));
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  Object.assign(env, {
    PI_API_SEND_CAP_DIR: stateDir,
    PI_API_SEND_CAP_DRY_RUN: "1",
    PI_API_SEND_CAP_FAKE_WEBSOCKET: "1",
    PI_API_SEND_CAP_TEST_EXIT_AFTER_BLOCK: "1",
    PI_API_SEND_CAP_PROVIDER_CAPTURE: join(stateDir, "payload.jsonl"),
    PI_API_SEND_CAP_TEST_TRANSPORT: transport,
  });
  const preload = new URL("./preload.mjs", import.meta.url).href;
  env.NODE_OPTIONS = `--import=${preload}`;
  const child = spawnSync(process.execPath, [join(scriptDir, "direct-provider-preflight.mjs")], {
    cwd: scriptDir,
    env,
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(child.status, 0, `${transport} probe failed: ${child.stderr}`);

  const state = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8"));
  const events = readJsonl(join(stateDir, "events.jsonl"));
  const provider = readJsonl(join(stateDir, "provider-path.jsonl"))[0];
  const constructors = readJsonl(join(stateDir, "websocket-constructor.jsonl"));
  const payload = readJsonl(join(stateDir, "payload.jsonl"))[0];
  assert.deepEqual({ used: state.used, attempts: state.attempts, dryRunBlocks: state.dryRunBlocks },
    { used: 0, attempts: 1, dryRunBlocks: 1 });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "blocked");
  assert.equal(events[0].transport, transport === "auto" ? "websocket.send" : "fetch");
  assert.equal(provider.resolvedWebSocketConstructorWrapped, true);
  assert.equal(provider.responseCreateSendGuarded, true);
  assert.equal(provider.fetchRedirectedToGuard, true);
  assert.ok(constructors.some((entry) => entry.forcedOfflineFake && entry.selectedConstructor === "OfflineWebSocket"));
  assert.equal(payload.querySchemaPresent, true);

  if (transport === "auto") {
    const fakeEvents = readJsonl(join(stateDir, "fake-websocket.jsonl"));
    assert.ok(fakeEvents.some((event) => event.event === "constructed"));
    assert.equal(fakeEvents.some((event) => event.event === "underlying-send"), false);
  }
  return { transport, stateDir, state, blockedAt: events[0].transport, provider, constructorOverrides: constructors.length, querySchemaPresent: payload.querySchemaPresent };
}

const results = [runTransport("auto"), runTransport("sse")];
appendFileSync(join(outputRoot, "provider-boundary-results.json"), `${JSON.stringify({ pass: true, actualNetworkRequests: 0, results }, null, 2)}\n`);
console.log(JSON.stringify({ pass: true, actualNetworkRequests: 0, results }));
