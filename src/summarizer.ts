import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  CapturedBatch,
  ContextPruneConfig,
  SummarizeBatchOptions,
  SummarizeBatchesOptions,
  SummarizeResult,
} from "./types.js";
import { serializeBatchForSummarizer } from "./batch-capture.js";
import { summarizerSystemPrompt } from "./summarizer-prompts.js";
import { resolveModel, summarizerThinkingOptions, receivedTextChars } from "./summarizer-request.js";
import {
  protectionFailureKey,
  verifyProtectedSummary,
  protectionRejectionReason,
  protectionRejectionCategories,
  type ProtectionFailureResult,
} from "./summary-protection.js";
import {
  resolveProtectionSessionKey,
  getSuppressedProtectionFailure,
  rememberProtectionFailure,
  protectionFailureResult,
} from "./summary-protection-store.js";
export { protectionFailureCount, clearProtectionFailures, isProtectionPaused, isProtectionAtCapacity, protectionSessionCount } from "./summary-protection-store.js";
import type { FloorSkippedResult } from "./flush-policy.js";
import {
  CREDIT_EXHAUSTED_MARKER,
  RATE_LIMITED_MARKER,
  isCreditExhaustedFailure,
  isRateLimitFailure,
  type PrunerMarkerResult,
} from "./rate-limit.js";
import { measureSummary, withPendingBatchMetrics } from "./observability.js";

/** Result of a single summarizeBatch call: a summary, a control marker, or null (failure). */
export type SummarizeOutcome =
  | SummarizeResult
  | PrunerMarkerResult
  | FloorSkippedResult
  | ProtectionFailureResult
  | null;

// Phase32 retry-suppression state lives in ./summary-protection.ts (bounded,
// in-memory) so this module keeps its size and responsibilities contained.

export {
  summarizerThinkingOptions,
  resolveModel,
  receivedTextChars,
} from "./summarizer-request.js";

/**
 * Summarizes a captured batch. Returns formatted markdown string, or null on failure.
 * Shows user-visible errors via ctx.ui.notify.
 */
