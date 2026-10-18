// Parallel batch orchestration, split out of ./summarizer.ts to keep that
// module within the 300-line limit. Behaviour is unchanged.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CapturedBatch, ContextPruneConfig, SummarizeBatchesOptions } from "./types.js";
import { summarizeBatch, type SummarizeOutcome } from "./summarizer.js";
import { withPendingBatchMetrics } from "./observability.js";

export async function summarizeBatches(
  batches: CapturedBatch[],
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchesOptions = {}
): Promise<Array<SummarizeOutcome>> {
  if (batches.length === 0) return [];
  // Single batch — delegate to the single-batch path (no extra overhead)
  if (batches.length === 1) {
    return [
      await withPendingBatchMetrics(batches, () => summarizeBatch(batches[0], config, ctx, {
        signal: options.signal,
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(0, 1, batches[0], receivedChars);
        },
      })),
    ];
  }

  // Multiple batches — run in parallel; each produces its own SummarizeResult
  return withPendingBatchMetrics(batches, () => Promise.all(
    batches.map((batch, index) =>
      summarizeBatch(batch, config, ctx, {
        signal: options.signal,
        onTextProgress: (receivedChars) => {
          options.onBatchTextProgress?.(index, batches.length, batch, receivedChars);
        },
      })
    )
  ));
}
