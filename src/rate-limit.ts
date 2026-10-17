// AI-INPUT-CONTEXT-OPT-025: 429 / free-tier limit detection and per-batch
// retry cooldown for the summarizer path.
//
// Reuse note: pi-ai exposes isRetryableAssistantError() (utils/retry.ts), but
// its retryable class also covers HTTP 5xx, network/transport failures and
// timeouts. OPT-025 deliberately keeps those OUT of the cooldown class, so we
// implement a narrow 429/free-tier detector here instead, mirroring pi-ai's
// own status field order (utils/error-body.ts extractStatus) and the retry.ts
// rate-limit pattern family (FreeUsageLimitError / GoUsageLimitError / 429 /
// too many requests / rate limit).
import type { CapturedBatch } from "./types.js";

export const RATE_LIMIT_DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
export const RATE_LIMIT_MAX_COOLDOWN_MS = 60 * 60 * 1000;
export const RATE_LIMITED_MARKER = "__prunerRateLimited";
export const CREDIT_EXHAUSTED_MARKER = "__prunerCreditExhausted";

const FREE_TIER_LIMIT_PATTERN =
  /FreeUsageLimitError|GoUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|quota exceeded|out of budget/i;
const HTTP_429_PATTERN = /(?:^|[^0-9])429(?:[^0-9]|$)/;
const RATE_LIMIT_TEXT_PATTERN = /too many requests|rate.?limit/i;
const INSUFFICIENT_CREDITS_PATTERN = /insufficient.?credits/i;
const CREDIT_HTTP_STATUS_PREFIX_PATTERN = /^\s*(\d{3})\s*:/;

function extractHttpStatus(err: any): number | undefined {
  if (typeof err.status === "number") return err.status;
  if (typeof err.statusCode === "number") return err.statusCode;
  if (typeof err.$metadata?.httpStatusCode === "number") return err.$metadata.httpStatusCode;
  if (typeof err.$response?.statusCode === "number") return err.$response.statusCode;
  return undefined;
}

function errorTextParts(err: any): string {
  const parts: string[] = [];
  if (typeof err.message === "string") parts.push(err.message);
  if (typeof err.errorMessage === "string") parts.push(err.errorMessage);
  const prunerResponse = err.prunerResponse;
  if (prunerResponse && typeof prunerResponse.errorMessage === "string") {
    parts.push(prunerResponse.errorMessage);
  }
  return parts.join("\n");
}

export function isRateLimitFailure(err: any): boolean {
  if (!err) return false;
  if (extractHttpStatus(err) === 429) return true;
  const text = errorTextParts(err);
  if (!text) return false;
  return (
    HTTP_429_PATTERN.test(text) || FREE_TIER_LIMIT_PATTERN.test(text) || RATE_LIMIT_TEXT_PATTERN.test(text)
  );
}

function prunerResponseHttpStatus(err: any): number | undefined {
  const pr = err.prunerResponse;
  if (!pr || typeof pr !== "object") return undefined;
  if (typeof pr.status === "number") return pr.status;
  if (typeof pr.statusCode === "number") return pr.statusCode;
  if (typeof pr.httpStatusCode === "number") return pr.httpStatusCode;
  if (typeof pr.$metadata?.httpStatusCode === "number") return pr.$metadata.httpStatusCode;
  if (typeof pr.$response?.statusCode === "number") return pr.$response.statusCode;
  return undefined;
}

function creditMessagePrefixHttpStatus(err: any): number | undefined {
  const fields: string[] = [];
  if (err && typeof err.message === "string") fields.push(err.message);
  if (err && typeof err.errorMessage === "string") fields.push(err.errorMessage);
  const prunerResponse = err && err.prunerResponse;
  if (prunerResponse && typeof prunerResponse.errorMessage === "string") {
    fields.push(prunerResponse.errorMessage);
  }
  for (const text of fields) {
    const m = CREDIT_HTTP_STATUS_PREFIX_PATTERN.exec(text);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
    }
  }
  return undefined;
}

function creditHttpStatus(err: any): number | undefined {
  const s = extractHttpStatus(err);
  if (typeof s === "number") return s;
  const pr = prunerResponseHttpStatus(err);
  if (typeof pr === "number") return pr;
  return creditMessagePrefixHttpStatus(err);
}

/** 400 + insufficient-credits text. Unrelated 400s fall through to generic failure. */
export function isCreditExhaustedFailure(err: any): boolean {
  if (!err) return false;
  if (creditHttpStatus(err) !== 400) return false;
  const text = errorTextParts(err) + (typeof err.code === "string" ? "\n" + err.code : "");
  if (!text) return false;
  return INSUFFICIENT_CREDITS_PATTERN.test(text);
}

export function rateLimitBatchKey(batch: CapturedBatch): string {
  return batch.toolCalls.map((tc) => tc.toolCallId).sort().join("\u001f");
}

export type PrunerMarkerResult =
  | { __prunerRateLimited: true; error: string }
  | { __prunerCreditExhausted: true; error: string };

export interface RateLimitRecord {
  until: number;
  retries: number;
  lastError?: string;
}

/** Returned to the caller so it can report the cooldown it just started. */
export interface RateLimitDecision {
  retries: number;
  cooldownMs: number;
}

/**
 * In-memory per-batch 429/free-tier cooldown state, keyed by sorted toolCallIds.
 * Not persisted across process restarts (RESTART_PERSISTENCE=NO): after a restart
 * a blocked batch is retried at most once before re-entering cooldown, so the
 * retry loop stays bounded.
 */
export class RateLimitRegistry {
  private readonly records = new Map<string, RateLimitRecord>();

  constructor(private readonly cooldownMs: () => number) {}

  has(batch: CapturedBatch): boolean {
    return this.records.has(rateLimitBatchKey(batch));
  }

  record(batch: CapturedBatch, errorText?: string): RateLimitDecision {
    const key = rateLimitBatchKey(batch);
    const prev = this.records.get(key);
    const retries = (prev?.retries ?? 0) + 1;
    const configured = this.cooldownMs();
    const baseMs = Number.isFinite(configured) && configured >= 0 ? configured : RATE_LIMIT_DEFAULT_COOLDOWN_MS;
    const cooldownMs = Math.min(baseMs * 2 ** (retries - 1), RATE_LIMIT_MAX_COOLDOWN_MS);
    this.records.set(key, { until: Date.now() + cooldownMs, retries, lastError: errorText });
    return { retries, cooldownMs };
  }

  isBlocked(batch: CapturedBatch, now: number = Date.now()): boolean {
    const rec = this.records.get(rateLimitBatchKey(batch));
    if (!rec) return false;
    return now < rec.until;
  }

  lastError(batch: CapturedBatch): string | undefined {
    return this.records.get(rateLimitBatchKey(batch))?.lastError;
  }

  clear(batch: CapturedBatch): void {
    this.records.delete(rateLimitBatchKey(batch));
  }
}
