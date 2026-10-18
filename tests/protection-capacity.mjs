// Phase 33/34/35 — session isolation, capacity admission and single-flight.
import { DEFAULT_CONFIG, summarizeBatch, PROTECTION_FAILURE_MARKER,
  protectionFailureCount, clearProtectionFailures, isProtectionPaused,
  isProtectionAtCapacity, protectionSessionCount, protectionSlotCount, protectionAdmissionCount, ok } from "./test-support.mjs";
import { SHA, PATH, PROTECTED_BATCH, fakeCtx, deferredCtx, batch, variation, cfgOn } from "./protection-helpers.mjs";
// ── 8. Phase33/34: session isolation ───────────────────────────────────────
clearProtectionFailures();
const sessionA = fakeCtx("lossy", "session-A");
const sessionB = fakeCtx("lossy", "session-B");
await summarizeBatch(PROTECTED_BATCH, cfgOn, sessionA.ctx);
ok("session A failure is recorded only for session A",
  protectionFailureCount("session-A") === 1 && protectionFailureCount("session-B") === 0);
const aSecond = await summarizeBatch(PROTECTED_BATCH, cfgOn, sessionA.ctx);
ok("same session, same content: no second provider call",
  sessionA.calls.n === 1 && aSecond[PROTECTION_FAILURE_MARKER] === true);
const bFirst = await summarizeBatch(PROTECTED_BATCH, cfgOn, sessionB.ctx);
ok("a different session is not suppressed by A's failure",
  sessionB.calls.n === 1 && bFirst !== null && bFirst[PROTECTION_FAILURE_MARKER] === true);
ok("session counts stay independent", protectionFailureCount("session-A") === 1 && protectionFailureCount("session-B") === 1);

// ── 8b. Phase34: unavailable session id fails closed without sharing ────────
for (const [label, manager] of [
  ["missing manager", undefined],
  ["missing accessor", {}],
  ["empty id", { getSessionId: () => "" }],
  ["whitespace id", { getSessionId: () => "   " }],
  ["non-string id", { getSessionId: () => 42 }],
  ["throwing accessor", { getSessionId: () => { throw new Error("no id"); } }],
]) {
  clearProtectionFailures();
  const c = fakeCtx("lossy");
  c.ctx.sessionManager = manager;
  const r = await summarizeBatch(PROTECTED_BATCH, cfgOn, c.ctx);
  ok(`unidentified session (${label}) fails closed with zero provider calls`,
    c.calls.n === 0 && r !== null && r[PROTECTION_FAILURE_MARKER] === true && r.reason === "unidentified" && protectionFailureCount() === 0);
}
clearProtectionFailures();
const idA = fakeCtx("lossy"); idA.ctx.sessionManager = { getSessionId: () => { throw new Error("x"); } };
const idB = fakeCtx("lossy"); idB.ctx.sessionManager = { getSessionId: () => { throw new Error("x"); } };
await summarizeBatch(PROTECTED_BATCH, cfgOn, idA.ctx);
await summarizeBatch(PROTECTED_BATCH, cfgOn, idB.ctx);
ok("unidentified sessions never share suppression state",
  idA.calls.n === 0 && idB.calls.n === 0 && protectionFailureCount() === 0);

// ── 9. Phase33: session pause instead of eviction ────────────────────────────
clearProtectionFailures();
const pauseSession = fakeCtx("lossy", "pause-session");
await summarizeBatch(PROTECTED_BATCH, cfgOn, pauseSession.ctx);
const firstBatchCalls = pauseSession.calls.n;
for (let i = 0; i < 300; i++) await summarizeBatch(variation(i + 5000), cfgOn, pauseSession.ctx);
ok("the session pauses instead of evicting records",
  protectionFailureCount("pause-session") === 256 && isProtectionPaused("pause-session") === true);
