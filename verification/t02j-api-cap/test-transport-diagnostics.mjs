import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDiagnostics, recordSandboxSnapshot, recordWebSocket, sandboxSnapshot } from "./transport-diagnostics.mjs";

const dir = mkdtempSync(join(tmpdir(), "t02n-diag-"));
const log = join(dir, "diagnostics.jsonl");
const classes = [
  Object.assign(new Error("getaddrinfo ENOTFOUND host.invalid"), { code: "ENOTFOUND", syscall: "getaddrinfo" }),
  Object.assign(new Error("connect ECONNREFUSED host.invalid"), { code: "ECONNREFUSED", errno: -111, syscall: "connect" }),
  Object.assign(new Error("certificate verify failed"), { code: "CERT_HAS_EXPIRED" }),
  Object.assign(new Error("request timed out"), { code: "ETIMEDOUT", syscall: "connect" }),
];
for (const [i, error] of classes.entries()) {
  error.cause = Object.assign(new Error("Bearer secret-value https://host.invalid/?token=secret"), { code: "EINNER" });
  const d = createDiagnostics(log, { transport: "fetch", requestId: `req-${i}`, now: () => "2026-01-01T00:00:00Z" });
  await assert.rejects(d.fetch(async () => { throw error; }, "https://private.invalid/?token=secret", { headers: { authorization: "Bearer secret" } }));
}
const missing = createDiagnostics(log, { transport: "fetch", requestId: "missing" });
await assert.rejects(missing.fetch(async () => { throw new Error("plain safe failure"); }, "https://x.invalid"));
for (const event of ["handshake-reserved", "open", "error", "close", "fetch-fallback"]) recordWebSocket(log, "ws-1", event);
const lines = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
assert.equal(lines.filter((x) => x.event === "fetch-error").length, 5);
assert.equal(lines[0].error.code, "ENOTFOUND");
assert.equal(lines[0].error.cause.code, "EINNER");
assert.equal(lines[4].error.cause, "MISSING");
assert.deepEqual(lines.slice(-5).map((x) => x.event), ["handshake-reserved", "open", "error", "close", "fetch-fallback"]);
const serialized = JSON.stringify(lines);
for (const secret of ["secret-value", "private.invalid", "token=secret", "Bearer secret"]) assert.equal(serialized.includes(secret), false);
assert.equal(lines[0].requestId, "req-0");
assert.ok(lines[0].at);
const snapshot = sandboxSnapshot({ harnessPath: new URL("./transport-diagnostics.mjs", import.meta.url).pathname, providerPath: process.env.PI_AI_PROVIDER_MODULE ?? "/tmp/provider.js", env: { HTTPS_PROXY: "secret-proxy" } });
assert.equal(snapshot.proxy.httpsProxySet, true);
assert.equal(JSON.stringify(snapshot).includes("secret-proxy"), false);
assert.ok(snapshot.provider.module.endsWith(".js"));
if (process.env.PI_AI_PROVIDER_MODULE) assert.equal(snapshot.provider.version, "0.85.1");
recordSandboxSnapshot(log, { harnessPath: new URL("./transport-diagnostics.mjs", import.meta.url).pathname, providerPath: "/tmp/provider.js", env: {} });
assert.equal(readFileSync(log, "utf8").includes('"event":"sandbox-snapshot"'), true);
console.log(JSON.stringify({ pass: true, simulatedFailures: 4, missingCause: true, websocketLifecycle: true, secretsRedacted: true, networkRequests: 0 }));
