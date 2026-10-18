/**
 * context-prune — Pi extension entry point
 *
 * Wires together all modules:
 *   config       — load/save ~/.pi/agent/context-prune/settings.json
 *   batch-capture — serialize turn_end event into CapturedBatch
 *   summarizer   — call LLM to summarize a CapturedBatch
 *   indexer      — maintain Map<toolCallId, ToolCallRecord> + session persistence
 *   pruner       — filter context event messages
 *   query-tool   — register context_tree_query tool
 *   commands     — register /pruner command + message renderer
 *
 * Usage:  pi -e .
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./src/config.js";
import { captureBatch, captureUnindexedBatchesFromSession, groupBatchesByMode } from "./src/batch-capture.js";
import { summarizeBatch } from "./src/summarizer.js";
import { summarizeBatches } from "./src/summarizer-batch.js";
import { ToolCallIndexer } from "./src/indexer.js";
import { pruneMessages } from "./src/pruner.js";
import { annotateWithUnprunedCount, countUnprunedToolCalls } from "./src/reminder.js";
import { registerQueryTool } from "./src/query-tool.js";
import { registerIndexSearchTool } from "./src/index-search-tool.js";
import { registerCommands, setPruneStatusWidget } from "./src/commands.js";
import { formatSummaryToolCallRefs, makeSummaryDetails, wrapSummaryForContext } from "./src/summary-refs.js";
import { formatEvidenceAppendix } from "./src/evidence-appendix.js";
import {
  CREDIT_EXHAUSTED_MARKER,
  RATE_LIMITED_MARKER,
  RateLimitRegistry,
  rateLimitBatchKey,
} from "./src/rate-limit.js";
import {
  FLOOR_SKIPPED_MARKER,
  batchRawChars,
  floorSkippedResult,
  floorThreshold,
  isFloorSkippedBatch,
  shouldMidTaskAutoPrune,
} from "./src/flush-policy.js";
import type { SummarizeOutcome } from "./src/summarizer.js";
import type { ContextPruneConfig, CapturedBatch, IndexEntryData, PruneFrontier, FlushOptions, SummarizeResult } from "./src/types.js";
import {
  DEFAULT_CONFIG,
  CONTEXT_PRUNE_TOOL_NAME,
  CONTEXT_TAG_TOOL_NAMES,
  AGENTIC_AUTO_SYSTEM_PROMPT,
  CUSTOM_TYPE_SUMMARY,
  CUSTOM_TYPE_INDEX,
  CUSTOM_TYPE_STATS,
  CUSTOM_TYPE_FRONTIER,
} from "./src/types.js";
import { StatsAccumulator } from "./src/stats.js";
import { registerContextPruneTool } from "./src/context-prune-tool.js";
import { PruneFrontierTracker } from "./src/frontier.js";
import { instrumentExtensionAPI, recordBatchOutcome, recordFlushCommit, runWithFlushReason } from "./src/observability.js";
import { PROTECTION_FAILURE_MARKER } from "./src/summary-protection.js";

export default function (pi: ExtensionAPI) {
  // Shared mutable config reference — updated by /pruner commands
  const currentConfig: { value: ContextPruneConfig } = {
    value: { ...DEFAULT_CONFIG, pruneOn: "every-turn" },
  };
  pi = instrumentExtensionAPI(pi, () => currentConfig.value, import.meta.url);

  // Shared indexer — rebuilt from session on every session_start / session_tree
  const indexer = new ToolCallIndexer();

  // Shared stats accumulator — tracks cumulative token/cost stats for summarizer calls
  const statsAccum = new StatsAccumulator();

  // Shared prune frontier — tracks the last completed prune attempt boundary
  const frontier = new PruneFrontierTracker();

  // Pending batches — accumulated until the prune trigger fires
  const pendingBatches: CapturedBatch[] = [];
  // AI-INPUT-CONTEXT-OPT-025: in-memory per-batch 429/free-tier cooldown state,
  // keyed by sorted toolCallIds. Not persisted across process restarts
  // (RESTART_PERSISTENCE=NO): after a restart a blocked batch is retried at
  // most once before re-entering cooldown, so the retry loop stays bounded.
  const rateLimitCooldowns = new RateLimitRegistry(() => currentConfig.value.rateLimitCooldownMs);
  let isFlushing = false;

  type FlushResult =
    | { ok: true; reason: "flushed" | "skipped-oversized"; batchCount: number; toolCallCount: number; rawCharCount: number; summaryCharCount: number }
    | {
        ok: false;
        reason:
          | "empty"
          | "already-flushing"
          | "summarizer-failed"
          | "stale-context"
          | "failed"
          | "aborted"
          | "rate-limited"
          | "rate-limited-cooldown"
          | "credit-exhausted";
        error?: string;
        rateLimitedCount?: number;
      };

  type SessionAppender = {
    appendCustomEntry(customType: string, data?: unknown): string;
    appendCustomMessageEntry(customType: string, content: string, display: boolean, details?: unknown): string;
  };

  const isStaleContextError = (err: unknown) =>
    err instanceof Error && err.message.includes("This extension ctx is stale");

  const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const safeNotify = (ctx: any, message: string, type: "info" | "warning" | "error" = "info") => {
    try {
      ctx.ui.notify(message, type);
    } catch (err) {
      if (!isStaleContextError(err)) throw err;
    }
  };

  const assistantMessageHasToolCalls = (message: any) =>
    message?.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((block: any) => block?.type === "toolCall");

  const isFinalAssistantMessage = (message: any) => message?.role === "assistant" && !assistantMessageHasToolCalls(message);

  const trimBatchToPendingRange = (batch: CapturedBatch): CapturedBatch | null => {
    const currentFrontier = frontier.get();
    // AI-INPUT-CONTEXT-OPT-025: a batch with a recorded 429/free-tier cooldown
    // must survive the frontier trim while blocked OR awaiting its post-cooldown
    // retry. Without this, a later successful flush would advance the frontier
    // past its turn and the batch would never be retried (its raw results would
    // linger un-indexed forever).
    const rateLimited = rateLimitCooldowns.has(batch);
    let toolCalls = batch.toolCalls;

    // The indexer tells us what was successfully summarized earlier.
    toolCalls = toolCalls.filter((tc) => !indexer.isSummarized(tc.toolCallId));
    if (toolCalls.length === 0) return null;

    // The frontier tells us the last attempted boundary even when the attempt did
    // not persist index entries (e.g. skipped-oversized). When the LLM prunes in
    // the middle of a long tool chain, keep later tool calls from the same turn
    // instead of dropping the whole batch on the floor.
    if (!currentFrontier || rateLimited) return { ...batch, toolCalls };
    if (batch.turnIndex < currentFrontier.lastAttemptedTurnIndex) return null;
    if (batch.turnIndex > currentFrontier.lastAttemptedTurnIndex) return { ...batch, toolCalls };

    const originalIndex = toolCalls.findIndex((tc) => tc.toolCallId === currentFrontier.lastAttemptedToolCallId);
    if (originalIndex < 0) return { ...batch, toolCalls };

    const remaining = toolCalls.slice(originalIndex + 1);
    if (remaining.length === 0) return null;
    return { ...batch, toolCalls: remaining };
  };

  const restoreBatches = (batches: CapturedBatch[]) => {
    pendingBatches.unshift(...batches);
  };

  const persistBatchIndex = (batch: CapturedBatch, appendEntry: (customType: string, data?: unknown) => void) => {
    const records = batch.toolCalls.map((tc) => ({
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: tc.args,
      resultText: tc.resultText,
      isError: tc.isError,
      turnIndex: batch.turnIndex,
      timestamp: batch.timestamp,
    }));

    for (const record of records) {
      indexer.indexPersistedRecord(record);
    }

    appendEntry(CUSTOM_TYPE_INDEX, { toolCalls: records } as IndexEntryData);
  };

  // ── Helper: capture + trim + group pending batches (no LLM work) ──────────
  // Exposed to commands.ts via registerCommands so /pruner now can preview the
  // queue before opening the multi-row progress overlay.
  const capturePendingBatches = (ctx: any): CapturedBatch[] => {
    let batches: CapturedBatch[] = [];
    try {
      const branch = ctx.sessionManager.getBranch();
      batches = captureUnindexedBatchesFromSession(branch, indexer, [CONTEXT_PRUNE_TOOL_NAME], ctx.cwd);
    } catch {
      batches = pendingBatches.slice();
    }
    batches = batches
      .map((batch) => trimBatchToPendingRange(batch))
      .filter((batch): batch is CapturedBatch => batch !== null);
    return groupBatchesByMode(batches, currentConfig.value.batchingMode);
  };

  // Summarizes + indexes all pending batches.
  // When options.onProgress is provided batches are processed sequentially
  // (one LLM call each) so the caller can update per-row UI. Otherwise all
  // batches are summarized in parallel (one summarizeBatches call).
  // Runtime delivery is used while the agent/tool loop is active so Pi can place
  // steer messages at protocol-safe boundaries. Session delivery is used only for
  // agent-message's final-message flush, where print-mode Pi may invalidate pi.*
  // while the summarizer LLM call is in flight.
  const flushPending = async (ctx: any, options: FlushOptions = {}): Promise<FlushResult> => {
    if (isFlushing) return { ok: false, reason: "already-flushing" };

    // Use pre-captured batches if provided (avoids double-capture when the
    // caller previewed the queue before opening the progress overlay).
    let batches: CapturedBatch[] = options.previewedBatches ?? capturePendingBatches(ctx);

    if (batches.length === 0) return { ok: false, reason: "empty" };

    // Bail out before we drain pendingBatches so they don't need restoring.
    if (options.signal?.aborted) return { ok: false, reason: "aborted" };

    // AI-INPUT-CONTEXT-OPT-025: never re-send batches currently in 429/free-tier
    // cooldown. They stay un-indexed in the session (raw tool results preserved);
    // once the cooldown expires the batch is retried exactly once.
    const now = Date.now();
    let blockedCount = 0;
    let firstBlockedError: string | null = null;
    batches = batches.filter((batch) => {
      if (!rateLimitCooldowns.isBlocked(batch, now)) return true;
      blockedCount++;
      const lastError = rateLimitCooldowns.lastError(batch);
      if (firstBlockedError === null && lastError) firstBlockedError = lastError;
      return false;
    });
    if (batches.length === 0) {
      return {
        ok: false,
        reason: "rate-limited-cooldown",
        rateLimitedCount: blockedCount,
        error: firstBlockedError ?? undefined,
      };
    }

    // Draining the queue since we've captured the state via session or slice.
    // We drain BEFORE the await so concurrent calls (though guarded by isFlushing)
    // or rapid turn-ends don't result in double-summarization.
    pendingBatches.length = 0;

    isFlushing = true;

    const delivery = options.delivery ?? "runtime";
    let sessionManager: SessionAppender | undefined;
    if (delivery === "session") {
      try {
        sessionManager = ctx.sessionManager as unknown as SessionAppender;
      } catch (err) {
        restoreBatches(batches);
        isFlushing = false;
        return { ok: false, reason: isStaleContextError(err) ? "stale-context" : "failed", error: errorMessage(err) };
      }
    }

    const appendEntry = (customType: string, data?: unknown) => sessionManager!.appendCustomEntry(customType, data);
    const appendSummaryMessage = (content: string, details: unknown) =>
      sessionManager!.appendCustomMessageEntry(CUSTOM_TYPE_SUMMARY, content, false, details);

    try {
      setPruneStatusWidget(ctx, currentConfig.value, "prune: summarizing…");

      const reportBatchTextProgress = (index: number, total: number, batch: CapturedBatch, receivedChars: number) => {
        options.onBatchTextProgress?.(index, total, batch, receivedChars);
      };

      // Summarize batches. When onProgress is provided (i.e. /pruner now with the
      // multi-row overlay) we process sequentially so each row can be checked off
      // as its LLM call completes. Otherwise all batches run in parallel.
      let results: SummarizeOutcome[];
      // OPT-025 size floor: batches below minRawCharsForSummary never reach the
      // summarizer LLM. They are flagged here and committed via the
      // oversized-style no-summary path in the result loop below.
      const floor = floorThreshold(currentConfig.value);
      const llmBatches: CapturedBatch[] = [];
      const llmPositions: number[] = [];
      batches.forEach((b, i) => {
        if (!isFloorSkippedBatch(b, floor)) {
          llmBatches.push(b);
          llmPositions.push(i);
        }
      });
      results = batches.map((b) =>
        isFloorSkippedBatch(b, floor) ? floorSkippedResult() : null
      );
      if (options.onProgress) {
        for (let k = 0; k < llmBatches.length; k++) {
          const i = llmPositions[k];
          options.onProgress(i, batches.length, batches[i], "start");
          const r = await summarizeBatch(batches[i], currentConfig.value, ctx, {
            signal: options.signal,
            onTextProgress: (receivedChars) => {
              reportBatchTextProgress(i, batches.length, batches[i], receivedChars);
            },
          });
          results[i] = r;
          const marker = r && ((r as any)[RATE_LIMITED_MARKER] || (r as any)[CREDIT_EXHAUSTED_MARKER]);
          const protected_failed = r && (r as any)[PROTECTION_FAILURE_MARKER];
          options.onProgress(i, batches.length, batches[i], marker || protected_failed ? "skipped" : r ? "done" : "skipped");
        }
      } else if (llmBatches.length > 0) {
        // Parallel — one LLM call per batch, all in flight simultaneously.
        const llmResults = await summarizeBatches(llmBatches, currentConfig.value, ctx, {
          onBatchTextProgress: reportBatchTextProgress,
          signal: options.signal,
        });
        llmResults.forEach((r, k) => {
          results[llmPositions[k]] = r;
        });
      }

      // Process results in order; stop at first null (individual call failure).
      // Batches before the first failure are persisted; remaining are restored to
      // pendingBatches so they are retried on the next flush.
      const processedBatches: CapturedBatch[] = [];
      let totalRawCharCount = 0;
      let totalSummaryCharCount = 0;
      let totalToolCallCount = 0;
      const oversizedBatches: CapturedBatch[] = [];
      const floorSkippedBatches: CapturedBatch[] = [];
      let firstFailureIndex = -1;
      let rateLimitedCount = 0;
      let firstRateLimitError: string | null = null;
      let creditLimitedCount = 0;
      let firstCreditError: string | null = null;

      for (let i = 0; i < batches.length; i++) {
        const result = results[i];
        if (!result) {
          firstFailureIndex = i;
          break;
        }
        if ((result as any)[PROTECTION_FAILURE_MARKER]) {
          firstFailureIndex = i;
          break;
        }

        const batch = batches[i];
        if ((result as any)[FLOOR_SKIPPED_MARKER]) {
          // OPT-025 size floor: no LLM call was made. Index the full raw records
          // via the delivery-specific success mechanism (no summary, no usage)
          // and treat the batch as completed so the frontier advances past it
          // exactly like an oversized skip.
          try {
            if (delivery === "runtime") {
              indexer.addBatch(batch, pi);
            } else {
              persistBatchIndex(batch, appendEntry);
            }
          } catch (err) {
            if (isStaleContextError(err)) {
              restoreBatches(batches.slice(i));
              break;
            }
            throw err;
          }
          totalRawCharCount += batchRawChars(batch);
          totalToolCallCount += batch.toolCalls.length;
          floorSkippedBatches.push(batch);
          recordBatchOutcome(batch, "skipped-size-floor", { indexPersisted: true, threshold: floor });
          processedBatches.push(batch);
          rateLimitCooldowns.clear(batch);
          continue;
        }
        if ((result as any)[RATE_LIMITED_MARKER]) {
          // AI-INPUT-CONTEXT-OPT-025: 429/free-tier limit. Record the cooldown,
          // notify once (cooldown start), and keep the rest of the flush going.
          // The batch is neither indexed nor restored for immediate re-send; it
          // stays in the session and is retried once after the cooldown expires.
          const err = (result as any).error;
          const rec = rateLimitCooldowns.record(batch, err);
          recordBatchOutcome(batch, "rate-limited", { indexPersisted: false });
          rateLimitedCount++;
          if (firstRateLimitError === null) firstRateLimitError = err;
          safeNotify(
            ctx,
            `pruner: summarizer rate-limited (${err}) — retries paused for this batch ~${Math.max(1, Math.round(rec.cooldownMs / 60000))} min`,
            "warning"
          );
          continue;
        }
        if ((result as any)[CREDIT_EXHAUSTED_MARKER]) {
          // 400 insufficient-credits: shared per-batch cooldown machinery,
          // distinct operator signal. Batch stays pending until cooldown expiry;
          // it is NOT restored for immediate re-send.
          const err = (result as any).error;
          const creditRec = rateLimitCooldowns.record(batch, err);
          recordBatchOutcome(batch, "credit-exhausted", { indexPersisted: false });
          creditLimitedCount++;
          if (firstCreditError === null) firstCreditError = err;
          safeNotify(
            ctx,
            `pruner: summarizer credit exhausted (${err}) — retries paused for this batch ~${Math.max(1, Math.round(creditRec.cooldownMs / 60000))} min`,
            "warning"
          );
          continue;
        }
        const summaryResult = result as import("./src/types.js").SummarizeResult;

        const batchRawCharCount = batchRawChars(batch);
        const summaryRefs = indexer.allocateSummaryRefs(batch);
        // Phase4: the oversized guard keeps its original semantics (model summary
        // + refs vs raw output), so the deterministic appendix can never change
        // whether a summary is committed or skipped. The appendix carries its own
        // raw-relative size budget instead (see formatEvidenceAppendix).
        const modelSummaryText = summaryResult.summaryText + formatSummaryToolCallRefs(summaryRefs);
        const shouldSkipOversized = modelSummaryText.length > batchRawCharCount;
        const appendix =
          currentConfig.value.evidenceAppendix === true
            ? formatEvidenceAppendix(batch.toolCalls, currentConfig.value, batchRawCharCount)
            : "";
        const summaryText = wrapSummaryForContext(modelSummaryText + appendix);

        statsAccum.add(summaryResult.usage);
        totalRawCharCount += batchRawCharCount;
        totalSummaryCharCount += summaryText.length;
        totalToolCallCount += batch.toolCalls.length;

        const batchDetails = makeSummaryDetails(batch, summaryRefs);

        try {
          if (!shouldSkipOversized) {
            // Phase37: persist the index entry FIRST, then commit the summary.
            // Tier-2 detail may be omitted from the summary only while the raw
            // output is retrievable, so the index write must succeed before the
            // summary is exposed. If indexing fails, the summary is never shown
            // and the batch stays on the existing restore path.
            if (delivery === "runtime") {
              indexer.registerSummaryRefs(summaryRefs);
              indexer.addBatch(batch, pi);
              pi.sendMessage(
                { customType: CUSTOM_TYPE_SUMMARY, content: summaryText, display: false, details: batchDetails },
                { deliverAs: "steer" }
              );
            } else {
              indexer.registerSummaryRefs(summaryRefs);
              persistBatchIndex(batch, appendEntry);
              appendSummaryMessage(summaryText, batchDetails);
            }
            recordBatchOutcome(batch, "summarized", { indexPersisted: true });
          } else {
            oversizedBatches.push(batch);
            recordBatchOutcome(batch, "skipped-oversized", { indexPersisted: false });
          }
        } catch (err) {
          // Persistence error mid-loop: stop here, restore this and remaining batches.
          if (isStaleContextError(err)) {
            restoreBatches(batches.slice(i));
            // Advance frontier to what we managed to persist before this point
            break;
          }
          throw err;
        }

        processedBatches.push(batch);
        rateLimitCooldowns.clear(batch);
      }

      // Observe the first failed batch (the loop stops at the first null
      // result; later batches were never attempted so they are not recorded).
      if (firstFailureIndex >= 0) {
        recordBatchOutcome(batches[firstFailureIndex], "failed", { indexPersisted: false });
      }

      // Restore unprocessed batches (those at and after the first failure)
      if (firstFailureIndex >= 0) {
        restoreBatches(batches.slice(firstFailureIndex));
      }

      if (processedBatches.length === 0) {
        // Nothing was persisted (all calls failed or first call failed)
        setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
        if (creditLimitedCount > 0 && rateLimitedCount === 0 && firstFailureIndex < 0) {
          return { ok: false, reason: "credit-exhausted", rateLimitedCount: creditLimitedCount, error: firstCreditError ?? "" };
        }
        if (rateLimitedCount > 0 && firstFailureIndex < 0) {
          return { ok: false, reason: "rate-limited", rateLimitedCount, error: firstRateLimitError ?? "" };
        }
        return { ok: false, reason: "summarizer-failed" };
      }

      // Advance frontier to the last batch we actually processed.
      const lastBatch = processedBatches[processedBatches.length - 1];
      const lastTC = lastBatch.toolCalls[lastBatch.toolCalls.length - 1];
      const allOversized = oversizedBatches.length === processedBatches.length;
      const allFloorSkipped = floorSkippedBatches.length === processedBatches.length;
      const frontierSnapshot: PruneFrontier = {
        lastAttemptedToolCallId: lastTC.toolCallId,
        lastAttemptedToolName: lastTC.toolName,
        lastAttemptedTurnIndex: lastBatch.turnIndex,
        lastAttemptedTimestamp: lastBatch.timestamp,
        attemptedBatchCount: processedBatches.length,
        attemptedToolCallCount: totalToolCallCount,
        rawCharCount: totalRawCharCount,
        summaryCharCount: totalSummaryCharCount,
        outcome: allOversized ? "skipped-oversized" : allFloorSkipped ? "skipped-size-floor" : "summarized",
      };

      const commitOutcome = allOversized ? "skipped-oversized" : allFloorSkipped ? "skipped-size-floor" : "summarized";
      const commitInfo = {
        processedBatchCount: processedBatches.length,
        attemptedToolCallCount: totalToolCallCount,
        rawCharCount: totalRawCharCount,
        summaryCharCount: totalSummaryCharCount,
      };
      let frontierPersisted = false;
      let statsPersisted = false;
      try {
        if (delivery === "runtime") {
          frontier.advance(frontierSnapshot);
          frontier.persist(pi);
          frontierPersisted = true;
          statsAccum.persist(pi);
          statsPersisted = true;
        } else {
          frontier.advance(frontierSnapshot);
          appendEntry(CUSTOM_TYPE_FRONTIER, frontierSnapshot);
          frontierPersisted = true;
          try {
            appendEntry(CUSTOM_TYPE_STATS, statsAccum.getStats());
            statsPersisted = true;
          } catch {
            // Ignore stats persistence failures; the prune result and frontier are the contract.
          }
        }
      } catch (err) {
        recordFlushCommit({ outcome: "failed-persist", frontierPersisted, statsPersisted, ...commitInfo });
        return { ok: false, reason: isStaleContextError(err) ? "stale-context" : "failed", error: errorMessage(err) };
      }
      recordFlushCommit({ outcome: commitOutcome, frontierPersisted, statsPersisted, ...commitInfo });

      setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());

      // Notify about any oversized batches that were skipped
      for (const batch of oversizedBatches) {
        const batchRaw = batch.toolCalls.reduce((s, tc) => s + tc.resultText.length, 0);
        // Oversized batches always carry a real SummarizeResult (markers never
        // reach this list), so the cast is total here.
        const oversizedOutcome = results[batches.indexOf(batch)] as SummarizeResult | null | undefined;
        const batchSummaryLen = oversizedOutcome?.summaryText.length ?? 0;
        safeNotify(
          ctx,
          `pruner: skipped pruning turn ${batch.turnIndex} (${batch.toolCalls.length} tool call${batch.toolCalls.length === 1 ? "" : "s"}) — summary was ${batchSummaryLen} chars vs ${batchRaw} raw chars; frontier advanced past this range`,
          "warning"
        );
      }

      return {
        ok: true,
        reason: allOversized ? "skipped-oversized" : "flushed",
        batchCount: processedBatches.length,
        toolCallCount: totalToolCallCount,
        rawCharCount: totalRawCharCount,
        summaryCharCount: totalSummaryCharCount,
      };
    } catch (err) {
      restoreBatches(batches);
      // When the abort signal fired, summarizeBatch rethrows rather than
      // swallowing the error.  Don't show a UI error — the user intended this.
      if (options.signal?.aborted) {
        setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());
        return { ok: false, reason: "aborted" };
      }
      if (isStaleContextError(err)) {
        return { ok: false, reason: "stale-context", error: errorMessage(err) };
      }
      safeNotify(ctx, `pruner: summarization failed: ${errorMessage(err)}`, "error");
      return { ok: false, reason: "failed", error: errorMessage(err) };
    } finally {
      isFlushing = false;
    }
  };

  // ── Helper: toggle context_prune tool activation based on config ───────────
  // Uses `pi` (ExtensionRuntime) because getActiveTools/setActiveTools are
  // runtime methods, NOT part of ExtensionContext/ExtensionCommandContext.
  const syncToolActivation = () => {
    const shouldActivate = currentConfig.value.enabled && currentConfig.value.pruneOn === "agentic-auto";
    const activeTools = pi.getActiveTools();
    if (shouldActivate) {
      if (!activeTools.includes(CONTEXT_PRUNE_TOOL_NAME)) {
        pi.setActiveTools([...activeTools, CONTEXT_PRUNE_TOOL_NAME]);
      }
    } else {
      if (activeTools.includes(CONTEXT_PRUNE_TOOL_NAME)) {
        pi.setActiveTools(activeTools.filter((t: string) => t !== CONTEXT_PRUNE_TOOL_NAME));
      }
    }
  };

  // ── session_start: restore config + index + stats ────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    // Load config from ~/.pi/agent/context-prune/settings.json
    currentConfig.value = await loadConfig();

    // Rebuild in-memory index from persisted session entries
    indexer.reconstructFromSession(ctx);

    // Rebuild stats accumulator from persisted session entries
    statsAccum.reconstructFromSession(ctx);

    // Rebuild prune frontier from persisted session entries
    frontier.reconstructFromSession(ctx);

    // Clear any batches queued before the session reload
    pendingBatches.length = 0;

    // Update footer status
    setPruneStatusWidget(ctx, currentConfig.value, statsAccum.getStats());

    // Toggle context_prune tool activation for agentic-auto mode
    syncToolActivation();

    if (currentConfig.value.showStartupNotice) {
      ctx.ui.notify(
        `pruner loaded — pruning ${currentConfig.value.enabled ? "ON" : "OFF"} | model: ${currentConfig.value.summarizerModel}`,
        "info"
      );
    }
  });

  // Rebuild index and stats after tree navigation too (branch may have different history)
  pi.on("session_tree", async (_event, ctx) => {
    indexer.reconstructFromSession(ctx);
    statsAccum.reconstructFromSession(ctx);
    frontier.reconstructFromSession(ctx);
    // Pending batches belong to the old branch — discard them
    pendingBatches.length = 0;
  });

  // ── turn_end: capture batch, flush immediately or queue ──────────────────
  pi.on("turn_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;

    const hasToolResults = event.toolResults && event.toolResults.length > 0;

    if (!hasToolResults) {
      // Text-only final turns are handled by message_end in agent-message mode.
      // In print mode, turn_end can fire after session shutdown, so do not start
      // deferred LLM work from this late lifecycle event.
      return;
    }

    const capturedBatch = captureBatch(
      event.message,
      event.toolResults,
      event.turnIndex,
      Date.now()
    );
    const batch = trimBatchToPendingRange({
      ...capturedBatch,
      // Do not summarize the pruner's own housekeeping tool result. Otherwise
      // agentic-auto mode can queue the context_prune result and try to flush it
      // during agent_end, when Pi may already have invalidated the extension ctx.
      toolCalls: capturedBatch.toolCalls.filter((tc) => tc.toolName !== CONTEXT_PRUNE_TOOL_NAME),
    });
    if (!batch) return;

    pendingBatches.push(batch);

    if (currentConfig.value.pruneOn === "every-turn") {
      await runWithFlushReason("every_turn", () => flushPending(ctx, { delivery: "session" }));
    } else {
      // AI-INPUT-CONTEXT-OPT-001: mid-task auto-prune. Reuses the exact runtime
      // delivery path the context_prune tool uses (summarize -> steer summary ->
      // index; the context hook then prunes the raw outputs from the next
      // request). Only fires inside the tool loop while this user task is still
      // running, so the agent continues with compact state.
      if (shouldMidTaskAutoPrune(currentConfig.value, pendingBatches)) {
        await runWithFlushReason("threshold", () => flushPending(ctx, { delivery: "runtime" }));
        return;
      }
      // Let the user know a batch is queued
      const n = pendingBatches.length;
      let trigger: string;
      switch (currentConfig.value.pruneOn) {
        case "on-context-tag":
          trigger = "next context_checkpoint";
          break;
        case "agent-message":
          trigger = "agent's next text response";
          break;
        case "agentic-auto":
          trigger = "agent calling context_prune";
          break;
        default:
          trigger = "/pruner now";
          break;
      }
      if (currentConfig.value.showPruneStatusLine) {
        setPruneStatusWidget(ctx, currentConfig.value, `prune: ${n} pending`);
        safeNotify(
          ctx,
          `pruner: ${n} turn${n === 1 ? "" : "s"} queued — will summarize on ${trigger}`,
          "info"
        );
      }
    }
  });

  // ── tool_execution_end: flush when context_checkpoint (or legacy context_tag) fires ──
  pi.on("tool_execution_end", async (event, ctx) => {
    if (!(CONTEXT_TAG_TOOL_NAMES as readonly string[]).includes(event.toolName)) return;
    if (!currentConfig.value.enabled) return;
    if (currentConfig.value.pruneOn !== "on-context-tag") return;
    await runWithFlushReason("context_tag_tool", () => flushPending(ctx, { delivery: "runtime" }));
  });

  // ── message_end: flush after the final assistant response in agent-message mode ──
  // A final assistant message is the earliest reliable boundary where the agent has
  // finished using the raw tool results. flushPending captures the SessionManager
  // before awaiting summarization so print-mode shutdown cannot invalidate the
  // persistence path while the summarizer model is running.
  pi.on("message_end", async (event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (currentConfig.value.pruneOn !== "agent-message") return;
    if (!isFinalAssistantMessage(event.message)) return;
    await runWithFlushReason("message_end", () => flushPending(ctx, { delivery: "session" }));
  });

  // ── agent_end: last-chance cleanup only ─────────────────────────────────────
  // agent-message normally flushes on message_end. By agent_end, print-mode Pi may
  // already be disposing the session, so avoid starting a best-effort LLM call here.
  pi.on("agent_end", async (_event, ctx) => {
    if (!currentConfig.value.enabled) return;
    if (pendingBatches.length === 0) return;
    setPruneStatusWidget(ctx, currentConfig.value, `prune: ${pendingBatches.length} pending`);
  });

  // ── context: prune summarized tool results from next LLM call ─────────────
  pi.on("context", async (event, _ctx) => {
    if (!currentConfig.value.enabled) return undefined;

    const indexEmpty = indexer.getIndex().size === 0;
    let messages = event.messages;
    let changed = false;

    if (!indexEmpty) {
      const pruned = pruneMessages(messages, indexer);
      if (pruned.length !== messages.length) {
        messages = pruned;
        changed = true;
      }
    }

    // Append a small `<pruner-note>` to the last toolResult telling the model
    // how many unpruned tool calls are sitting in context. Only active in
    // agentic-auto mode (where the LLM itself decides when to call
    // context_prune) and only when the user has the reminder enabled.
    if (
      currentConfig.value.pruneOn === "agentic-auto" &&
      currentConfig.value.remindUnprunedCount
    ) {
      const count = countUnprunedToolCalls(messages, indexer);
      if (count > 0) {
        const annotated = annotateWithUnprunedCount(messages, count);
        if (annotated !== messages) {
          messages = annotated;
          changed = true;
        }
      }
    }

    if (!changed) return undefined;
    return { messages };
  });

  // ── before_agent_start: inject system prompt for agentic-auto mode ───────────
  pi.on("before_agent_start", async (event, _ctx) => {
    if (!currentConfig.value.enabled || currentConfig.value.pruneOn !== "agentic-auto") return undefined;
    // Append agentic-auto instructions to the system prompt
    const appended = AGENTIC_AUTO_SYSTEM_PROMPT;
    const original = event.systemPrompt ?? "";
    const newPrompt = original + "\n\n" + appended;
    return { systemPrompt: newPrompt };
  });

  // ── Register context_tree_query tool ──────────────────────────────────────
  registerQueryTool(pi, indexer);

  // ── Register context_index_search tool (explicit lookup without a ref) ────
  registerIndexSearchTool(pi, indexer);

  // ── Register context_prune tool (always registered, activated only in agentic-auto mode) ──
  registerContextPruneTool(pi, (ctx, options) => flushPending(ctx, { delivery: "runtime", ...options }));

  // ── Register /pruner command + summary message renderer ────────────
  registerCommands(pi, currentConfig, flushPending, capturePendingBatches, syncToolActivation, () => statsAccum.getStats(), indexer);
}