const callsAfterPause = pauseSession.calls.n;
const pausedResult = await summarizeBatch(variation(9999), cfgOn, pauseSession.ctx);
ok("a paused session makes no further provider calls",
  pauseSession.calls.n === callsAfterPause && pausedResult[PROTECTION_FAILURE_MARKER] === true && pausedResult.reason === "paused");
await summarizeBatch(PROTECTED_BATCH, cfgOn, pauseSession.ctx);
ok("the oldest failure is never evicted and re-sent",
  pauseSession.calls.n === callsAfterPause && protectionFailureCount("pause-session") === 256 && firstBatchCalls === 1);
ok("pausing one session does not pause another",
  isProtectionPaused("session-A") === false && isProtectionPaused("pause-session") === true);
clearProtectionFailures();
ok("clearing resets pause for every session",
  protectionFailureCount() === 0 && isProtectionPaused("pause-session") === false);

// ── 10. Phase34 mandatory regression: 9th session must not re-send session 1 ─
clearProtectionFailures();
const tracked = [];
for (let i = 0; i < 8; i++) {
  const c = fakeCtx("lossy", `cap-${i}`);
  tracked.push(c);
  await summarizeBatch(PROTECTED_BATCH, cfgOn, c.ctx);
}
ok("eight sessions are tracked without eviction",
  protectionSessionCount() === 8 && isProtectionAtCapacity() === true && protectionFailureCount() === 8);
const callsBeforeReturn = tracked[0].calls.n;
const returnResult = await summarizeBatch(PROTECTED_BATCH, cfgOn, tracked[0].ctx);
ok("returning to the first session does not re-send its failed batch",
  tracked[0].calls.n === callsBeforeReturn && returnResult[PROTECTION_FAILURE_MARKER] === true && returnResult.reason === "missing");
const ninth = fakeCtx("lossy", "cap-9");
const tenth = fakeCtx("lossy", "cap-10");
const ninthResult = await summarizeBatch(PROTECTED_BATCH, cfgOn, ninth.ctx);
const tenthResult = await summarizeBatch(PROTECTED_BATCH, cfgOn, tenth.ctx);
ok("the ninth session fails closed with zero provider calls",
  ninth.calls.n === 0 && ninthResult[PROTECTION_FAILURE_MARKER] === true && ninthResult.reason === "capacity");
ok("the tenth session fails closed with zero provider calls",
  tenth.calls.n === 0 && tenthResult.reason === "capacity" && protectionSessionCount() === 8);
ok("capacity sessions never grow the table", protectionFailureCount() === 8);
const callsAfterCapacity = tracked.reduce((sum, c) => sum + c.calls.n, 0);
await summarizeBatch(variation(12345), cfgOn, tracked[3].ctx);
await summarizeBatch(PROTECTED_BATCH, cfgOn, tracked[7].ctx);
ok("tracked sessions keep working after capacity is reached",
  tracked[3].calls.n + tracked[7].calls.n > 0 && tracked.reduce((sum, c) => sum + c.calls.n, 0) >= callsAfterCapacity);
clearProtectionFailures();
ok("clearing releases capacity", isProtectionAtCapacity() === false && protectionSessionCount() === 0);

// ── 11. Phase35: concurrent admission and single-flight ────────────────────
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
clearProtectionFailures();
const concurrent = Array.from({ length: 10 }, (_, i) => fakeCtx("lossy", `conc-${i}`));
const concurrentResults = await Promise.all(concurrent.map((c) => summarizeBatch(PROTECTED_BATCH, cfgOn, c.ctx)));
const concurrentCalls = concurrent.reduce((sum, c) => sum + c.calls.n, 0);
ok("10 concurrent first attempts admit at most 8 sessions",
  protectionSessionCount() === 8 && concurrentCalls === 8 && protectionSlotCount() === 8);
ok("the 9th and 10th concurrent sessions fail closed with zero provider calls",
  concurrent[8].calls.n === 0 && concurrent[9].calls.n === 0 &&
  concurrentResults[8][PROTECTION_FAILURE_MARKER] === true && concurrentResults[8].reason === "capacity" &&
  concurrentResults[9].reason === "capacity");
