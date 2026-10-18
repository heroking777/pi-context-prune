// Phase36: hashing helpers for protection retry keys and log signatures.
// Split out of ./summary-protection.ts to keep that module within 300 lines.
import { createHash } from "node:crypto";
import type { ProtectedItem } from "./summary-protection.js";

/**
 * Stable retry key for a batch under a given protection policy. Includes the
 * batch content and every setting that changes the compressed output, so an
 * input or config change re-evaluates the batch instead of staying suppressed.
 */
export function protectionFailureKey(rawText: string, config: {
  protectedSummaryTargetChars?: number;
  summarizerModel?: string;
  summarizerThinking?: string;
  summarizerPromptMode?: string;
  conciseSummaryMode?: boolean;
} | null): string {
  const policy = JSON.stringify([
    config?.protectedSummaryTargetChars ?? null,
    config?.summarizerModel ?? null,
    config?.summarizerThinking ?? null,
    config?.summarizerPromptMode ?? null,
    config?.conciseSummaryMode ?? null,
  ]);
  return createHash("sha256").update(rawText).update("\u0000").update(policy).digest("hex").slice(0, 24);
}

/** Stable short signature for logging without exposing raw values. */
export function protectionSignature(items: ProtectedItem[]): string {
  return createHash("sha256").update(items.map((i) => `${i.category}:${i.value}`).join("|")).digest("hex").slice(0, 12);
}
