// Phase 23 STEP 1/STEP 3 — end-to-end wiring check.
//
// Loads the built extension with observability explicitly enabled, drives a real
// floor-skipped flush through the real turn_end handler, and verifies that one
// observed batch maps to exactly one commit record, one index entry, and one
// frontier entry. No provider is initialised and no network call is made.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const EXT = join(here, "..", "dist", "index.js");
const HOME = mkdtempSync(join(tmpdir(), "pruner-wiring-"));
const SETTINGS_DIR = join(HOME, ".pi", "agent", "context-prune");
const LOG_DIR = join(SETTINGS_DIR, "observability");

process.env.HOME = HOME;
process.env.PI_CONTEXT_PRUNE_OBSERVABILITY = "1";
mkdirSync(SETTINGS_DIR, { recursive: true });
writeFileSync(join(SETTINGS_DIR, "settings.json"), JSON.stringify({
  enabled: true,
  pruneOn: "every-turn",
  minRawCharsForSummary: 100000,
  showPruneStatusLine: false,
  showStartupNotice: false,
}));

let pass = 0;
let fail = 0;
const ok = (name, condition, extra = "") => {
  if (condition) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const mod = await import(EXT);
const handlers = {};
const appended = [];
const sent = [];
const notifications = [];
const sessionEntries = [
  { type: "message", message: { role: "user", content: [{ type: "text", text: "do work" }] } },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "wiring-tc-1", name: "bash", input: { command: "true" } }],
    },
  },
  {
    type: "message",
    message: { role: "toolResult", toolCallId: "wiring-tc-1", content: [{ type: "text", text: "tiny" }] },
  },
];

const pi = {
  registerTool: () => {},
  registerCommand: () => {},
  registerMessageRenderer: () => {},
  on: (name, handler) => { handlers[name] = handler; },
  getActiveTools: () => ["read", "bash"],
  setActiveTools: () => {},
  appendEntry: (type, data) => { appended.push({ type, data }); sessionEntries.push({ type: "custom", customType: type, data }); },
  sendMessage: (message) => { sent.push(message); },
};
const ctx = {
  cwd: here,
  ui: { notify: (m, l) => notifications.push([l, String(m)]), setStatus: () => {}, custom: async () => undefined, theme: {} },
  model: { provider: "staging", id: "none" },
  modelRegistry: {
    getApiKeyAndHeaders: async () => { throw new Error("WIRING_HARNESS: provider must not be initialised"); },
    getProvider: () => { throw new Error("WIRING_HARNESS: provider must not be initialised"); },
    find: () => undefined,
    list: () => [],
    getAvailable: () => [],
  },
  sessionManager: {
    getEntries: () => sessionEntries,
    getBranch: () => sessionEntries,
    appendCustomEntry: (t, d) => { appended.push({ type: t, data: d }); sessionEntries.push({ type: "custom", customType: t, data: d }); },
  },
  setActiveTools: () => {},
};

mod.default(pi);
await handlers["session_start"]({ type: "session_start", reason: "startup" }, ctx);

const beforeAppends = appended.length;
await handlers["turn_end"](
  {
    type: "turn_end",
    turnIndex: 1,
    toolResults: [{ role: "toolResult", toolCallId: "wiring-tc-1", content: [{ type: "text", text: "tiny" }] }],
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "wiring-tc-1", name: "bash", input: { command: "true" } }],
    },
  },
  ctx,
);

const newAppends = appended.slice(beforeAppends).map((entry) => entry.type);
const indexEntries = appended.filter((entry) => entry.type === "context-prune-index");
const frontierEntries = appended.filter((entry) => entry.type === "context-prune-frontier");
const logFiles = existsSync(LOG_DIR) ? readdirSync(LOG_DIR).filter((n) => n.endsWith(".jsonl")) : [];
const records = logFiles.flatMap((name) =>
  readFileSync(join(LOG_DIR, name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
);
const commits = records.filter((entry) => entry.event === "batch_outcome");
const attempts = records.filter((entry) => entry.event === "summary_api");

ok("observability enabled and wrote a log file", logFiles.length === 1);
ok("no provider call was attempted", !JSON.stringify(notifications).includes("must not be initialised"), JSON.stringify(notifications.slice(0, 1)));
ok("one batch yields exactly one commit record", commits.length === 1, `got ${commits.length}`);
ok("commit record names the floor outcome and reason", commits[0]?.outcome === "skipped-size-floor" && commits[0]?.flushReason === "every_turn", JSON.stringify(commits[0] && { o: commits[0].outcome, r: commits[0].flushReason }));
ok("commit record states the batch reached the index", commits[0]?.indexPersisted === true);
ok("floor-only flush makes no summary API attempt", attempts.length === 0, `got ${attempts.length}`);
ok("commit aligns with one persisted index entry", indexEntries.length === 1, `index entries ${indexEntries.length}`);
ok("commit aligns with one advanced frontier", frontierEntries.length === 1, `frontier entries ${frontierEntries.length}`);
ok("index entry contains the captured call and no observable-only fields", JSON.stringify(indexEntries[0]?.data).includes("wiring-tc-1") && !JSON.stringify(indexEntries[0]?.data).includes("indexPersisted"));
ok("new lifecycle appends are index + frontier + stats only", newAppends.every((type) => ["context-prune-index", "context-prune-frontier", "context-prune-stats"].includes(type)), newAppends.join(","));
ok("sent messages contain no raw summary payload", sent.length === 0, JSON.stringify(sent).slice(0, 80));

rmSync(HOME, { recursive: true, force: true });
console.log(`  INFO wiring test: ${pass} passed, ${fail} failed; no provider/network call`);
process.exit(fail === 0 ? 0 : 1);
