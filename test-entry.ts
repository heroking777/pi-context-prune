// Phase6 test/verification entry — ISOLATED TEST ARTIFACT.
//
// The extension entry (index.ts) is a Pi extension: it only exposes the default
// registration function. This entry re-exports the internals that the Phase 1-6
// regression suite and the differential harness need, so the *built* bundle can
// be exercised directly. It is never shipped and never used by Pi.
export { default } from "./index.js";
export {
  summarizeBatch,
  summarizeBatches,
  summarizerThinkingOptions,
  resolveModel,
  type SummarizeOutcome,
} from "./src/summarizer.js";
export {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_CONCISE,
  SYSTEM_PROMPT_FAITHFUL,
  summarizerSystemPrompt,
  summarizerPromptMode,
} from "./src/summarizer-prompts.js";
export { loadConfig, saveConfig, SETTINGS_PATH } from "./src/config.js";
export {
  DEFAULT_CONFIG,
  CUSTOM_TYPE_SUMMARY,
  CUSTOM_TYPE_INDEX,
  CUSTOM_TYPE_STATS,
  CUSTOM_TYPE_FRONTIER,
} from "./src/types.js";
export {
  formatEvidenceAppendix,
  extractEvidenceAppendix,
  safeToolCallText,
} from "./src/evidence-appendix.js";
export {
  isRateLimitFailure,
  isCreditExhaustedFailure,
  rateLimitBatchKey,
  RATE_LIMITED_MARKER,
  CREDIT_EXHAUSTED_MARKER,
  RATE_LIMIT_DEFAULT_COOLDOWN_MS,
  RateLimitRegistry,
} from "./src/rate-limit.js";
export {
  FLOOR_SKIPPED_MARKER,
  batchRawChars,
  floorThreshold,
  isFloorSkippedBatch,
  shouldMidTaskAutoPrune,
} from "./src/flush-policy.js";
export { serializeBatchForSummarizer } from "./src/batch-capture.js";
export {
  MetadataObserver,
  measureSummary,
  withFlushObservation,
  withPendingBatchMetrics,
  instrumentExtensionAPI,
  recordBatchOutcome,
  runWithFlushReason,
} from "./src/observability.js";
