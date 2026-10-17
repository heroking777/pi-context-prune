// Phase33: session-scoped, bounded retry suppression for protection failures.
//
// Goals:
//  - one session's failures never suppress another session's batches
//  - a batch whose compressed summary already failed is not re-sent while its
//    content and policy are unchanged
//  - when a session accumulates too many distinct failures we PAUSE protected
//    compression for that session instead of evicting records (eviction would
//    silently re-send an already-failed batch)
//
// State is in-memory and process-scoped. A restart starts with an empty store
// (a batch may be attempted once more and re-recorded); session files and raw
// tool output are never touched. Recovery: restart the process, change the
// summarizer config (new batch keys), or an explicit programmatic reset.
import {
  PROTECTION_FAILURE_MARKER,
  type ProtectedItem,
  type ProtectionFailureReason,
  type ProtectionFailureResult,
} from "./summary-protection.js";

const MAX_FAILURES_PER_SESSION = 256;
const MAX_TRACKED_SESSIONS = 8;
const UNKNOWN_SESSION = "unknown-session";

interface SessionState {
  failures: Map<string, ProtectionFailureReason>;
  paused: boolean;
}

const sessions = new Map<string, SessionState>();

function touch(sessionKey: string): SessionState {
  const existing = sessions.get(sessionKey);
  if (existing) {
    sessions.delete(sessionKey);
    sessions.set(sessionKey, existing);
    return existing;
  }
  const created: SessionState = { failures: new Map(), paused: false };
  sessions.set(sessionKey, created);
  while (sessions.size > MAX_TRACKED_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  return created;
}

/**
 * Resolves a stable session key from the extension context. When no session id
 * is available the shared "unknown-session" bucket is used, which is the safe
 * choice (suppression still prevents re-sends) at the cost of sharing state
 * between sessions that both lack an id.
 */
export function resolveProtectionSessionKey(ctx: unknown): string {
  const manager = (ctx as { sessionManager?: { getSessionId?: () => unknown; sessionId?: unknown } } | undefined)?.sessionManager;
  const id = typeof manager?.getSessionId === "function" ? manager.getSessionId() : manager?.sessionId;
  return typeof id === "string" && id.length > 0 ? id : UNKNOWN_SESSION;
}

/** Returns the reason this batch is suppressed, or undefined when it is not. */
export function getSuppressedProtectionFailure(sessionKey: string, batchKey: string): ProtectionFailureReason | undefined {
  const state = sessions.get(sessionKey);
  if (!state) return undefined;
  touch(sessionKey);
  if (state.paused) return "paused";
  return state.failures.get(batchKey);
}

export function isProtectionPaused(sessionKey: string): boolean {
  return sessions.get(sessionKey)?.paused === true;
}

/**
 * Records a failure. When the session already holds MAX_FAILURES_PER_SESSION
 * distinct failures, the session is paused and the reason `paused` is returned
 * (nothing is evicted, so no suppressed batch can be re-sent).
 */
export function rememberProtectionFailure(
  sessionKey: string,
  batchKey: string,
  reason: Exclude<ProtectionFailureReason, "paused">,
): ProtectionFailureReason {
  const state = touch(sessionKey);
  if (state.paused) return "paused";
  if (!state.failures.has(batchKey) && state.failures.size >= MAX_FAILURES_PER_SESSION) {
    state.paused = true;
    return "paused";
  }
  state.failures.set(batchKey, reason);
  return reason;
}

/** Number of suppressed batches, optionally for one session. */
export function protectionFailureCount(sessionKey?: string): number {
  if (sessionKey !== undefined) return sessions.get(sessionKey)?.failures.size ?? 0;
  let total = 0;
  for (const state of sessions.values()) total += state.failures.size;
  return total;
}

/** Clears suppression for every session. */
export function clearProtectionFailures(): void {
  sessions.clear();
}

export function protectionFailureResult(
  key: string,
  reason: ProtectionFailureReason,
  missing: ProtectedItem[] = [],
): ProtectionFailureResult {
  return {
    [PROTECTION_FAILURE_MARKER]: true,
    reason,
    key,
    missingCategories: [...new Set(missing.map((item) => item.category))] as ProtectionFailureResult["missingCategories"],
    missingCount: missing.length,
  };
}
