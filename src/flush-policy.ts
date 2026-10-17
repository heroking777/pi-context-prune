// AI-INPUT-CONTEXT-OPT-001 / OPT-025: flush-policy predicates shared by the
// turn_end hook and the flush loop. Keeping them here (instead of inline in
// index.ts) makes each decision independently testable.
import type { CapturedBatch, ContextPruneConfig } from "./types.js";

/** Marker returned by summarizeBatch() for batches below the size floor. */
export const FLOOR_SKIPPED_MARKER = "__prunerFloorSkipped";

/** Marker returned by the flush loop for batches below the size floor. */
export type FloorSkippedResult = { __prunerFloorSkipped: true };

export function floorSkippedResult(): FloorSkippedResult {
  return { [FLOOR_SKIPPED_MARKER]: true };
}

/** Raw result-text chars for a batch (the quantity the size floor compares on). */
export function batchRawChars(batch: CapturedBatch): number {
  return batch.toolCalls.reduce((s, tc) => s + (tc.resultText?.length ?? 0), 0);
}

export function floorThreshold(config: ContextPruneConfig): number {
  const v = config.minRawCharsForSummary;
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * OPT-025 size floor: below the threshold the batch never reaches the LLM.
 * Pure predicate — observation happens once at the commit site in the flush
 * loop, so repeated calls (filter + results map) cannot double-count a skip.
 */
export function isFloorSkippedBatch(batch: CapturedBatch, threshold: number): boolean {
  return batchRawChars(batch) < threshold;
}

/**
 * OPT-001 mid-task auto-prune trigger. Fires only inside the live tool loop;
 * reuses the same runtime delivery path the context_prune tool uses.
 */
export function shouldMidTaskAutoPrune(config: ContextPruneConfig, pendingBatches: CapturedBatch[]): boolean {
  if (!config.midTaskAutoPrune) return false;
  const pendingChars = pendingBatches.reduce(
    (sum, b) => sum + b.toolCalls.reduce((s, tc) => s + tc.resultText.length, 0),
    0
  );
  const pendingCalls = pendingBatches.reduce((sum, b) => sum + b.toolCalls.length, 0);
  return pendingChars >= config.midTaskThresholdChars || pendingCalls >= config.midTaskThresholdToolCalls;
}
