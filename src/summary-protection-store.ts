// Phase35: session-scoped admission + retry suppression for protected summaries.
//
// Safety rules:
//  - at most MAX_TRACKED_SESSIONS sessions hold a slot; a protected attempt for a
//    new session reserves a slot BEFORE any provider call, so concurrent first
//    attempts cannot exceed the limit
//  - slots for successful attempts are released; slots for protection failures are
//    converted into persistent failure state (never evicted)
//  - the same session+batch is single-flight: a concurrent duplicate never calls
//    the provider
//  - an unavailable/empty/throwing session id fails closed as `unidentified`
//
// State is in-memory, process-scoped and bounded: <= 8 sessions x 256 batch keys.
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

/** Sessions with persistent failure state. */
const sessions = new Map<string, SessionState>();
/** Temporary slots for first attempts that have not yet resolved. */
const admissions = new Map<string, number>();
/** `sessionKey\u0000batchKey` currently being summarized. */
const inFlight = new Set<string>();

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

function totalSlots(): number {
  return sessions.size + admissions.size;
}

export function isProtectionTracked(sessionKey: string): boolean {
  return sessions.has(sessionKey);
}

export interface ProtectionAttempt {
  sessionKey: string;
  batchKey: string;
}

export type ProtectionAdmission =
  | { status: "proceed"; attempt: ProtectionAttempt }
  | { status: "blocked"; reason: ProtectionFailureReason };

/**
 * Combined admission gate: suppression check, session slot reservation and
 * same-batch single-flight, all before any provider call. Every `proceed` MUST
 * be paired with `finishProtectedAttempt` (the summarizer does this in a
 * `finally`), so exceptions, 429s and aborts cannot leak a slot or a lock.
 */
export function beginProtectedAttempt(sessionKey: string, batchKey: string): ProtectionAdmission {
  const suppressed = getSuppressedProtectionFailure(sessionKey, batchKey);
  if (suppressed) return { status: "blocked", reason: suppressed };
  const tracked = isProtectionTracked(sessionKey);
  if (!tracked && tryAdmitProtectionSession(sessionKey) === "capacity") {
    return { status: "blocked", reason: "capacity" };
  }
  if (!beginProtectionSingleFlight(sessionKey, batchKey)) {
    if (!tracked) releaseProtectionAdmission(sessionKey);
    return { status: "blocked", reason: "in-flight" };
  }
  return { status: "proceed", attempt: { sessionKey, batchKey } };
}

/** Releases the temporary slot and the single-flight lock for an attempt. */
export function finishProtectedAttempt(attempt: ProtectionAttempt): void {
  endProtectionSingleFlight(attempt.sessionKey, attempt.batchKey);
  releaseProtectionAdmission(attempt.sessionKey);
}

/**
 * Reserves a slot for a first attempt. Each concurrent attempt for the same
 * session increments a reference count, so a slot is released only when the
 * last in-flight batch of that session finishes. Returns `already` when the
 * session is tracked or already reserved, `capacity` when the slot budget is
 * exhausted.
 */
export function tryAdmitProtectionSession(sessionKey: string): "admitted" | "already" | "capacity" {
  if (sessions.has(sessionKey)) return "already";
  const current = admissions.get(sessionKey);
  if (current !== undefined) {
    admissions.set(sessionKey, current + 1);
    return "already";
  }
  if (totalSlots() >= MAX_TRACKED_SESSIONS) return "capacity";
  admissions.set(sessionKey, 1);
  return "admitted";
}

/** Releases one reference; the slot disappears only when the count reaches 0. */
export function releaseProtectionAdmission(sessionKey: string): void {
  const count = admissions.get(sessionKey);
  if (count === undefined) return;
  if (count <= 1) admissions.delete(sessionKey);
  else admissions.set(sessionKey, count - 1);
}

/** In-flight reference count for a session (0 when not admitted). */
export function protectionAdmissionCount(sessionKey: string): number {
  return admissions.get(sessionKey) ?? 0;
}

/** Same session+batch single-flight. `false` means another attempt is running. */
export function beginProtectionSingleFlight(sessionKey: string, batchKey: string): boolean {
  const key = `${sessionKey}\u0000${batchKey}`;
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}

export function endProtectionSingleFlight(sessionKey: string, batchKey: string): void {
  inFlight.delete(`${sessionKey}\u0000${batchKey}`);
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
  // An already-admitted session is not a new entrant: its other in-flight
  // batches must not be blocked by the capacity check.
  if (admissions.has(sessionKey)) return undefined;
  return totalSlots() >= MAX_TRACKED_SESSIONS ? "capacity" : undefined;
}

export function isProtectionPaused(sessionKey: string): boolean {
  return sessions.get(sessionKey)?.paused === true;
}

export function isProtectionAtCapacity(): boolean {
  return totalSlots() >= MAX_TRACKED_SESSIONS;
}

export function protectionSessionCount(): number {
  return sessions.size;
}

export function protectionSlotCount(): number {
  return totalSlots();
}

/**
 * Records a failure, converting a temporary admission into persistent state.
 * Existing sessions are never evicted. A full table returns `capacity`; a
 * session at MAX_FAILURES_PER_SESSION is paused.
 */
export function rememberProtectionFailure(
  sessionKey: string,
  batchKey: string,
  reason: Exclude<ProtectionFailureReason, "paused" | "capacity" | "unidentified" | "in-flight">,
): ProtectionFailureReason {
  let state = sessions.get(sessionKey);
  if (!state) {
    if (!admissions.has(sessionKey) && totalSlots() >= MAX_TRACKED_SESSIONS) return "capacity";
    admissions.delete(sessionKey);
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

/** Clears suppression and admissions for every session (the only reset path). */
export function clearProtectionFailures(): void {
  sessions.clear();
  admissions.clear();
  inFlight.clear();
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
