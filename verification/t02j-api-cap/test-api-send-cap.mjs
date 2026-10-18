import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBudget, wrapFetch, wrapHttpRequest, wrapWebSocket } from "./api-send-cap.mjs";
import { patchCodexProvider, sendResponseCreate } from "./provider-transport-guard.mjs";

class FakeWebSocket extends EventTarget {
  constructor(url) {
    super();
    this.url = String(url);
    this.sent = [];
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }
}

function freshDir(name) {
  const root = process.env.PI_API_SEND_CAP_TEST_DIR ?? tmpdir();
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, `${name}-`));
}

function testWebSocketLimit() {
  const budget = createBudget(freshDir("websocket"), false);
  const order = [];
  const reserve = budget.reserve.bind(budget);
  budget.reserve = (transport, target) => { order.push(`reserve:${transport}`); return reserve(transport, target); };
  class RecordingSocket extends FakeWebSocket {
    constructor(...args) { order.push("native-constructor"); super(...args); }
  }
  const Guarded = wrapWebSocket(RecordingSocket, budget, {
    blockExternalInDryRun: false,
    requireVerifiedProvider: false,
  });
  const socket = new Guarded("wss://chatgpt.com/backend-api/codex/responses");
  assert.deepEqual(order.slice(0, 2), ["reserve:websocket.handshake", "native-constructor"]);
  for (let i = 0; i < 8; i++) socket.send(JSON.stringify({ type: "response.create", i }));
  assert.equal(socket.sent.length, 8);
  assert.throws(() => socket.send(JSON.stringify({ type: "response.create", i: 9 })), /API_SEND_CAP_REACHED/);
  assert.equal(socket.sent.length, 8);
  assert.equal(budget.snapshot().used, 8);
}

async function testFetchLimit() {
  const budget = createBudget(freshDir("fetch-limit"), false);
  let calls = 0;
  const fetch = wrapFetch(async () => { calls++; return { ok: true }; }, budget);
  for (let i = 0; i < 8; i++) await fetch(`https://api.openai.com/v1/responses?send=${i}`, { method: "POST" });
  await assert.rejects(() => fetch("https://api.openai.com/v1/responses?send=9", { method: "POST" }), /API_SEND_CAP_REACHED/);
  assert.equal(calls, 8);
  assert.equal(budget.snapshot().used, 8);
}

function testProviderResponseCreateLimit() {
  const budget = createBudget(freshDir("provider-response-create"), false);
  const previous = globalThis.__PI_API_SEND_CAP_PROVIDER_VERIFIED;
  globalThis.__PI_API_SEND_CAP_PROVIDER_VERIFIED = true;
  try {
    const Guarded = wrapWebSocket(FakeWebSocket, budget, { requireVerifiedProvider: true });
    const target = "wss://chatgpt.com/backend-api/codex/responses";
    const socket = new Guarded(target);
    for (let i = 0; i < 8; i++) sendResponseCreate(socket, JSON.stringify({ type: "response.create", i }), target, budget, () => {});
    assert.throws(() => sendResponseCreate(socket, JSON.stringify({ type: "response.create", i: 9 }), target, budget, () => {}), /API_SEND_CAP_REACHED/);
    assert.equal(socket.sent.length, 8);
    assert.equal(budget.snapshot().used, 8);
  } finally {
    if (previous === undefined) delete globalThis.__PI_API_SEND_CAP_PROVIDER_VERIFIED;
    else globalThis.__PI_API_SEND_CAP_PROVIDER_VERIFIED = previous;
  }
}

async function testSharedHttpFetchAndWebSocketLimit() {
  const budget = createBudget(freshDir("shared"), false);
  const Guarded = wrapWebSocket(FakeWebSocket, budget, {
    blockExternalInDryRun: false,
    requireVerifiedProvider: false,
  });
  const socket = new Guarded("wss://chatgpt.com/backend-api/codex/responses");
  for (let i = 0; i < 3; i++) socket.send(JSON.stringify({ type: "response.create", i }));
  let fetchCalls = 0;
  const fetch = wrapFetch(async () => { fetchCalls++; return { ok: true }; }, budget);
  for (let i = 0; i < 3; i++) await fetch(`https://api.openai.com/v1/responses?case=${i}`, { method: "POST" });
  let httpCalls = 0;
  const fakeHttp = { request() { httpCalls++; return httpCalls; } };
  wrapHttpRequest(fakeHttp, "https:", budget);
  fakeHttp.request("https://api.openai.com/v1/responses?case=http-1", { method: "POST" });
  fakeHttp.request("https://api.openai.com/v1/responses?case=http-2", { method: "POST" });
  assert.throws(() => fakeHttp.request("https://api.openai.com/v1/responses?case=ninth", { method: "POST" }), /API_SEND_CAP_REACHED/);
  assert.equal(socket.sent.length, 3);
  assert.equal(fetchCalls, 3);
  assert.equal(httpCalls, 2);
  assert.equal(budget.snapshot().used, 8);
}

