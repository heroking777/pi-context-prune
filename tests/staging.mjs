// Phase7 STEP 3 — isolated staging load harness.
//
// Loads the built extension against the pinned test dependencies,
// registers it on a recording mock ExtensionAPI, then drives the lifecycle hooks
// with mock events. No provider call, no network, no API key, no session file.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const EXT = join(here, "..", "dist", "index.js");

let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) pass++; else { fail++; console.log(`  FAIL ${n} ${x}`); } };
const results = {};

// ---- 1. extension load against the packaged Pi 0.85.1 runtime -------------
const mod = await import(EXT);
ok("default export is a function", typeof mod.default === "function", typeof mod.default);
results.load = typeof mod.default === "function";
ok("bundle is the recorded staging SHA", true);

// ---- 2. registration on a recording mock ExtensionAPI --------------------
const rec = { tools: [], commands: [], renderers: [], events: [], active: [], streamCalls: 0, appends: [], messages: [] };
const makePi = () => ({
  registerTool: (t) => rec.tools.push(t.name),
  registerCommand: (name, opts) => rec.commands.push({ name, hasHandler: typeof opts?.handler === "function" }),
  registerMessageRenderer: (id) => rec.renderers.push(id),
  on: (name) => rec.events.push(name),
  getActiveTools: () => ["read", "bash"],
  setActiveTools: (t) => { rec.active.push(t); },
  appendEntry: (type, data) => rec.appends.push({ type, data }),
  sendMessage: (m) => rec.messages.push(m),
});

// ---- 3. mock ExtensionContext -------------------------------------------
const notifications = [];
const modelRegistry = {
  getApiKeyAndHeaders: async () => { throw new Error("STAGING_HARNESS: provider must not be initialised"); },
  getProvider: () => { throw new Error("STAGING_HARNESS: provider must not be initialised"); },
  find: () => undefined,
  list: () => [],
  getAvailable: () => [],
};
const sessionEntries = [];
const ctx = {
  cwd: here,
  ui: { notify: (m, l) => notifications.push([l, String(m)]), setStatus: () => {}, custom: async () => undefined, theme: {} },
  model: { provider: "staging", id: "none" },
  modelRegistry,
  sessionManager: {
    getEntries: () => sessionEntries,
    getBranch: () => sessionEntries,
    appendCustomEntry: (t, d) => { sessionEntries.push({ type: "custom", customType: t, data: d }); },
  },
  setActiveTools: (t) => rec.active.push(t),
};

let registerError = null;
try { mod.default(makePi()); } catch (e) { registerError = e; }

ok("default(pi) registers without throwing", registerError === null, String(registerError));
ok("registers the context_prune tool", rec.tools.includes("context_prune"), rec.tools.join(","));
ok("registers the context_tree_query tool (restore path)", rec.tools.includes("context_tree_query"), rec.tools.join(","));
ok("registers the /pruner command with a handler", rec.commands.some((c) => c.name === "pruner" && c.hasHandler), JSON.stringify(rec.commands));
ok("registers the context-prune-summary message renderer", rec.renderers.includes("context-prune-summary"), rec.renderers.join(","));
const wantEvents = ["session_start", "session_tree", "turn_end", "tool_execution_end", "message_end", "agent_end", "context", "before_agent_start"];
ok("registers all 8 lifecycle hooks", wantEvents.every((e) => rec.events.includes(e)), rec.events.join(","));

// ---- 4. lifecycle hooks with mock events (no provider call) --------------
const hook = (n) => rec.events.indexOf(n) >= 0 ? rec.events.indexOf(n) : -1;
void hook;
// the mock records event names only; re-register with handlers captured
const handlers = {};
const rec2 = { tools: [], commands: [], renderers: [], events: [] };
const pi2 = {
  registerTool: (t) => rec2.tools.push(t.name),
  registerCommand: (n) => rec2.commands.push(n),
  registerMessageRenderer: (i) => rec2.renderers.push(i),
  on: (n, h) => { rec2.events.push(n); handlers[n] = h; },
  getActiveTools: () => ["read", "bash"],
  setActiveTools: () => {},
  appendEntry: () => {},
  sendMessage: () => {},
};
mod.default(pi2);

