import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const pi = "/home/deploy/.npm-global/bin/pi";
const harness = new URL("./", import.meta.url);
const preload = new URL("./preload.mjs", import.meta.url).href;
const dir = mkdtempSync(join(tmpdir(), "t02q-cli-provider-"));
for (const name of ["config", "home/.pi/agent", "sessions", "cap"]) mkdirSync(join(dir, name), { recursive: true });
writeFileSync(join(dir, "config/settings.json"), JSON.stringify({
  defaultProvider: "openai-codex", defaultModel: "gpt-6-luna", enabledModels: ["openai-codex/gpt-6-luna"],
  retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, maxRetryDelayMs: 0 } },
}));
writeFileSync(join(dir, "config/models-store.json"), "{}\n");
const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-t02q" } })).toString("base64url");
writeFileSync(join(dir, "config/auth.json"), JSON.stringify({ "openai-codex": {
  type: "oauth", access: `${header}.${claims}.offline`, refresh: "T02Q_DUMMY_ONLY", expires: Date.now() + 86400000,
} }));
writeFileSync(join(dir, "tool.mjs"), `export default function(pi) {
  pi.registerTool({
    name: "context_tree_query",
    label: "offline Raw query fixture",
    description: "offline schema-only test",
    parameters: { type: "object", properties: { toolCallIds: { type: "array", items: { type: "string" } } }, required: ["toolCallIds"] },
    execute: async () => ({ content: [{ type: "text", text: "offline" }] }),
  });
}`);
const schemaPath = join(dir, "cap/schema.jsonl");
const env = {
  ...process.env,
  HOME: join(dir, "home"),
  PI_CODING_AGENT_DIR: join(dir, "config"),
  PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
  PI_API_SEND_CAP_DIR: join(dir, "cap"),
  PI_API_SEND_CAP_DRY_RUN: "1",
  PI_API_SEND_CAP_TEST_EXIT_AFTER_BLOCK: "1",
  PI_API_SEND_CAP_FAKE_WEBSOCKET: "1",
  PI_API_SEND_CAP_FAKE_FETCH: "1",
  PI_API_SEND_CAP_SCHEMA_CAPTURE: schemaPath,
  PI_AI_PROVIDER_MODULE: "/home/deploy/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js",
  PI_AI_OAUTH_MODULE: "/home/deploy/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js",
  NODE_OPTIONS: `--import=${preload}`,
};
const result = spawnSync(pi, [
  "--provider", "openai-codex", "--model", "gpt-6-luna", "--mode", "json", "--no-context-files",
  "--session", join(dir, "sessions/replay.jsonl"), "--session-dir", join(dir, "sessions"),
  "--no-extensions", "--extension", pathToFileURL(join(dir, "tool.mjs")).href,
  "--tools", "context_tree_query", "--print", "offline provider guard check",
], { env, encoding: "utf8", timeout: 20000 });
assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
const provider = JSON.parse(readFileSync(join(dir, "cap/provider-path.jsonl"), "utf8").trim());
const schema = JSON.parse(readFileSync(schemaPath, "utf8").trim());
const preloadRecord = JSON.parse(readFileSync(join(dir, "cap/preload.jsonl"), "utf8").trim());
const state = JSON.parse(readFileSync(join(dir, "cap/state.json"), "utf8"));
const diagnostics = readFileSync(join(dir, "cap/diagnostics.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
const events = readFileSync(join(dir, "cap/events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
const operation = diagnostics.find((event) => event.event === "operation-start");
const wsStart = diagnostics.find((event) => event.event === "websocket-attempt-start");
const constructor = diagnostics.find((event) => event.event === "constructor-attempt");
const opened = diagnostics.find((event) => event.event === "open");
assert.match(provider.url, /dist\/bundle\/chunks\/openai-codex-responses-/);
assert.equal(provider.fetchRedirectedToGuard, true);
assert.equal(provider.responseCreateSendGuarded, true);
assert.equal(provider.operationScopedInstrumentation, true);
assert.equal(provider.sourceBytes, 37735);
assert.equal(provider.sourceSha256, "c13b23c9799a1ec70a91e0b6a8c794e50c80fb2802593f0441199506168057df");
assert.equal(schema.contextTreeQueryPresent, true);
assert.ok(schema.contextTreeQuerySchemaSha256);
assert.equal(preloadRecord.dryRun, true);
assert.equal(preloadRecord.offlineFake, true);
assert.equal(state.used, 0);
assert.equal(state.dryRunBlocks, 1);
assert.ok(operation && wsStart && constructor && opened);
assert.equal(new Set([wsStart.requestId, constructor.requestId, opened.requestId]).size, 1);
assert.ok([wsStart, constructor, opened].every((event) => event.operationId === operation.operationId));
assert.equal(diagnostics.some((event) => event.event === "sse-fallback-selected" || event.event === "fetch-attempt"), false);
assert.equal(events.some((event) => event.event === "blocked" && event.reason === "dry-run"), true);
assert.equal(JSON.stringify(schema).includes("T02Q_DUMMY_ONLY"), false);
assert.ok(!readFileSync(join(dir, "cap/fake-websocket.jsonl"), "utf8").includes("underlying-send"));
console.log(JSON.stringify({
  pass: true,
  cliExecutable: pi,
  providerUrl: provider.url,
  loadedSourceSha256: provider.sourceSha256,
  loadedSourceBytes: provider.sourceBytes,
  contextTreeQueryPresent: schema.contextTreeQueryPresent,
  fakeTransport: true,
  dryRunBlockedBeforeSend: true,
  networkRequests: 0,
}));
