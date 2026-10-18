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
  `response=await${fetchExpression}(resolveCodexUrl(url));`,
  "globalThis.WebSocket;",
  "socket=new WebSocketCtor(url,{headers:wsHeaders});",
  'socket.send(JSON.stringify({type:"response.create",...requestBody}));',
].join("");
assert.equal(source.split(fetchExpression).length - 1, 1);

const brokenFetch = `await${fetchExpression}(resolveCodexUrl(url))`
  .replace(fetchExpression, "globalThis.__PI_API_SEND_CAP_FETCH")
  .replace("resolveCodexUrl(url)", "'mock'");
assert.ok(brokenFetch.startsWith("awaitglobalThis.__PI_API_SEND_CAP_FETCH"));
const brokenCall = new Function(`return async () => ${brokenFetch}`)();
await assert.rejects(brokenCall(), /awaitglobalThis is not defined/);

globalThis.__PI_API_SEND_CAP_FETCH = async () => "offline-response";
globalThis.__PI_API_SEND_CAP_WRAP_WEBSOCKET = (Base) => Base;
globalThis.__PI_API_SEND_CAP_RESPONSE_CREATE = () => {};
const budget = { directory, blockConnection() {} };
const patched = patchCodexProvider(fixtureUrl, { source }, budget).source;
assert.ok(!patched.includes("awaitglobalThis.__PI_API_SEND_CAP_FETCH"));
assert.ok(patched.includes("await(globalThis.__PI_API_SEND_CAP_FETCH)(resolveCodexUrl(url))"));
assert.ok(patched.includes("new (globalThis.__PI_API_SEND_CAP_WRAP_WEBSOCKET(WebSocketCtor))"));
assert.ok(patched.includes("globalThis.__PI_API_SEND_CAP_RESPONSE_CREATE"));
const fixedCall = new Function("return async () => await(globalThis.__PI_API_SEND_CAP_FETCH)('mock')")();
assert.equal(await fixedCall(), "offline-response");
console.log(JSON.stringify({
  sourceFixture: "minified-openai-codex-responses-pattern",
  oldPatchRuntimeErrorReproduced: true,
  fixedPatchExecutionPass: true,
  externalCalls: 0,
}));
