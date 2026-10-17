// Phase34: session-scoped, bounded retry suppression for protection failures.
//
// Safety rules:
//  - failure state is never evicted; when the session table is full, a NEW
//    session fails closed (protected compression is refused without a provider
//    call) instead of dropping an existing session's state
//  - an unavailable/empty/throwing session id is NOT shared between sessions: it
//    fails closed as `unidentified`
//  - an unchanged batch in a tracked session is never re-sent
//
// State is in-memory and process-scoped: a restart starts empty and a batch may
// be attempted once more, re-recorded, with raw tool output never touched.
import {
  PROTECTION_FAILURE_MARKER,
  type ProtectedItem,
  type ProtectionFailureReason,
  type ProtectionFailureResult,
} from "./summary-protection.js";

const MAX_FAILURES_PER_SESSION = 256;
const MAX_TRACKED_SESSIONS = 8;

interface SessionState {
  failures: Map<string, ProtectionFailureReason>;
  paused: boolean;
}

const sessions = new Map<string, SessionState>();

/** Exact resolution of the session key; `unidentified` fails closed. */
export type ProtectionSessionResolution = { status: "ok"; key: string } | { status: "unidentified" };

/**
 * Resolves a session key from the extension context. A missing id, an empty or
 * whitespace id, a non-string id, or a throwing accessor all yield
 * `unidentified`, so unrelated sessions never share suppression state.
 */
export function resolveProtectionSessionKey(ctx: unknown): ProtectionSessionResolution {
  try {
    const manager = (ctx as {
      sessionManager?: { getSessionId?: () => unknown; sessionId?: unknown };
    } | undefined)?.sessionManager;
    const raw = typeof manager?.getSessionId === "function" ? manager.getSessionId() : manager?.sessionId;
    if (typeof raw === "string" && raw.trim().length > 0) return { status: "ok", key: raw };
  } catch {
    // Fail closed below.
  }
  return { status: "unidentified" };
}

/**
 * Returns the reason this batch is suppressed, or undefined when it may be sent.
 * An untracked session over capacity fails closed so no provider call is made.
 */
export function getSuppressedProtectionFailure(sessionKey: string, batchKey: string): ProtectionFailureReason | undefined {
  const state = sessions.get(sessionKey);
  if (state) {
    if (state.paused) return "paused";
    return state.failures.get(batchKey);
  }
  return sessions.size >= MAX_TRACKED_SESSIONS ? "capacity" : undefined;
}

export function isProtectionPaused(sessionKey: string): boolean {
  return sessions.get(sessionKey)?.paused === true;
}

/** True when the tracked-session table is full and new sessions fail closed. */
export function isProtectionAtCapacity(): boolean {
  return sessions.size >= MAX_TRACKED_SESSIONS;
}

export function protectionSessionCount(): number {
  return sessions.size;
}

/**
 * Records a failure without evicting any existing session. When the session
 * table is full a new session returns `capacity`; when a session reaches
 * MAX_FAILURES_PER_SESSION it is paused (further protected summaries are refused
 * without provider calls).
 */
export function rememberProtectionFailure(
  sessionKey: string,
  batchKey: string,
  reason: Exclude<ProtectionFailureReason, "paused" | "capacity" | "unidentified">,
): ProtectionFailureReason {
  let state = sessions.get(sessionKey);
  if (!state) {
    if (sessions.size >= MAX_TRACKED_SESSIONS) return "capacity";
    state = { failures: new Map(), paused: false };
    sessions.set(sessionKey, state);
  }
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

/** Clears suppression for every session (the only reset path; no production command). */
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