async function summarizeBatchImpl(
  batch: CapturedBatch,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions = {}
): Promise<SummarizeOutcome> {
  // Fast-fail if already aborted before we even start.
  if (options.signal?.aborted) throw new Error("summarizeBatch: aborted before start");

  const serialized = serializeBatchForSummarizer(batch);
  // Phase32/33: a batch whose compressed summary already failed in THIS session
  // is not re-sent on a later automatic flush while its content and policy are
  // unchanged. Other sessions are unaffected.
  const protectionKey = config.protectedSummaryCompression === true ? protectionFailureKey(serialized, config) : null;
  const session = protectionKey !== null ? resolveProtectionSessionKey(ctx) : null;
  if (protectionKey !== null) {
    // No safe session id: fail closed rather than share state across sessions.
    if (session?.status !== "ok") return protectionFailureResult(protectionKey, "unidentified");
    const suppressed = getSuppressedProtectionFailure(session.key, protectionKey);
    if (suppressed) return protectionFailureResult(protectionKey, suppressed);
  }

  try {
    const model = resolveModel(config, ctx);

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      const authMessage = "error" in auth ? auth.error : "authentication failed";
      ctx.ui.notify(`pruner: summarization failed: ${authMessage}`, "error");
      return null;
    }

    const provider = ctx.modelRegistry.getProvider(model.provider);
    if (!provider) {
      ctx.ui.notify(`pruner: summarization failed: unknown provider \"${model.provider}\"`, "error");
      return null;
    }

    const userMessage =
      summarizerSystemPrompt(config) + "\n\n<tool-call-batch>\n" + serialized + "\n</tool-call-batch>";

    // Use the provider-owned stream API directly. The compatibility registry
    // facade still exposes auth/header resolution, but no longer exposes a
    // top-level stream() helper of its own.
    const responseStream = provider.stream(
      auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userMessage }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        signal: options.signal,
        ...summarizerThinkingOptions(config),
        // Phase1 (AI-INPUT-CONTEXT-OPT-026): only add `maxTokens` when a positive
        // cap is configured, so the default request is byte-identical to upstream.
        ...(typeof config.summarizerMaxOutputTokens === "number" &&
        Number.isInteger(config.summarizerMaxOutputTokens) &&
        config.summarizerMaxOutputTokens > 0
          ? { maxTokens: config.summarizerMaxOutputTokens }
          : {}),
      }
    );

    let lastReportedChars = -1;
    options.onTextProgress?.(0);
    const reportTextProgress = (message: AssistantMessage) => {
      const chars = receivedTextChars(message);
      if (chars !== lastReportedChars) {
        lastReportedChars = chars;
        options.onTextProgress?.(chars);
      }
    };

    for await (const event of responseStream) {
      // Belt-and-suspenders: break early when signal fires mid-stream.
      if (options.signal?.aborted) break;
      if (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end") {
        reportTextProgress(event.partial);
      }
    }

    // If signal fired while we were iterating, propagate the abort so
    // flushPending can detect it and restore batches.
    if (options.signal?.aborted) throw new Error("summarizeBatch: aborted during stream");

    const response = await responseStream.result();
    reportTextProgress(response);
    // stopReason "aborted" means the provider cut the stream short (e.g. signal
    // fired just before the final chunk). Treat identically to the signal check
    // above — throw so flushPending's catch can detect options.signal.aborted.
    if (response.stopReason === "aborted") {
      throw new Error("summarizeBatch: stream stopped with reason aborted");
    }
    if (response.stopReason === "error") {
      const message = response.errorMessage ?? "Summarizer stopped with reason: error";
      const err = new Error(message);
      // AI-INPUT-CONTEXT-OPT-025: keep the provider response on the error so
      // 429/free-tier detection can read structured metadata (errorMessage,
      // status fields) in addition to the message text.
      (err as any).prunerResponse = response;
      throw err;
    }
    if (response.stopReason === "length") {
      // Phase1 (AI-INPUT-CONTEXT-OPT-026): the summarizer hit the configured
      // output cap. Notify and return null so flushPending keeps the raw tool
      // output pending (restore path), i.e. no summary is committed and the
      // original content is never lost.
      ctx.ui.notify(
        `pruner: summarization truncated at summarizerMaxOutputTokens=${config.summarizerMaxOutputTokens}; raw tool output kept pending`,
        "error"
      );
      return null;
    }

    const llmText = response.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    // Phase31: when protected compression is enabled, a summary that dropped an
    // enforced protected item is rejected. Returning null routes the batch
    // through the existing restore path, so raw output is never lost.
    if (config.protectedSummaryCompression === true) {
      const verdict = verifyProtectedSummary(serialized, llmText);
      if (!verdict.ok) {
        const reason = protectionRejectionReason(verdict);
        const effective = protectionKey === null
          ? reason
          : session?.status === "ok"
            ? rememberProtectionFailure(session.key, protectionKey, reason)
            : "unidentified";
        const categories = protectionRejectionCategories(verdict);
        ctx.ui.notify(
          `pruner: compressed summary rejected (${effective}${categories ? `: ${categories}` : ""}); raw tool output kept pending and not retried for this batch`,
          "error",
        );
        return protectionFailureResult(protectionKey ?? "", effective, verdict.missing);
      }
    }

    return {
      summaryText: llmText,
      usage: response.usage,
    };
  } catch (err: any) {
    // Propagate abort errors upward so flushPending can check signal.aborted
    // and return { ok: false, reason: "aborted" } without showing a UI error.
    if (options.signal?.aborted) throw err;
    if (isRateLimitFailure(err)) {
      // AI-INPUT-CONTEXT-OPT-025: 429/free-tier limit. Return a marker instead
      // of notifying here — the caller records a per-batch cooldown and stops
      // re-sending this batch until it expires. Other batches keep flushing.
      return { [RATE_LIMITED_MARKER]: true, error: err instanceof Error ? err.message : String(err) };
    }
    if (isCreditExhaustedFailure(err)) {
      // 400 insufficient-credits: same treatment as 429 (per-batch cooldown via
      // the shared machinery) but a distinct marker so operators can tell credit
      // exhaustion apart from rate limiting. Unrelated 400s fall through to the
      // generic failure path below.
      return { [CREDIT_EXHAUSTED_MARKER]: true, error: err instanceof Error ? err.message : String(err) };
    }
    ctx.ui.notify(
      `pruner: summarization failed: ${err.message}`,
      "error"
    );
    return null;
  }
}

export function summarizeBatch(
  batch: CapturedBatch,
  config: ContextPruneConfig,
  ctx: ExtensionContext,
  options: SummarizeBatchOptions = {},
): Promise<SummarizeOutcome> {
  return measureSummary(batch, config, () => summarizeBatchImpl(batch, config, ctx, options));
}

/**
 * Summarizes multiple captured batches — one LLM call per batch, run in parallel.
 *
 * Returns an array of per-batch results. Each element is either a SummarizeResult
 * (success) or null (that specific batch's call failed). The array length always
 * equals batches.length so callers can zip by index.
 *
 * Rationale for parallel-per-batch instead of a single merged call:
 *   • Each batch becomes its own summary message (one per turn), so they can be
 *     rendered, browsed, and recovered independently via context_tree_query.
 *   • Parallel calls give similar end-to-end latency to a single merged call while
 *     keeping the summaries strictly separated.
 */
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
