import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapturedBatch, ContextPruneConfig } from "./types.js";
import { CREDIT_EXHAUSTED_MARKER, RATE_LIMITED_MARKER } from "./rate-limit.js";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const RETENTION_DAYS = 7;
const LOG_PATTERN = /^pruner-([0-9]{4}-[0-9]{2}-[0-9]{2})\.jsonl$/;
const CONFIG_KEYS = [
  "enabled", "showPruneStatusLine", "showStartupNotice", "pruneOn", "remindUnprunedCount",
  "notifySkipped", "batchingMode", "midTaskAutoPrune", "midTaskThresholdToolCalls",
  "midTaskThresholdChars", "rateLimitCooldownMs", "minRawCharsForSummary",
  "summarizerModel", "summarizerThinking", "summarizerMaxOutputTokens",
  "conciseSummaryMode", "summarizerPromptMode", "evidenceAppendix", "evidenceAppendixMaxEntries",
  "protectedSummaryCompression", "protectedSummaryTargetChars",
] as const;

export type FlushReason =
  | "every_turn" | "threshold" | "message_end" | "manual_command"
  | "context_prune_tool" | "context_tag_tool" | "unknown";

/**
 * Commit outcomes observed at the flush-loop commit site. Distinct from the
 * per-attempt `summary_api` event: one `batch_outcome` record exists per batch
 * the loop actually processed, and it carries whether that batch reached the
 * persisted index. A summary attempt is not proof of a committed batch.
 */
export type BatchCommitOutcome =
  | "summarized" | "skipped-oversized" | "skipped-size-floor"
  | "rate-limited" | "credit-exhausted" | "failed";

export interface BatchCommitInfo {
  indexPersisted: boolean;
  threshold?: number;
}

/**
 * Persistence-phase result of one flush. `batch_outcome` records prove the index
 * side only; this record makes the frontier/stats side explicit so a flush where
 * the index succeeded but the frontier did not persist cannot be read as a
 * complete success.
 */
export interface FlushCommitInfo {
  outcome: string;
  frontierPersisted: boolean;
  statsPersisted: boolean;
  processedBatchCount: number;
  attemptedToolCallCount: number;
  rawCharCount: number;
  summaryCharCount: number;
}

export interface ObservationContext {
  reason: FlushReason;
  config: ContextPruneConfig | null;
  observer: MetadataObserver;
  pendingCallCount: number | null;
  pendingRawCharCount: number | null;
  pendingScope: "flush" | "batch";
  floorSkippedCallCount: number;
  floorSkippedRawCharCount: number;
}

export interface MetadataObserverOptions {
  enabled?: boolean;
  directory?: string;
  maxBytes?: number;
  retentionDays?: number;
  now?: () => number;
  loadedBuildIdentity?: string | null;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function settingsFingerprint(config: ContextPruneConfig | null): string | null {
  if (!config) return null;
  const values = CONFIG_KEYS.map((key) => [key, (config as any)[key] ?? null]);
  return sha256(JSON.stringify(values));
}

export function callReference(value: string | undefined): string | null {
  return value ? sha256(value).slice(0, 20) : null;
}

export function rawChars(batch: CapturedBatch): number {
  return batch.toolCalls.reduce((sum, call) => sum + (call.resultText?.length ?? 0), 0);
}

function runtimeBuildIdentity(entryUrl: string): string | null {
  try {
    return sha256(readFileSync(fileURLToPath(entryUrl)));
  } catch {
    return null;
  }
}

function outcomeOf(result: unknown, threw: boolean): string {
  if (threw || result == null) return "failed";
  if (typeof result !== "object") return "unknown";
  const value = result as Record<string, unknown>;
  if (value.__prunerFloorSkipped === true) return "skipped-size-floor";
  if (value[RATE_LIMITED_MARKER] === true) return "rate-limited";
  if (value[CREDIT_EXHAUSTED_MARKER] === true) return "credit-exhausted";
  return "summarized";
}

export class MetadataObserver {
  readonly enabled: boolean;
  private readonly directory: string;
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private sequence = 0;
  private loadedBuildIdentity: string | null;

  constructor(options: MetadataObserverOptions = {}) {
    this.enabled = options.enabled === true;
    this.directory = options.directory ?? join(homedir(), ".pi", "agent", "context-prune", "observability");
    this.maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
    this.retentionMs = (options.retentionDays ?? RETENTION_DAYS) * 86400000;
    this.now = options.now ?? Date.now;
    this.loadedBuildIdentity = options.loadedBuildIdentity ?? null;
  }

  setLoadedBuildIdentity(entryUrl: string): void {
    if (this.enabled) this.loadedBuildIdentity = runtimeBuildIdentity(entryUrl);
  }

  recordSummary(batch: CapturedBatch, config: ContextPruneConfig, result: unknown, latencyMs: number | null, context: ObservationContext | undefined, threw = false): void {
    if (!this.enabled) return;
    const usage = result && typeof result === "object" ? (result as any).usage : null;
    this.append(this.makeRecord(batch, config, outcomeOf(result, threw), latencyMs, usage, context));
  }