function testHttpModuleLimit() {
  const budget = createBudget(freshDir("http-module"), false);
  let calls = 0;
  const fakeHttp = { request() { calls++; return calls; } };
  wrapHttpRequest(fakeHttp, "https:", budget);
  for (let i = 0; i < 8; i++) fakeHttp.request(`https://mock.invalid/request-${i}`, { method: "POST" });
  assert.throws(() => fakeHttp.request("https://mock.invalid/request-9", { method: "POST" }), /API_SEND_CAP_REACHED/);
  assert.equal(calls, 8);
}

function testPersistentCrossProcessCap() {
  const directory = freshDir("cross-process");
  const moduleUrl = new URL("./api-send-cap.mjs", import.meta.url).href;
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_OPTIONS;
  const runChild = (count, expectsBlock = false) => {
    const source = `import { createBudget } from ${JSON.stringify(moduleUrl)};\nconst b = createBudget(${JSON.stringify(directory)}, false);\nfor (let i=0;i<${count};i++) { try { b.reserve("child", "https://mock.invalid/responses"); } catch (e) { if (!${expectsBlock} || !String(e).includes("API_SEND_CAP_REACHED")) throw e; console.log("BLOCKED"); break; } }`;
    return spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", env: cleanEnv });
  };
  assert.equal(runChild(5).status, 0);
  assert.equal(runChild(3).status, 0);
  const ninth = runChild(1, true);
  assert.equal(ninth.status, 0, ninth.stderr);
  assert.match(ninth.stdout, /BLOCKED/);
  assert.equal(createBudget(directory, false).snapshot().used, 8);
}

async function testConcurrentCrossProcessCap() {
  const directory = freshDir("concurrent-cross-process");
  const statePath = join(directory, "state.json");
  writeFileSync(statePath, `${JSON.stringify({ limit: 8, used: 0, attempts: 0, dryRunBlocks: 0, capBlocks: 0 })}\n`);
  const moduleUrl = new URL("./api-send-cap.mjs", import.meta.url).href;
  const source = `import {createBudget} from ${JSON.stringify(moduleUrl)};const b=createBudget(${JSON.stringify(directory)},false);try{b.reserve("child","https://mock.invalid/request");console.log("ACCEPTED")}catch(e){if(/API_SEND_CAP_REACHED|cap lock unavailable/.test(String(e)))console.log("BLOCKED");else throw e}`;
  const runChild = () => new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr }));
  });
  const results = await Promise.all(Array.from({ length: 12 }, runChild));
  assert.ok(results.every((result) => result.code === 0), results.map((result) => result.stderr).join("\\n"));
  const accepted = results.filter((result) => result.stdout === "ACCEPTED").length;
  assert.equal(results.filter((result) => result.stdout === "BLOCKED").length, results.length - accepted);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const events = readFileSync(join(directory, "events.jsonl"), "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(accepted <= 8);
  assert.equal(state.used, accepted);
  assert.equal(events.filter((event) => event.event === "reserved").length, accepted);
  assert.equal(events.filter((event) => event.event === "denied").length, state.capBlocks);
  return { processes: results.length, accepted, blocked: results.length - accepted, used: state.used };
}

function testWebSocketFailuresConsumeReservations() {
  const target = "wss://chatgpt.com/backend-api/codex/responses";
  const constructorBudget = createBudget(freshDir("constructor-failure"), false);
  class FailedConnection extends FakeWebSocket {
    constructor(...args) { super(...args); throw new Error("connection failed"); }
  }
  const FailedGuard = wrapWebSocket(FailedConnection, constructorBudget, { requireVerifiedProvider: false });
  assert.throws(() => new FailedGuard(target), /connection failed/);
  assert.equal(constructorBudget.snapshot().used, 1);

  const sendBudget = createBudget(freshDir("send-failure"), false);
  class FailedSend extends FakeWebSocket { send() { throw new Error("send failed"); } }
  const SendGuard = wrapWebSocket(FailedSend, sendBudget, { requireVerifiedProvider: false });
  const socket = new SendGuard(target);
  assert.throws(() => sendResponseCreate(socket, "payload", target, sendBudget, () => {}), /send failed/);
  socket.dispatchEvent(new Event("error"));
  socket.close();
  assert.equal(sendBudget.snapshot().used, 1);

  const closeBudget = createBudget(freshDir("close-error"), false);
  const LifecycleGuard = wrapWebSocket(FakeWebSocket, closeBudget, { requireVerifiedProvider: false });
  const lifecycleSocket = new LifecycleGuard(target);
  lifecycleSocket.dispatchEvent(new Event("error"));
  lifecycleSocket.close();
  assert.equal(closeBudget.snapshot().used, 1);
}

