// Shared helpers for the Phase 32-35 protection test suites.
import {
  DEFAULT_CONFIG, summarizeBatch, extractProtectedItems, extractProtectedItemsDetailed,
  verifyProtectedSummary, protectionFailureKey, PROTECTION_FAILURE_MARKER,
  protectionFailureCount, clearProtectionFailures, isProtectionPaused, protectionRejectionReason,
  isProtectionAtCapacity, protectionSessionCount, protectionSlotCount,
  RATE_LIMITED_MARKER, ok,
} from "./test-support.mjs";

export const SHA = (n) => `${String(n).padStart(3, "0")}${"a".repeat(37)}`;
export const PATH = "/home/deploy/hr-p0/jra/src/heroking_jra/pit/integrity.py";
export const PROTECTED_BATCH = {
  turnIndex: 1, timestamp: 1,
  toolCalls: [
    { toolName: "bash", toolCallId: "b1", args: { command: "sha" }, resultText: `FINAL_SHA=${SHA(1)} ${PATH}`, isError: false },
    { toolName: "bash", toolCallId: "b2", args: { command: "test" }, resultText: "IntegrityError: bad; jra-gate: FAIL", isError: true },
    { toolName: "bash", toolCallId: "b3", args: { command: "decide" }, resultText: "DECISION=KEEP_RAW UNFINISHED_TASK: resume tracing ROLLBACK=restore snapshot", isError: false },
  ],
};

export function fakeCtx(behaviour, session = "s1") {
  const calls = { n: 0 };
  const provider = {
    stream(_model, ctxArg) {
      calls.n += 1;
      const userText = ctxArg.messages[0].content.map((p) => p.text).join("\n");
      const body = userText.split("<tool-call-batch>")[1]?.split("</tool-call-batch>")[0] ?? "";
      if (behaviour === "429") { const e = new Error("429 Too Many Requests"); e.status = 429; throw e; }
      if (behaviour === "error") throw new Error("provider exploded");
      const pairs = [...body.matchAll(/([A-Za-z0-9_.:/-]{2,40})\s*[:=]\s*(FAIL|HOLD|BLOCKED)\b/gi)].map((m) => `${m[1]}: ${m[2]}`);
      const ids = [...body.matchAll(/\b(FINAL_SHA|BASE_SHA|CURRENT_SHA|ACTIVE_SHA|DEPLOYED_SHA|HEAD|BUILD_ID|RELEASE)\s*[=:]\s*([A-Za-z0-9._/-]{2,})/gi)].map((m) => `${m[1].toUpperCase()}=${m[2]}`);
      const text = behaviour === "lossy"
        ? "Compressed summary without any identifiers."
        : extractProtectedItems(body).map((item) => item.value).join("\n") + "\n" + pairs.join("\n") + "\n" + ids.join("\n");
      const result = { stopReason: "stop", content: [{ type: "text", text }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, timestamp: Date.now() };
      if (behaviour === "slow-ok") {
        return Object.assign((async function* () { await new Promise((r) => setTimeout(r, 25)); yield { type: "text_end", partial: result }; })(), { result: async () => result });
      }
      return Object.assign((async function* () { yield { type: "text_end", partial: result }; })(), { result: async () => result });
    },
  };
  return { calls, ctx: {
    model: { provider: "fake", id: "m" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {}, env: {} }), getProvider: () => provider, find: () => undefined },
    ui: { notify: () => {} },
    sessionManager: { getSessionId: () => session },
  } };
}

export const cfgOn = { ...DEFAULT_CONFIG, protectedSummaryCompression: true };
export const cfgOff = { ...DEFAULT_CONFIG, protectedSummaryCompression: false };
export const batch = (toolCalls) => ({ turnIndex: 1, timestamp: 1, toolCalls });
export const variation = (n) => batch([{ toolName: "bash", toolCallId: `v${n}`, args: { command: `step ${n}` }, resultText: `FINAL_SHA=${SHA(n)} ${PATH} status PASS`.replace("PASS", "PASS"), isError: false }]);