clearProtectionFailures();
ok("clearing also releases admissions", protectionSlotCount() === 0 && protectionSessionCount() === 0);

// Same session + same batch concurrently: one provider call, one in-flight result.
const sf = fakeCtx("slow-ok", "sf-session");
const sfPromise1 = summarizeBatch(PROTECTED_BATCH, cfgOn, sf.ctx);
const sfPromise2 = summarizeBatch(PROTECTED_BATCH, cfgOn, sf.ctx);
const [sf1, sf2] = await Promise.all([sfPromise1, sfPromise2]);
const sfInFlight = [sf1, sf2].filter((r) => r && r[PROTECTION_FAILURE_MARKER] === true && r.reason === "in-flight").length;
ok("a concurrent identical batch makes no duplicate provider call", sf.calls.n === 1 && sfInFlight === 1);
ok("the successful attempt returned a summary", [sf1, sf2].some((r) => r && typeof r.summaryText === "string"));
ok("a successful attempt releases its slot and lock",
  protectionSlotCount() === 0 && protectionSessionCount() === 0);
await summarizeBatch(PROTECTED_BATCH, cfgOn, sf.ctx);
ok("the single-flight lock is released after completion", sf.calls.n === 2);

// Different batches in one session stay parallel.
const par = fakeCtx("slow-ok", "par-session");
const [par1, par2] = await Promise.all([summarizeBatch(variation(1), cfgOn, par.ctx), summarizeBatch(variation(2), cfgOn, par.ctx)]);
ok("different batches in the same session still run in parallel",
  par.calls.n === 2 && !par1[PROTECTION_FAILURE_MARKER] && !par2[PROTECTION_FAILURE_MARKER] && protectionSlotCount() === 0);

// 429 / provider error / abort must not leak slots or locks.
clearProtectionFailures();
const rlSlot = fakeCtx("429", "rl-slot");
await summarizeBatch(PROTECTED_BATCH, cfgOn, rlSlot.ctx);
ok("429 releases the reservation without tracking the session",
  protectionSlotCount() === 0 && protectionSessionCount() === 0 && rlSlot.calls.n === 1);
await summarizeBatch(PROTECTED_BATCH, cfgOn, rlSlot.ctx);
ok("the 429 session can be attempted again (no leaked lock)", rlSlot.calls.n === 2);
const errSlot = fakeCtx("error", "err-slot");
await summarizeBatch(PROTECTED_BATCH, cfgOn, errSlot.ctx);
ok("provider errors release the reservation", protectionSlotCount() === 0 && errSlot.calls.n === 1);
let aborted = false;
try { await summarizeBatch(PROTECTED_BATCH, cfgOn, errSlot.ctx, { signal: { aborted: true } }); } catch { aborted = true; }
ok("abort releases nothing and leaves no slot", aborted && protectionSlotCount() === 0 && errSlot.calls.n === 1);

// Failure state is retained (converted admission) and never evicted by success.
clearProtectionFailures();
const retain = fakeCtx("lossy", "retain-session");
await summarizeBatch(PROTECTED_BATCH, cfgOn, retain.ctx);
ok("a protection failure keeps the session slot as persistent state",
  protectionSessionCount() === 1 && protectionSlotCount() === 1 && protectionFailureCount("retain-session") === 1);
const retainedCalls = retain.calls.n;
await summarizeBatch(PROTECTED_BATCH, cfgOn, retain.ctx);
ok("retained failure state is never released or re-sent", retain.calls.n === retainedCalls && protectionSlotCount() === 1);
clearProtectionFailures();

// ── 12. Phase41: admission reference counting interleaving ─────────────────
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
clearProtectionFailures();
const refA = deferredCtx("ref-A");
const refBatch1 = summarizeBatch(variation(1), cfgOn, refA.ctx);
await tick();
const refBatch2 = summarizeBatch(variation(2), cfgOn, refA.ctx);
await tick();
ok("two in-flight batches of one session share a single slot",
  protectionSlotCount() === 1 && protectionAdmissionCount("ref-A") === 2 && refA.calls.n === 2);
