import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchCodexProvider } from "./provider-transport-guard.mjs";

const directory = mkdtempSync(join(tmpdir(), "t02j-provider-patch-"));
const fixtureUrl = "file:///fixture/openai-codex-responses-test.js";
const fetchExpression = "(options?.fetch??globalThis.fetch)";
const source = [
  'transport=options?.transport||"auto";',
  'const transport = options?.transport || "auto";',
  `response=await${fetchExpression}(resolveCodexUrl(url));`,
  "globalThis.WebSocket;",
  "socket=new WebSocketCtor(url,{headers:wsHeaders});",
  'socket.send(JSON.stringify({type:"response.create",...requestBody}));',
  "recordWebSocketSseFallback(cacheSessionId);",
  "recordWebSocketSseFallback(cacheSessionId);",
  "for (let attempt = 0; attempt <= maxRetries; attempt++) {",
  "}, httpTimeoutMs, websocketConnectTimeoutMs, cacheSessionId, accountId, grammarToolInputProperties, options);",
  "async function processWebSocketStream(url, body, headers, output, stream, model, onStart, idleTimeoutMs, websocketConnectTimeoutMs, cacheSessionId, accountId, grammarToolInputProperties, options) {",
  "options?.signal, websocketConnectTimeoutMs, options?.env);",
  "async function acquireWebSocket(url, headers, sessionId, accountId, signal, connectTimeoutMs, env) {",
  "async function connectWebSocket(url, headers, signal, connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS, env) {",
  "connectWebSocket(url, headers, signal, connectTimeoutMs, env)",
  "connectWebSocket(url, headers, signal, connectTimeoutMs, env)",
  "connectWebSocket(url, headers, signal, connectTimeoutMs, env)",
].join("");
assert.equal(source.split(fetchExpression).length - 1, 1);

const brokenFetch = `await${fetchExpression}(resolveCodexUrl(url))`
  .replace(fetchExpression, "globalThis.__PI_API_SEND_CAP_FETCH")
  .replace("resolveCodexUrl(url)", "'mock'");
assert.ok(brokenFetch.startsWith("awaitglobalThis.__PI_API_SEND_CAP_FETCH"));
const brokenCall = new Function(`return async () => ${brokenFetch}`)();
await assert.rejects(brokenCall(), /awaitglobalThis is not defined/);

globalThis.__PI_API_SEND_CAP_FETCH_FOR_ATTEMPT = () => async () => "offline-response";
globalThis.__PI_API_SEND_CAP_BEGIN_OPERATION = () => "operation";
globalThis.__PI_API_SEND_CAP_EVENT = () => {};
globalThis.__PI_API_SEND_CAP_WS_ATTEMPT = () => "request";
globalThis.__PI_API_SEND_CAP_WRAP_WEBSOCKET = (Base) => Base;
globalThis.__PI_API_SEND_CAP_RESPONSE_CREATE = () => {};
const budget = { directory, blockConnection() {} };
const patched = patchCodexProvider(fixtureUrl, { source }, budget).source;
assert.ok(!patched.includes("awaitglobalThis.__PI_API_SEND_CAP_FETCH"));
assert.ok(patched.includes("await(globalThis.__PI_API_SEND_CAP_FETCH_FOR_ATTEMPT(operationId, attempt))(resolveCodexUrl(url))"));
assert.ok(patched.includes("__PI_API_SEND_CAP_BEGIN_OPERATION"));
assert.ok(patched.includes("new (globalThis.__PI_API_SEND_CAP_WRAP_WEBSOCKET(WebSocketCtor, operationId, requestId))"));
assert.ok(patched.includes("globalThis.__PI_API_SEND_CAP_RESPONSE_CREATE"));
const fixedCall = new Function("return async () => await(globalThis.__PI_API_SEND_CAP_FETCH_FOR_ATTEMPT('op', 0)('mock'))")();
assert.equal(await fixedCall(), "offline-response");
console.log(JSON.stringify({
  sourceFixture: "minified-openai-codex-responses-pattern",
  oldPatchRuntimeErrorReproduced: true,
  fixedPatchExecutionPass: true,
  externalCalls: 0,
}));
