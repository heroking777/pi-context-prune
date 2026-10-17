// Phase 32 — protection-failure retry suppression and overflow handling.
import {
  DEFAULT_CONFIG, summarizeBatch, extractProtectedItems, extractProtectedItemsDetailed,
  verifyProtectedSummary, protectionFailureKey, PROTECTION_FAILURE_MARKER,
  protectionFailureCount, clearProtectionFailures, isProtectionPaused, protectionRejectionReason,
  isProtectionAtCapacity, protectionSessionCount,
  RATE_LIMITED_MARKER, ok,
} from "./test-support.mjs";

const SHA = (n) => `${String(n).padStart(3, "0")}${"a".repeat(37)}`;
const PATH = "/home/deploy/hr-p0/jra/src/heroking_jra/pit/integrity.py";
const PROTECTED_BATCH = {
  turnIndex: 1, timestamp: 1,
  toolCalls: [
    { toolName: "bash", toolCallId: "b1", args: { command: "sha" }, resultText: `FINAL_SHA=${SHA(1)} ${PATH}`, isError: false },
    { toolName: "bash", toolCallId: "b2", args: { command: "test" }, resultText: "IntegrityError: bad; exit code 3; status FAIL", isError: true },
    { toolName: "bash", toolCallId: "b3", args: { command: "decide" }, resultText: "DECISION=KEEP_RAW UNFINISHED_TASK: resume tracing ROLLBACK=restore snapshot", isError: false },
  ],
};

function fakeCtx(behaviour, session = "s1") {
  const calls = { n: 0 };
  const provider = {
    stream(_model, ctxArg) {
      calls.n += 1;
      const userText = ctxArg.messages[0].content.map((p) => p.text).join("\n");
      const body = userText.split("<tool-call-batch>")[1]?.split("</tool-call-batch>")[0] ?? "";
      if (behaviour === "429") { const e = new Error("429 Too Many Requests"); e.status = 429; throw e; }
      if (behaviour === "error") throw new Error("provider exploded");
      const text = behaviour === "lossy"
        ? "Compressed summary without any identifiers."
        : extractProtectedItems(body).map((item) => item.value).join("\n");
      const result = { stopReason: "stop", content: [{ type: "text", text }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, timestamp: Date.now() };
      return Object.assign((async function* () { yield { type: "text_end", partial: result }; })(), { result: async () => result });
    },
  };
  return { calls, ctx: {
    model: { provider: "fake", id: "m" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {}, env: {} }), getProvider: () => provider, find: () => undefined },
    ui: { notify: () => {} },
    sessionManager: { getSessionId: () => session },
  } };
}

const cfgOn = { ...DEFAULT_CONFIG, protectedSummaryCompression: true };
const cfgOff = { ...DEFAULT_CONFIG, protectedSummaryCompression: false };
const batch = (toolCalls) => ({ turnIndex: 1, timestamp: 1, toolCalls });
const variation = (n) => batch([{ toolName: "bash", toolCallId: `v${n}`, args: { command: `step ${n}` }, resultText: `FINAL_SHA=${SHA(n)} ${PATH} status PASS`.replace("PASS", "PASS"), isError: false }]);

// ── 1. Retry suppression ────────────────────────────────────────────────────
clearProtectionFailures();
ok("OFF does not use the protection cache", protectionFailureCount() === 0);
const lossy = fakeCtx("lossy");
const first = await summarizeBatch(PROTECTED_BATCH, cfgOn, lossy.ctx);
ok("first protection failure is recorded and returned as a marker",
  first !== null && first[PROTECTION_FAILURE_MARKER] === true && first.reason === "missing" && lossy.calls.n === 1 && protectionFailureCount() === 1);
const second = await summarizeBatch(PROTECTED_BATCH, cfgOn, lossy.ctx);
ok("an unchanged automatic retry makes zero provider calls",
  lossy.calls.n === 1 && second !== null && second[PROTECTION_FAILURE_MARKER] === true);
const third = await summarizeBatch(PROTECTED_BATCH, { ...cfgOn }, lossy.ctx);
ok("identical config keeps it suppressed", lossy.calls.n === 1 && third[PROTECTION_FAILURE_MARKER] === true);
await summarizeBatch(variation(42), cfgOn, lossy.ctx);
ok("changed batch content is re-evaluated", lossy.calls.n === 2);
const before = lossy.calls.n;
await summarizeBatch(variation(42), { ...cfgOn, protectedSummaryTargetChars: 7000 }, lossy.ctx);
ok("changed protection target is re-evaluated", lossy.calls.n === before + 1);
const beforeModel = lossy.calls.n;
await summarizeBatch(variation(42), { ...cfgOn, summarizerModel: "other/model" }, lossy.ctx);
ok("changed summarizer model is re-evaluated", lossy.calls.n === beforeModel + 1);
clearProtectionFailures();
ok("manual reset clears suppression", protectionFailureCount() === 0);
await summarizeBatch(variation(42), cfgOn, lossy.ctx);
ok("after reset the batch is attempted again", lossy.calls.n === beforeModel + 2);