refA.releaseNext();
await tick();
ok("finishing one batch does not release the session slot early",
  protectionAdmissionCount("ref-A") === 1 && protectionSlotCount() === 1);
const refOthers = [];
for (let i = 0; i < 7; i++) {
  const c = deferredCtx(`ref-${i}`);
  refOthers.push(c);
  void summarizeBatch(variation(10 + i), cfgOn, c.ctx);
}
await tick();
ok("eight distinct sessions are active while one still holds an in-flight batch",
  protectionSlotCount() === 8 && protectionSessionCount() === 0);
const refNinth = deferredCtx("ref-ninth");
const ninthRefResult = await summarizeBatch(variation(99), cfgOn, refNinth.ctx);
ok("the ninth distinct session fails closed while eight remain active",
  ninthRefResult.reason === "capacity" && refNinth.calls.n === 0 && protectionSlotCount() === 8);
refA.releaseNext();
await Promise.all([refBatch1, refBatch2]);
for (const c of refOthers) c.releaseNext();
await tick();
ok("all slots are released after every attempt completes",
  protectionSlotCount() === 0 && protectionSessionCount() === 0);

// Same-batch single-flight with a deferred provider.
clearProtectionFailures();
const sfDeferred = deferredCtx("ref-sf");
const sfFirst = summarizeBatch(variation(5), cfgOn, sfDeferred.ctx);
await tick();
const sfSecond = await summarizeBatch(variation(5), cfgOn, sfDeferred.ctx);
ok("the duplicate same-batch attempt is rejected without a second call",
  sfSecond.reason === "in-flight" && sfDeferred.calls.n === 1 && protectionAdmissionCount("ref-sf") === 1);
sfDeferred.releaseNext();
await sfFirst;
await tick();
ok("the single-flight release leaves no admission behind", protectionAdmissionCount("ref-sf") === 0 && protectionSlotCount() === 0);

// Out-of-order completion plus 429 on one of the batches.
clearProtectionFailures();
const mixedA = deferredCtx("ref-mixed");
const mixedB = deferredCtx("ref-mixed-b");
const mixedFirst = summarizeBatch(variation(21), cfgOn, mixedA.ctx);
const mixedSecond = summarizeBatch(variation(22), cfgOn, mixedB.ctx);
await tick();
mixedB.releaseNext();
await mixedSecond;
await tick();
ok("out-of-order completion releases only the finished session's slot",
  protectionAdmissionCount("ref-mixed-b") === 0 && protectionAdmissionCount("ref-mixed") === 1 && protectionSlotCount() === 1);
mixedA.releaseNext();
await mixedFirst;
await tick();
ok("out-of-order completion leaves no leaked slots", protectionSlotCount() === 0);

// Failure conversion while another batch of the same session is in flight.
clearProtectionFailures();
const failDeferred = deferredCtx("ref-fail", true);
const failFirst = summarizeBatch(variation(31), cfgOn, failDeferred.ctx);
await tick();
const failSecond = summarizeBatch(variation(32), cfgOn, failDeferred.ctx);
await tick();
failDeferred.releaseNext();
const failFirstResult = await failFirst;
await tick();
ok("a failure promotes the session while another batch is still in flight",
  protectionSessionCount() === 1 && protectionFailureCount("ref-fail") === 1 &&
  failFirstResult[PROTECTION_FAILURE_MARKER] === true && protectionAdmissionCount("ref-fail") === 0);
failDeferred.releaseNext();
const failSecondResult = await failSecond;
await tick();
ok("the remaining in-flight batch resolves without leaking a slot",
  failSecondResult[PROTECTION_FAILURE_MARKER] === true && protectionSlotCount() === 1 && protectionSessionCount() === 1);
clearProtectionFailures();
ok("clearing removes tracked and admitted state", protectionSlotCount() === 0 && protectionSessionCount() === 0);
