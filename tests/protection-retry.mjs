// Phase 32/33 — protection-failure retry suppression, overflow and scan limits.
import { DEFAULT_CONFIG, summarizeBatch, extractProtectedItems, extractProtectedItemsDetailed,
  verifyProtectedSummary, protectionFailureKey, PROTECTION_FAILURE_MARKER,
  protectionFailureCount, clearProtectionFailures, protectionRejectionReason,
  RATE_LIMITED_MARKER, ok } from "./test-support.mjs";
import { SHA, PATH, PROTECTED_BATCH, fakeCtx, batch, variation, cfgOn, cfgOff } from "./protection-helpers.mjs";
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

// ── 4. Overflow handling (tier 1 only) ─────────────────────────────────────
const decisionN = (n) => `DECISION=policy-${n}`;
const rawWithN = (n) => Array.from({ length: n }, (_, i) => decisionN(i + 1)).join("\n");
const summaryWithAll = (n) => Array.from({ length: n }, (_, i) => `policy-${i + 1}`).join(" ");
for (const n of [24, 25]) {
  const detailed = extractProtectedItemsDetailed(rawWithN(n));
  ok(`${n} tier-1 items do not overflow`, detailed.overflowCategories.length === 0 &&
    extractProtectedItems(rawWithN(n)).length === n &&
    verifyProtectedSummary(rawWithN(n), summaryWithAll(n)).ok === true);
}
const over = extractProtectedItemsDetailed(rawWithN(26));
ok("26 tier-1 items report overflow instead of silently passing",
  over.overflowCategories.includes("decision") && extractProtectedItems(rawWithN(26)).length === 25 &&
  verifyProtectedSummary(rawWithN(26), summaryWithAll(26)).ok === false &&
  verifyProtectedSummary(rawWithN(26), summaryWithAll(26)).overflow.includes("decision"));
const paths26 = Array.from({ length: 26 }, (_, i) => `/opt/heroking/releases/r${i}/bin/app_${i}.py`).join("\n");
ok("many distinct paths are tier 2 and never overflow",
  extractProtectedItemsDetailed(paths26).overflowCategories.length === 0 &&
  verifyProtectedSummary(paths26, "no detail kept").ok === true &&
  verifyProtectedSummary(paths26, "no detail kept").tier2Omitted >= 25);
const dup = Array.from({ length: 40 }, () => decisionN(1)).join("\n");
ok("duplicate tier-1 values never overflow",
  extractProtectedItemsDetailed(dup).overflowCategories.length === 0 && verifyProtectedSummary(dup, "policy-1").ok === true);
const rollbackLast = `${rawWithN(26)}\nROLLBACK=restore /opt/heroking/releases/jra-da015ff from snapshot`;
const rollbackVerdict = verifyProtectedSummary(rollbackLast, `${summaryWithAll(26)}\nrestore /opt/heroking/releases/jra-da015ff from snapshot`);
ok("a late ROLLBACK after overflow still cannot pass",
  rollbackVerdict.ok === false && rollbackVerdict.overflow.includes("decision") && rollbackVerdict.missing.length === 0);

// ── 5. Overflow produces a distinguishable failure at the summarize layer ───
clearProtectionFailures();
const overflowBatch = batch(Array.from({ length: 26 }, (_, i) => ({
  toolName: "bash", toolCallId: `o${i}`, args: { command: `step ${i}` }, resultText: `DECISION=policy-${i + 1} status PASS`, isError: false,
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
const filler = (n) => Array.from({ length: n }, () => "DECISION=D").join("\n");
const withTail = (n, tail) => `${filler(n)}\n${tail}`;
for (const n of [3999, 4000]) {
  const detailed = extractProtectedItemsDetailed(filler(n));
  ok(`${n} tier-1 matches complete the scan`, detailed.truncated === false && detailed.scanned === n);
  ok(`${n} tier-1 matches pass verification`, verifyProtectedSummary(filler(n), "D").ok === true);
}
for (const n of [4001, 10000]) {
  const detailed = extractProtectedItemsDetailed(filler(n));
  ok(`${n} tier-1 matches fail closed on the scan limit`,
    detailed.truncated === true && verifyProtectedSummary(filler(n), "D").ok === false &&
    verifyProtectedSummary(filler(n), "D").truncated === true);
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
  const verdict = verifyProtectedSummary(raw, `D ${tail}`);
  ok(`an unscanned trailing ${label} cannot pass`, verdict.ok === false && verdict.truncated === true);
}
clearProtectionFailures();
const truncCtx = fakeCtx("compliant", "trunc");
// 100 tool calls x 43 single-match lines keeps each result under the 2000-char
// serialization cap while pushing the total match count past 4000.
const bigCalls = Array.from({ length: 100 }, (_, i) => ({
  toolName: "bash", toolCallId: `big${i}`, args: {}, isError: false,
  resultText: Array.from({ length: 43 }, () => "DECISION=D").join("\n"),
}));
const truncResult = await summarizeBatch(batch(bigCalls), cfgOn, truncCtx.ctx);
ok("summarize layer reports incomplete for a truncated scan",
  truncResult !== null && truncResult[PROTECTION_FAILURE_MARKER] === true && truncResult.reason === "incomplete");
