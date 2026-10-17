// Shared setup/state for portable offline regression modules.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const api = await import(join(here, ".test-work", "testable.mjs"));
export const { summarizerThinkingOptions, summarizerSystemPrompt, summarizerPromptMode, summarizeBatch, loadConfig, normalizeConfig,
  DEFAULT_CONFIG, SYSTEM_PROMPT, SYSTEM_PROMPT_CONCISE, SYSTEM_PROMPT_FAITHFUL,
  SYSTEM_PROMPT_PROTECTED_COMPRESSED, PROTECTED_SUMMARY_DEFAULT_TARGET_CHARS,
  extractProtectedItems, verifyProtectedSummary, protectionSignature,
  extractProtectedItemsDetailed, protectionFailureKey, PROTECTION_FAILURE_MARKER,
  protectionRejectionReason,
  protectionFailureCount, clearProtectionFailures, isProtectionPaused,
  isProtectionAtCapacity, protectionSessionCount,
  formatEvidenceAppendix: _fmt, extractEvidenceAppendix: _ext, safeToolCallText: _safe,
  MetadataObserver, measureSummary, withFlushObservation, withPendingBatchMetrics,
  instrumentExtensionAPI, recordBatchOutcome, recordFlushCommit, runWithFlushReason,
  isFloorSkippedBatch, RATE_LIMITED_MARKER, shouldMidTaskAutoPrune,
  ToolCallIndexer, registerIndexSearchTool, registerQueryTool,
  MAX_SEARCH_QUERY_CHARS, sanitizeSearchLimit, validateSearchQuery, deriveSearchRef,
  formatSummaryToolCallRefs, CUSTOM_TYPE_INDEX, CUSTOM_TYPE_SUMMARY } = api;
export const { mappedReasoningEffort } = await import("./provider-contract.mjs");
export const state = { pass: 0, fail: 0 };
export const ok = (name, cond, extra = "") => {
  if (cond) { state.pass++; console.log(`  PASS ${name}`); }
  else { state.fail++; console.log(`  FAIL ${name} ${extra}`); }
};
export function makeCtx({ stopReason = "stop", text = "SUMMARY", onOptions } = {}) {
  const calls = { notify: [] };
  const provider = {
    stream(_model, _ctxArg, options) {
      onOptions?.(options);
      const result = { stopReason, content: [{ type: "text", text }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } };
      return Object.assign((async function* () {})(), { result: async () => result });
    },
  };
  return { calls, ctx: {
    model: { provider: "commandcode", id: "deepseek/deepseek-v4.1-flash" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "stub", headers: {}, env: {} }),
      getProvider: () => provider, find: () => undefined,
    },
    ui: { notify: (m, l) => calls.notify.push([l, m]) },
  } };
}
export const batch = { turnIndex: 1, timestamp: 1, toolCalls: [{ toolName: "bash", toolCallId: "t1", resultText: "x".repeat(400), args: { command: "git status" } }] };
export const baseCfg = { summarizerModel: "default", summarizerThinking: "default", summarizerMaxOutputTokens: null, conciseSummaryMode: false };
export { here, join };