// ── 2. Cache bound ──────────────────────────────────────────────────────────
clearProtectionFailures();
const boundCtx = fakeCtx("lossy");
for (let i = 0; i < 300; i++) await summarizeBatch(variation(i + 1000), cfgOn, boundCtx.ctx);
ok("the suppression cache is bounded", protectionFailureCount() <= 256 && protectionFailureCount() > 0, String(protectionFailureCount()));

// ── 3. Unrelated failures are never suppressed ──────────────────────────────
clearProtectionFailures();
const rl = fakeCtx("429");
const rlResult = await summarizeBatch(PROTECTED_BATCH, cfgOn, rl.ctx);
ok("429 stays a rate-limit marker and is not added to the protection cache",
  rlResult !== null && rlResult[RATE_LIMITED_MARKER] === true && rlResult[PROTECTION_FAILURE_MARKER] === undefined && protectionFailureCount() === 0);
await summarizeBatch(PROTECTED_BATCH, cfgOn, rl.ctx);
ok("429 is still retried by the existing cooldown path", rl.calls.n === 2);
const err = fakeCtx("error");
const errResult = await summarizeBatch(PROTECTED_BATCH, cfgOn, err.ctx);
ok("provider error stays a null failure and is not cached", errResult === null && protectionFailureCount() === 0);
let aborted = false;
try { await summarizeBatch(PROTECTED_BATCH, cfgOn, err.ctx, { signal: { aborted: true } }); } catch { aborted = true; }
ok("abort still throws before any cache write", aborted && protectionFailureCount() === 0 && err.calls.n === 1);

// ── 4. Overflow handling ────────────────────────────────────────────────────
const shaLine = (n) => `FINAL_SHA=${SHA(n)}`;
const rawWithN = (n) => Array.from({ length: n }, (_, i) => shaLine(i + 1)).join("\n");
const summaryWithAll = (n) => Array.from({ length: n }, (_, i) => SHA(i + 1)).join(" ");
for (const n of [24, 25]) {
  const detailed = extractProtectedItemsDetailed(rawWithN(n));
  ok(`${n} protected items do not overflow`, detailed.overflowCategories.length === 0 &&
    extractProtectedItems(rawWithN(n)).length === n &&
    verifyProtectedSummary(rawWithN(n), summaryWithAll(n)).ok === true);
}
const over = extractProtectedItemsDetailed(rawWithN(26));
ok("26 protected items report overflow instead of silently passing",
  over.overflowCategories.includes("sha") && extractProtectedItems(rawWithN(26)).length === 25 &&
  verifyProtectedSummary(rawWithN(26), summaryWithAll(26)).ok === false &&
  verifyProtectedSummary(rawWithN(26), summaryWithAll(26)).overflow.includes("sha"));
const paths26 = Array.from({ length: 26 }, (_, i) => `/opt/heroking/releases/r${i}/bin/app_${i}.py`).join("\n");
ok("many distinct paths overflow", verifyProtectedSummary(paths26, paths26).ok === false && verifyProtectedSummary(paths26, paths26).overflow.includes("path"));
const dup = Array.from({ length: 40 }, () => shaLine(1)).join("\n");
ok("duplicate protected values never overflow", extractProtectedItemsDetailed(dup).overflowCategories.length === 0 && verifyProtectedSummary(dup, SHA(1)).ok === true);
const rollbackLast = `${paths26}\nROLLBACK=restore /opt/heroking/releases/jra-da015ff from snapshot`;
const rollbackVerdict = verifyProtectedSummary(rollbackLast, `${paths26}\nrestore /opt/heroking/releases/jra-da015ff from snapshot`);
ok("a late ROLLBACK after overflow still cannot pass", rollbackVerdict.ok === false && rollbackVerdict.overflow.includes("path") && rollbackVerdict.missing.length === 0);