  recordBatchOutcome(
    batch: CapturedBatch,
    outcome: BatchCommitOutcome,
    info: BatchCommitInfo,
    context: ObservationContext | undefined,
  ): void {
    if (!this.enabled) return;
    const config = context?.config ?? null;
    const record = this.makeRecord(batch, config, outcome, null, null, context, info.threshold);
    record.event = "batch_outcome";
    record.indexPersisted = info.indexPersisted === true;
    this.append(record);
  }

  recordFlushCommit(info: FlushCommitInfo, context: ObservationContext | undefined): void {
    if (!this.enabled) return;
    this.append({
      schemaVersion: 1,
      eventId: randomUUID(),
      event: "flush_commit",
      sequence: ++this.sequence,
      timestamp: new Date(this.now()).toISOString(),
      loadedBuildIdentity: this.loadedBuildIdentity,
      effectiveConfigHash: settingsFingerprint(context?.config ?? null),
      flushReason: context?.reason ?? "unknown",
      outcome: info.outcome,
      frontierPersisted: info.frontierPersisted === true,
      statsPersisted: info.statsPersisted === true,
      processedBatchCount: safeNumber(info.processedBatchCount),
      attemptedToolCallCount: safeNumber(info.attemptedToolCallCount),
      rawCharCount: safeNumber(info.rawCharCount),
      summaryCharCount: safeNumber(info.summaryCharCount),
    });
  }

  private makeRecord(
    batch: CapturedBatch,
    config: ContextPruneConfig | null,
    outcome: string,
    latencyMs: number | null,
    usage: any,
    context: ObservationContext | undefined,
    floorThreshold?: number,
  ): Record<string, unknown> {
    const members = batch.toolCalls.length;
    return {
      schemaVersion: 1,
      eventId: randomUUID(),
      event: "summary_api",
      sequence: ++this.sequence,
      timestamp: new Date(this.now()).toISOString(),
      loadedBuildIdentity: this.loadedBuildIdentity,
      effectiveConfigHash: settingsFingerprint(config),
      flushReason: context?.reason ?? "unknown",
      configuredThresholds: {
        callCount: safeNumber(config?.midTaskThresholdToolCalls),
        charCount: safeNumber(config?.midTaskThresholdChars),
        sizeFloorChars: safeNumber(floorThreshold ?? config?.minRawCharsForSummary),
      },
      pendingCallCount: context?.pendingCallCount ?? members,
      pendingRawCharCount: context?.pendingRawCharCount ?? rawChars(batch),
      pendingScope: context?.pendingScope ?? "batch",
      firstCallRef: callReference(batch.toolCalls[0]?.toolCallId),
      lastCallRef: callReference(batch.toolCalls[members - 1]?.toolCallId),
      batchMembershipCount: members,
      batchRawCharCount: rawChars(batch),
      indexPersisted: null,
      outcome,
      summaryApiUsage: {
        inputTokens: safeNumber(usage?.input),
        outputTokens: safeNumber(usage?.output),
        reasoningTokens: null,
        cacheReadTokens: safeNumber(usage?.cacheRead),
        cacheWriteTokens: safeNumber(usage?.cacheWrite),
      },
      summaryLatencyMs: safeNumber(latencyMs),
    };
  }

  private append(record: Record<string, unknown>): void {
    try {
      const now = this.now();
      const date = new Date(now).toISOString().slice(0, 10);
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const directoryInfo = lstatSync(this.directory);
      if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || (directoryInfo.mode & 0o077) !== 0) return;
      const names = readdirSync(this.directory).filter((name) => LOG_PATTERN.test(name));
      this.removeExpired(names, now);
      const current = readdirSync(this.directory).filter((name) => LOG_PATTERN.test(name));
      const total = current.reduce((sum, name) => sum + this.fileSize(name), 0);
      const line = `${JSON.stringify(record)}\n`;
      if (total + Buffer.byteLength(line) > this.maxBytes) return;
      const path = join(this.directory, `pruner-${date}.jsonl`);
      try {
        const fileInfo = lstatSync(path);
        if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || (fileInfo.mode & 0o077) !== 0) return;
      } catch { /* new log file */ }
      appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Best-effort metadata must not change Pruner behavior.
    }
  }

  private removeExpired(names: string[], now: number): void {
    for (const name of names) {
      const match = LOG_PATTERN.exec(name);
      if (!match) continue;
      const day = Date.parse(`${match[1]}T00:00:00.000Z`);
      if (Number.isFinite(day) && now - day > this.retentionMs) unlinkSync(join(this.directory, name));
    }
  }

  private fileSize(name: string): number {
    try { return statSync(join(this.directory, name)).size; } catch { return 0; }
  }
}

// Explicit opt-in; no files are opened unless this is exactly "1".
export const defaultMetadataObserver = new MetadataObserver({
  enabled: process.env.PI_CONTEXT_PRUNE_OBSERVABILITY === "1",
});