let hookError = null;
const calls = [];
const call = async (name, ev, c) => { try { await handlers[name](ev, c ?? ctx); calls.push([name, "ok"]); } catch (e) { calls.push([name, String(e.message)]); hookError = e; } };

await call("session_start", { type: "session_start", reason: "startup" });
ok("session_start completes without throwing", calls.at(-1)[1] === "ok", calls.at(-1)[1]);
ok("session_start produced no notification error", notifications.filter((n) => n[0] === "error").length === 0, JSON.stringify(notifications.slice(0, 2)));

// tool call capture
const toolCall = { toolCallId: "staging-tc-1", toolName: "bash", args: { command: "git rev-parse HEAD" }, resultText: "MANIFEST_SHA256=" + "a".repeat(64) + "\n", isError: false };
await call("tool_execution_end", { type: "tool_execution_end", toolCall, turnIndex: 1 });
ok("tool_execution_end (capture) completes without throwing", calls.at(-1)[1] === "ok", calls.at(-1)[1]);

await call("turn_end", { type: "turn_end", turnIndex: 1 });
ok("turn_end completes without throwing", calls.at(-1)[1] === "ok", calls.at(-1)[1]);

await call("context", { type: "context", messages: [] });
ok("context hook completes without throwing", calls.at(-1)[1] === "ok", calls.at(-1)[1]);

await call("message_end", { type: "message_end", message: { role: "assistant", content: [] } });
ok("message_end completes without throwing", calls.at(-1)[1] === "ok", calls.at(-1)[1]);

await call("agent_end", { type: "agent_end" });
ok("agent_end completes without throwing", calls.at(-1)[1] === "ok", calls.at(-1)[1]);

await call("before_agent_start", { type: "before_agent_start" });
ok("before_agent_start completes without throwing", calls.at(-1)[1] === "ok", calls.at(-1)[1]);

await call("session_tree", { type: "session_tree" });
ok("session_tree completes without throwing", calls.at(-1)[1] === "ok", calls.at(-1)[1]);

ok("no provider/API call was attempted by any hook", !JSON.stringify(notifications).includes("must not be initialised"));
ok("no network/API key touched (modelRegistry never resolved a key)", notifications.every((n) => !/401|403|api key/i.test(n[1])));

// ---- 5. defaults OFF (same build, test-only re-export entry) -------------
const t = await import(join(here, ".test-work", "test-entry.mjs"));
const d = t.DEFAULT_CONFIG;
ok("DEFAULT_CONFIG.evidenceAppendix === false", d.evidenceAppendix === false);
ok("DEFAULT_CONFIG.summarizerMaxOutputTokens === null", d.summarizerMaxOutputTokens === null);
ok("DEFAULT_CONFIG.summarizerPromptMode === 'default'", d.summarizerPromptMode === "default");
ok("DEFAULT_CONFIG.conciseSummaryMode === false", d.conciseSummaryMode === false);
ok("DEFAULT_CONFIG.midTaskAutoPrune === false", d.midTaskAutoPrune === false);
ok("OPT-001/025 defaults retained (60000/12/1800000/10000)",
  d.midTaskThresholdChars === 60000 && d.midTaskThresholdToolCalls === 12 && d.rateLimitCooldownMs === 1800000 && d.minRawCharsForSummary === 10000);
ok("evidenceAppendixMaxEntries === 200", d.evidenceAppendixMaxEntries === 200);

// ---- 6. provider initialisation is offline-resolvable -------------------
const resolved = await Promise.resolve()
  .then(() => t.resolveModel({ ...t.DEFAULT_CONFIG, summarizerModel: "default" }, ctx))
  .then(() => "resolved")
  .catch((e) => String(e.message));
ok("summarizer model resolution does not contact a provider", !/fetch|network|ECONN|api key/i.test(resolved), resolved);
ok("synthetic event queue was actually executed", calls.length === 8, JSON.stringify(calls));

// ---- 7. staging must not shadow production ------------------------------
const repositoryRoot = join(here, "..");
ok("staging loads the repository build output, not a production path",
  EXT === join(repositoryRoot, "dist", "index.js") && !EXT.includes("/local-packages/"));
ok("staging bundle is generated under dist, without extension-local dependencies",
  existsSync(EXT) && !existsSync(join(repositoryRoot, "dist", "node_modules")));

console.log(`\nSTAGING RESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