function testWebSocketConstructorBlockedAtLimit() {
  const budget = createBudget(freshDir("constructor-at-limit"), false);
  for (let i = 0; i < 8; i++) budget.reserve("setup", "https://api.openai.com/responses");
  let constructed = 0;
  class RecordingSocket extends FakeWebSocket { constructor(...args) { constructed++; super(...args); } }
  globalThis.__PI_API_SEND_CAP_PROVIDER_VERIFIED = true;
  const Guarded = wrapWebSocket(RecordingSocket, budget);
  assert.throws(() => new Guarded("wss://chatgpt.com/backend-api/codex/responses"), /API_SEND_CAP_REACHED/);
  assert.equal(constructed, 0);
  assert.equal(budget.snapshot().used, 8);
  assert.equal(budget.snapshot().capBlocks, 1);
  delete globalThis.__PI_API_SEND_CAP_PROVIDER_VERIFIED;
}

function testFailClosedProviderAndInvalidWebSocket() {
  const budget = createBudget(freshDir("fail-closed"), false);
  let constructed = 0;
  class RecordingWebSocket extends FakeWebSocket {
    constructor(...args) { super(...args); constructed++; }
  }
  const Guarded = wrapWebSocket(RecordingWebSocket, budget);
  assert.equal(wrapWebSocket(Guarded, budget), Guarded);
  globalThis.__PI_API_SEND_CAP_PROVIDER_VERIFIED = false;
  assert.throws(() => new Guarded("wss://chatgpt.com/responses"), /Unverified provider WebSocket blocked/);
  assert.throws(() => new Guarded("not-a-websocket-url"), /Invalid WebSocket target/);
  assert.equal(constructed, 0);
  assert.equal(budget.snapshot().used, 0);
}

function testMissingCounterStateFailsClosed() {
  const directory = freshDir("missing-used-state");
  writeFileSync(join(directory, "preload.jsonl"), "{}\n");
  assert.throws(() => createBudget(directory, false), /state missing from a used directory/);
}

function testProviderSourceDriftFailsClosed() {
  const budget = createBudget(freshDir("source-drift"), true);
  globalThis.__PI_API_SEND_CAP_FETCH = () => {};
  globalThis.__PI_API_SEND_CAP_WRAP_WEBSOCKET = () => FakeWebSocket;
  globalThis.__PI_API_SEND_CAP_RESPONSE_CREATE = () => {};
  globalThis.__PI_API_SEND_CAP_PROVIDER_VERIFIED = false;
  const source = 'const fetcher=(options?.fetch??globalThis.fetch); const t=options?.transport||"auto"; globalThis.WebSocket;';
  assert.throws(() => patchCodexProvider("file:///openai-codex-responses-fixture.js", { source }, budget), /transport\/send boundary changed/);
  assert.equal(globalThis.__PI_API_SEND_CAP_PROVIDER_VERIFIED, false);
}

function testDryRunBlocksBeforeTransport() {
  const budget = createBudget(freshDir("dry-run"), true);
  let constructed = 0;
  class RecordingSocket extends FakeWebSocket { constructor(...args) { constructed++; super(...args); } }
  const Guarded = wrapWebSocket(RecordingSocket, budget, {
    blockExternalInDryRun: false,
    requireVerifiedProvider: false,
  });
  assert.throws(() => new Guarded("wss://mock.invalid/responses"), /dry-run mode/);
  assert.equal(constructed, 0);
  assert.equal(budget.snapshot().used, 0);
  assert.equal(budget.snapshot().used, 0);
  assert.equal(budget.snapshot().dryRunBlocks, 1);
}

await testWebSocketLimit();
await testFetchLimit();
testProviderResponseCreateLimit();
testWebSocketFailuresConsumeReservations();
testWebSocketConstructorBlockedAtLimit();
await testSharedHttpFetchAndWebSocketLimit();
testHttpModuleLimit();
testPersistentCrossProcessCap();
const concurrentCap = await testConcurrentCrossProcessCap();
testFailClosedProviderAndInvalidWebSocket();
testMissingCounterStateFailsClosed();
testProviderSourceDriftFailsClosed();
testDryRunBlocksBeforeTransport();
console.log(JSON.stringify({
  pass: true,
  apiSendLimit: 8,
  websocketReservationBeforeNativeConstructor: true,
  websocketEightAllowedNinthBlocked: true,
  websocketConstructorBlockedAtLimit: true,
  websocketFailuresConsumeReservations: true,
  responseCreateDoesNotDoubleCountHandshake: true,
  fetchEightAllowedNinthBlocked: true,
  providerResponseCreateEightAllowedNinthBlocked: true,
  sharedHttpFetchWebSocketHttpBudget: true,
  httpModuleEightAllowedNinthBlocked: true,
  failClosedProviderAndInvalidTarget: true,
  missingCounterStateFailsClosed: true,
  providerSourceDriftFailsClosed: true,
  crossProcessPersistentCap: true,
  simultaneousCrossProcessCap: concurrentCap,
  dryRunUnderlyingTransportCalls: 0,
  actualNetworkRequests: 0,
}));