// ── 5. Overflow produces a distinguishable failure at the summarize layer ───
clearProtectionFailures();
const overflowBatch = batch(Array.from({ length: 26 }, (_, i) => ({
  toolName: "bash", toolCallId: `o${i}`, args: { command: `step ${i}` }, resultText: `FINAL_SHA=${SHA(i + 1)} status PASS`, isError: false,
})));
const overflowCtx = fakeCtx("compliant");
const overflowResult = await summarizeBatch(overflowBatch, cfgOn, overflowCtx.ctx);
ok("overflow is rejected with reason=overflow", overflowResult !== null &&
  overflowResult[PROTECTION_FAILURE_MARKER] === true && overflowResult.reason === "overflow");
const overflowCalls = overflowCtx.calls.n;
await summarizeBatch(overflowBatch, cfgOn, overflowCtx.ctx);
ok("overflow failures are also retry-suppressed", overflowCtx.calls.n === overflowCalls && protectionFailureCount() >= 1);

// ── 6. Key stability and sensitivity ────────────────────────────────────────
ok("protection key is stable and does not embed content",
  protectionFailureKey("hello", cfgOn) === protectionFailureKey("hello", cfgOn) && !protectionFailureKey("hello", cfgOn).includes("hello"));
ok("protection key changes with content, target and model",
  protectionFailureKey("a", cfgOn) !== protectionFailureKey("b", cfgOn) &&
  protectionFailureKey("a", cfgOn) !== protectionFailureKey("a", { ...cfgOn, protectedSummaryTargetChars: 1 }) &&
  protectionFailureKey("a", cfgOn) !== protectionFailureKey("a", { ...cfgOn, summarizerModel: "x/y" }));
ok("OFF config never creates a suppression path", await (async () => {
  clearProtectionFailures();
  const offCtx = fakeCtx("lossy");
  const r = await summarizeBatch(PROTECTED_BATCH, cfgOff, offCtx.ctx);
  return r !== null && r.summaryText !== undefined && protectionFailureCount() === 0;
})());

// ── 7. Phase33: scan limit is fail-closed ───────────────────────────────────
const filler = (n) => Array.from({ length: n }, () => `note ${SHA(1)}`).join("\n");
const withTail = (n, tail) => `${filler(n)}\n${tail}`;
for (const n of [3999, 4000]) {
  const detailed = extractProtectedItemsDetailed(filler(n));
  ok(`${n} matches complete the scan`, detailed.truncated === false && detailed.scanned === n);
  ok(`${n} matches pass verification`, verifyProtectedSummary(filler(n), SHA(1)).ok === true);
}
for (const n of [4001, 10000]) {
  const detailed = extractProtectedItemsDetailed(filler(n));
  ok(`${n} matches fail closed on the scan limit`,
    detailed.truncated === true && verifyProtectedSummary(filler(n), SHA(1)).ok === false &&
    verifyProtectedSummary(filler(n), SHA(1)).truncated === true);
}
ok("truncation is distinct from missing and overflow",
  protectionRejectionReason({ truncated: true, overflow: [], missing: [], ok: false, checked: 0, required: 0, advisoryMissing: [] }) === "incomplete" &&
  protectionRejectionReason({ truncated: false, overflow: ["path"], missing: [], ok: false, checked: 0, required: 0, advisoryMissing: [] }) === "overflow");
for (const [label, tail] of [
  ["SHA", `FINAL_SHA=${SHA(7)}`],
  ["ROLLBACK", "ROLLBACK=restore /opt/heroking/releases/jra-da015ff from snapshot"],
  ["UNFINISHED_TASK", "UNFINISHED_TASK: resume Phase 18 tracing"],
]) {
  const raw = withTail(4001, tail);
  const verdict = verifyProtectedSummary(raw, `${SHA(1)} ${tail}`);
  ok(`an unscanned trailing ${label} cannot pass`, verdict.ok === false && verdict.truncated === true);
}
clearProtectionFailures();
const truncCtx = fakeCtx("compliant", "trunc");
// 100 tool calls x 43 single-match lines keeps each result under the 2000-char
// serialization cap while pushing the total match count past 4000.
const bigCalls = Array.from({ length: 100 }, (_, i) => ({
  toolName: "bash", toolCallId: `big${i}`, args: {}, isError: false,
  resultText: Array.from({ length: 43 }, () => `note ${SHA(1)}`).join("\n"),
}));
const truncResult = await summarizeBatch(batch(bigCalls), cfgOn, truncCtx.ctx);
ok("summarize layer reports incomplete for a truncated scan",
  truncResult !== null && truncResult[PROTECTION_FAILURE_MARKER] === true && truncResult.reason === "incomplete");

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
