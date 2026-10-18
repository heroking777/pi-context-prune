// Phase6 test/verification entry — ISOLATED TEST ARTIFACT.
//
// The extension entry (index.ts) is a Pi extension: it only exposes the default
// registration function. This entry re-exports the internals that the Phase 1-6
// regression suite and the differential harness need, so the *built* bundle can
// be exercised directly. It is never shipped and never used by Pi.
export { default } from "./index.js";
export {
  summarizeBatch,
  protectionFailureCount,
  clearProtectionFailures,
  isProtectionPaused,
  isProtectionAtCapacity,
  protectionSessionCount,
  protectionSlotCount,
  protectionAdmissionCount,
  isProtectionTracked,
  tryAdmitProtectionSession,
  releaseProtectionAdmission,
  beginProtectionSingleFlight,
  endProtectionSingleFlight,
  summarizerThinkingOptions,
  resolveModel,
  type SummarizeOutcome,
} from "./src/summarizer.js";
export {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_CONCISE,
  SYSTEM_PROMPT_FAITHFUL,
  SYSTEM_PROMPT_PROTECTED_COMPRESSED,
  PROTECTED_SUMMARY_DEFAULT_TARGET_CHARS,
  summarizerSystemPrompt,
  summarizerPromptMode,
} from "./src/summarizer-prompts.js";
export {
  extractProtectedItems,
  extractProtectedItemsDetailed,
  verifyProtectedSummary,
  protectionSignature,
  protectionFailureKey,
  protectionRejectionReason,
  PROTECTION_FAILURE_MARKER,
} from "./src/summary-protection.js";
export { loadConfig, saveConfig, normalizeConfig, SETTINGS_PATH } from "./src/config.js";
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
export { ToolCallIndexer, MAX_SEARCH_QUERY_CHARS, sanitizeSearchLimit, validateSearchQuery, deriveSearchRef } from "./src/indexer.js";
export { summarizeBatches } from "./src/summarizer-batch.js";
export { buildProtectedCore, assembleHybridSummary } from "./src/hybrid-summary.js";
export { parseRecords, expectedRecords, verifyRecords } from "./src/protected-records.js";
export { checkMarkerSubjects, subjectAtIndex } from "./src/summary-protection-semantics.js";
export { registerIndexSearchTool } from "./src/index-search-tool.js";
export { registerQueryTool } from "./src/query-tool.js";
export { formatSummaryToolCallRefs } from "./src/summary-refs.js";
export {
  MetadataObserver,
  measureSummary,
  withFlushObservation,
  withPendingBatchMetrics,
  instrumentExtensionAPI,
  recordBatchOutcome,
  recordFlushCommit,
  runWithFlushReason,
} from "./src/observability.js";
