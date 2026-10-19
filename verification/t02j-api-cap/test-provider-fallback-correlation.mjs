import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const preload = new URL("./preload.mjs", import.meta.url).href;
assert.ok(process.env.PI_AI_PROVIDER_MODULE, "set installed Pi AI provider module path");

function scenario(mode, retries = 0) {
  const dir = mkdtempSync(join(tmpdir(), "t02o-correlation-"));
  const resultFile = join(dir, "result.json");
  const env = {
    ...process.env,
    PI_API_SEND_CAP_DIR: dir,
    PI_API_SEND_CAP_DRY_RUN: "0",
    PI_API_SEND_CAP_FAKE_WEBSOCKET: "1",
    PI_API_SEND_CAP_FAKE_WS_MODE: mode,
    PI_API_SEND_CAP_FAKE_FETCH: "1",
    PI_API_SEND_CAP_PROVIDER_RESULT: resultFile,
    PI_API_SEND_CAP_TEST_MAX_RETRIES: String(retries),
    NODE_OPTIONS: `--import=${preload}`,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(scriptDir, "direct-provider-preflight.mjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${stderr}\n${stdout}`));
      const records = readFileSync(join(dir, "diagnostics.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
      const result = JSON.parse(readFileSync(resultFile, "utf8"));
      resolve({ dir, records, result });
    });
  });
}

const [socketFailure, constructorFailure, normalSocket] = await Promise.all([
  scenario("error", 1),
  scenario("constructor-throw", 0),
  scenario("open-complete", 0),
]);
const opIds = [socketFailure, constructorFailure, normalSocket].map((s) => s.records.find((x) => x.event === "operation-start")?.operationId);
assert.ok(opIds.every(Boolean));
assert.equal(new Set(opIds).size, 3, "parallel operation identifiers must not collide");

const started = socketFailure.records.find((x) => x.event === "operation-start");
const fallback = socketFailure.records.find((x) => x.event === "sse-fallback-selected");
const attempts = socketFailure.records.filter((x) => x.event === "fetch-attempt");
const requests = socketFailure.records.filter((x) => x.event === "fetch-request");
const errors = socketFailure.records.filter((x) => x.event === "fetch-error");
const wsStart = socketFailure.records.find((x) => x.event === "websocket-attempt-start");
const wsError = socketFailure.records.find((x) => x.event === "error" && x.transport === "websocket");
const wsClose = socketFailure.records.find((x) => x.event === "close" && x.transport === "websocket");
assert.ok(started && fallback && wsStart && wsError && wsClose);
assert.equal(fallback.operationId, started.operationId);
assert.equal(wsStart.operationId, started.operationId);
assert.equal(wsError.operationId, started.operationId);
assert.equal(wsError.requestId, wsStart.requestId);
assert.deepEqual(attempts.map((x) => [x.retry_attempt, x.retry]), [[1, false], [2, true]]);
assert.equal(requests.length, 2);
assert.equal(new Set(requests.map((x) => x.requestId)).size, 2);
assert.ok(errors.every((x) => x.error.code === "EFakeTransport" && x.operationId === started.operationId));
assert.equal(socketFailure.records.some((x) => x.event === "constructor-failure"), false);

const ctorEvents = constructorFailure.records;
const ctorStart = ctorEvents.find((x) => x.event === "websocket-attempt-start");
assert.ok(ctorStart);
assert.ok(ctorEvents.some((x) => x.event === "constructor-failure" && x.requestId === ctorStart.requestId));
assert.equal(ctorEvents.some((x) => x.event === "error" || x.event === "close"), false, "do not invent socket events when construction throws");
assert.ok(ctorEvents.some((x) => x.event === "sse-fallback-selected" && x.operationId === ctorStart.operationId));

const normalEvents = normalSocket.records;
assert.ok(normalEvents.some((x) => x.event === "open" && x.operationId === opIds[2]));
assert.equal(normalEvents.some((x) => x.event === "sse-fallback-selected" || x.event === "fetch-attempt"), false);
assert.ok(normalSocket.result.events.includes("done"));
for (const scenarioResult of [socketFailure, constructorFailure, normalSocket]) {
  const encoded = JSON.stringify(scenarioResult.records);
  assert.equal(encoded.includes("offline-") || encoded.includes("apiKey"), false);
  const state = JSON.parse(readFileSync(join(scenarioResult.dir, "state.json"), "utf8"));
  assert.ok(state.used <= 8);
}
assert.ok(socketFailure.records.filter((x) => x.event === "fetch-error").every((x) => x.requestId && x.operationId));
console.log(JSON.stringify({ pass: true, providerFallbackObserved: true, websocketOpen: true, constructorFailureClassified: true, retryAttempts: 2, parallelOperations: 3, networkRequests: 0 }));
