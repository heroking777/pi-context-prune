// Phase 32 — protection-failure retry suppression and overflow handling.
import {
  DEFAULT_CONFIG, summarizeBatch, extractProtectedItems, extractProtectedItemsDetailed,
  verifyProtectedSummary, protectionFailureKey, PROTECTION_FAILURE_MARKER,
  protectionFailureCount, clearProtectionFailures, RATE_LIMITED_MARKER, ok,
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

function fakeCtx(behaviour) {
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
