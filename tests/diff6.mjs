// Phase6 STEP 4 — semantic differential harness.
//
// Compares the SOURCE-REBUILT bundle against an explicitly supplied Phase5
// reference module (PRUNER_PHASE5_BUNDLE). Reference bundles are generated
// artifacts and are never committed. No network, no real LLM call.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const NEW = await import(join(here, ".test-work", "testable.mjs"));
const refBundle = process.env.PRUNER_PHASE5_BUNDLE;
if (!refBundle) {
  console.log("DIFFERENTIAL=SKIP (set PRUNER_PHASE5_BUNDLE to an external Phase5 reference bundle; no reference bundle is committed)");
  process.exit(2);
}
const REF = await import(refBundle.startsWith("/") ? refBundle : join(process.cwd(), refBundle));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
const eq = (a, b) => JSON.stringify(sortish(a)) === JSON.stringify(sortish(b));
const sortish = (v) => (Array.isArray(v) ? v.map(sortish)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortish(v[k])])) : v);

console.log("S1 constants / config defaults");
{
  ok("RATE_LIMITED_MARKER identical", NEW.RATE_LIMITED_MARKER === REF.RATE_LIMITED_MARKER);
  ok("CREDIT_EXHAUSTED_MARKER identical", NEW.CREDIT_EXHAUSTED_MARKER === REF.CREDIT_EXHAUSTED_MARKER);
  ok("cooldown default identical", NEW.RATE_LIMIT_DEFAULT_COOLDOWN_MS === REF.RATE_LIMIT_DEFAULT_COOLDOWN_MS);
  ok("DEFAULT_CONFIG deep-equal (all keys, incl. OPT-001/025 + Phase1-5)",
    eq(NEW.DEFAULT_CONFIG, REF.DEFAULT_CONFIG),
    `${JSON.stringify(NEW.DEFAULT_CONFIG)} vs ${JSON.stringify(REF.DEFAULT_CONFIG)}`);
  ok("no new session entry types", [NEW.CUSTOM_TYPE_SUMMARY, NEW.CUSTOM_TYPE_INDEX, NEW.CUSTOM_TYPE_STATS, NEW.CUSTOM_TYPE_FRONTIER]
    .every((v, i) => v === [REF.CUSTOM_TYPE_SUMMARY, REF.CUSTOM_TYPE_INDEX, REF.CUSTOM_TYPE_STATS, REF.CUSTOM_TYPE_FRONTIER][i]));
}

console.log("S2 prompt text byte-equality (Phase2/3) + A/B/C selection");
{
  for (const k of ["SYSTEM_PROMPT", "SYSTEM_PROMPT_CONCISE", "SYSTEM_PROMPT_FAITHFUL"]) {
    ok(`${k} byte-identical`, NEW[k] === REF[k], `new=${NEW[k]?.length} ref=${REF[k]?.length}`);
  }
  const modes = [
    {}, { summarizerPromptMode: "default" }, { summarizerPromptMode: "concise" },
    { summarizerPromptMode: "faithful" }, { conciseSummaryMode: true },
    { conciseSummaryMode: true, summarizerPromptMode: "faithful" },
    { summarizerPromptMode: "bogus" },
  ];
  ok("summarizerSystemPrompt selection identical for 7 configs",
    modes.every((m) => NEW.summarizerSystemPrompt(m) === REF.summarizerSystemPrompt(m)));
}

console.log("S3 thinking options (Phase1) incl. Command Code mapping");
{
  const levels = ["default", "off", "minimal", "low", "medium", "high", "xhigh"];
  ok("summarizerThinkingOptions identical for all levels",
    levels.every((l) => eq(NEW.summarizerThinkingOptions({ summarizerThinking: l }), REF.summarizerThinkingOptions({ summarizerThinking: l }))));
  ok("`off` emits both keys as undefined (nothing on the wire)",
    eq(NEW.summarizerThinkingOptions({ summarizerThinking: "off" }), { reasoning: undefined, reasoningEffort: undefined }));
}

console.log("S4 evidence appendix (Phase4/5) over the real fixed batch + edges");
{
  const batch = JSON.parse(readFileSync(join(here, "fixtures", "evidence-batch.json"), "utf-8"));
  const cfgs = [{}, { evidenceAppendixMaxEntries: 1 }, { evidenceAppendixMaxEntries: 5 }, { evidenceAppendixMaxEntries: 200 }, { evidenceAppendixMaxEntries: 1000 }];
  ok("formatEvidenceAppendix identical (fixed batch x 5 caps)",
    cfgs.every((c) => NEW.formatEvidenceAppendix(batch, c, 54691) === REF.formatEvidenceAppendix(batch, c, 54691)));
  ok("formatEvidenceAppendix identical (budget boundary)",
    [0, 100, 1000, 54691, undefined].every((b) => NEW.formatEvidenceAppendix(batch, {}, b) === REF.formatEvidenceAppendix(batch, {}, b)));
  const edge = [
    [{ toolCallId: "a", toolName: "bash", args: {}, resultText: "MANIFEST_SHA256=" + "a".repeat(64) }],
    [{ toolCallId: "a", toolName: "bash", args: {}, resultText: '{"k":"' + "b".repeat(64) + '"}' }],
    [{ toolCallId: "a", toolName: "bash", args: {}, resultText: "sha " + "c".repeat(40) }],
    [{ toolCallId: "a", toolName: "bash", args: {}, resultText: "noise " + "d".repeat(40) }],
    [{ toolCallId: "a", toolName: "bash", args: {}, resultText: "target-release-abcd1234" }],
    [{ toolCallId: "a", toolName: "bash", args: {}, resultText: "e".repeat(40) + "x".repeat(300) }],
    [], [{}], [{ toolCallId: "x" }], [{ toolCallId: "y", resultText: 42 }],
    [{ toolCallId: "z", args: (() => { const o = {}; o.self = o; return o; })() }],
  ];
  ok("formatEvidenceAppendix identical over 11 edge inputs",
    edge.every((e) => NEW.formatEvidenceAppendix(e, {}, 1e9) === REF.formatEvidenceAppendix(e, {}, 1e9)));
  ok("extractEvidenceAppendix identical (entries/contextMatched/refs/failures)",
    edge.every((e) => eq(NEW.extractEvidenceAppendix(e), REF.extractEvidenceAppendix(e))));
  ok("safeToolCallText identical over 11 edge inputs",
    edge.map((e) => e[0]).concat([null, undefined]).every((tc) => NEW.safeToolCallText(tc) === REF.safeToolCallText(tc)));
}

console.log("S5 OPT-025 rate-limit / credit detection");
{
  const cases = [
    { status: 429 }, { statusCode: 429 }, { $metadata: { httpStatusCode: 429 } },
    { message: "429 Too Many Requests" }, { message: "FreeUsageLimitError" },
    { message: "GoUsageLimitError: monthly usage limit reached" },
    { message: "quota exceeded" }, { message: "out of budget" },
    { message: "rate limit hit" }, { message: "available balance is 0" },
    { message: "insufficient_quota" }, { message: "connect ETIMEDOUT" },
    { message: "HTTP 500 Internal Server Error" }, { message: "500: server error" },
    { message: "400: insufficient credits" }, { status: 400, message: "insufficient credits" },
    { message: "400: bad request" }, { message: "4290 not a 429" },
    { prunerResponse: { errorMessage: "429" } }, { prunerResponse: { status: 400, errorMessage: "insufficient credits" } },
    new Error("plain error"), null, undefined, { message: "" },
  ];
  ok("isRateLimitFailure identical over 24 error shapes",
    cases.every((c) => NEW.isRateLimitFailure(c) === REF.isRateLimitFailure(c)));
  ok("isCreditExhaustedFailure identical over 24 error shapes",
    cases.every((c) => NEW.isCreditExhaustedFailure(c) === REF.isCreditExhaustedFailure(c)));
  const batches = [
    { toolCalls: [{ toolCallId: "b" }, { toolCallId: "a" }] },
    { toolCalls: [{ toolCallId: "a" }, { toolCallId: "b" }] },
    { toolCalls: [{ toolCallId: "solo" }] },
  ];
  ok("rateLimitBatchKey identical (order-insensitive)", batches.every((b) => NEW.rateLimitBatchKey(b) === REF.rateLimitBatchKey(b)));
}

console.log("S6 OPT-025 size floor (new module vs reference inline behaviour)");
{
  const cfgs = [{ minRawCharsForSummary: 0 }, { minRawCharsForSummary: 10000 }, { minRawCharsForSummary: undefined }, { minRawCharsForSummary: -5 }];
  const refFloorOf = (cfg) => (Number.isFinite(cfg.minRawCharsForSummary) && cfg.minRawCharsForSummary >= 0 ? cfg.minRawCharsForSummary : 0);
  ok("floorThreshold identical to the reference inline rule", cfgs.every((c) => NEW.floorThreshold(c) === refFloorOf(c)));
  const refRaw = (b) => b.toolCalls.reduce((s, tc) => s + (tc.resultText?.length ?? 0), 0);
  const bs = [{ toolCalls: [{ resultText: "x".repeat(9999) }] }, { toolCalls: [{ resultText: "x".repeat(10000) }] }, { toolCalls: [] }];
  ok("batchRawChars identical to the reference inline rule", bs.every((b) => NEW.batchRawChars(b) === refRaw(b)));
  ok("isFloorSkippedBatch matches the reference comparison", bs.every((b) => NEW.isFloorSkippedBatch(b, 10000) === (refRaw(b) < 10000)));
  ok("floor skip is strictly `<`", NEW.isFloorSkippedBatch(bs[1], 10000) === false && NEW.isFloorSkippedBatch(bs[0], 10000) === true);
}

console.log("S7 OPT-001 mid-task trigger (new module vs reference inline rule)");
{
  const mk = (chars, calls) => ({ toolCalls: Array.from({ length: calls }, (_, i) => ({ toolCallId: "t" + i, resultText: "x".repeat(Math.floor(chars / calls)) })) });
  const refTrigger = (cfg, pb) => {
    if (!cfg.midTaskAutoPrune) return false;
    const pc = pb.reduce((s, b) => s + b.toolCalls.reduce((x, tc) => x + tc.resultText.length, 0), 0);
    const n = pb.reduce((s, b) => s + b.toolCalls.length, 0);
    return pc >= cfg.midTaskThresholdChars || n >= cfg.midTaskThresholdToolCalls;
  };
  const base = { midTaskAutoPrune: true, midTaskThresholdChars: 60000, midTaskThresholdToolCalls: 12 };
  const cases = [[base, [mk(0, 0)]], [base, [mk(59999, 1)]], [base, [mk(60000, 1)]], [base, [mk(1000, 12)]], [base, [mk(1000, 11)]],
    [{ ...base, midTaskAutoPrune: false }, [mk(1e6, 100)]], [{ ...base, midTaskThresholdChars: 0 }, [mk(0, 0)]]];
  ok("shouldMidTaskAutoPrune identical to the reference inline rule", cases.every(([c, p]) => NEW.shouldMidTaskAutoPrune(c, p) === refTrigger(c, p)));
  ok("trigger fires at the exactly-at-threshold boundary", NEW.shouldMidTaskAutoPrune(base, [mk(60000, 1)]) === true);
}

console.log("S8 summarizeBatch wire-level equivalence (mock provider, no network)");
{
  const makeCtx = (opts = {}) => {
    const recorded = { stream: [], notify: [] };
    const provider = {
      stream(_model, _arg, options) {
        recorded.stream.push(options);
        const result = { stopReason: opts.stopReason ?? "stop", content: [{ type: "text", text: opts.text ?? "SUMMARY" }], usage: { input: 1, output: 1 } };
        return Object.assign((async function* () {})(), { result: async () => result });
      },
    };
    return {
      recorded,
      ctx: {
        model: { provider: "commandcode", id: "m" },
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "stub", headers: {}, env: {} }),
          getProvider: () => provider,
          find: () => undefined,
        },
        ui: { notify: (m, l) => recorded.notify.push([l, m]) },
      },
    };
  };
  const batch = { turnIndex: 1, timestamp: 1, toolCalls: [{ toolName: "bash", toolCallId: "t1", resultText: "x".repeat(400), args: { command: "git status" } }] };
  const cfgs = [
    { summarizerModel: "default", summarizerThinking: "default", summarizerMaxOutputTokens: null, conciseSummaryMode: false, summarizerPromptMode: "default" },
    { summarizerModel: "default", summarizerThinking: "low", summarizerMaxOutputTokens: null, summarizerPromptMode: "default" },
    { summarizerModel: "default", summarizerThinking: "off", summarizerMaxOutputTokens: 4096, summarizerPromptMode: "default" },
    { summarizerModel: "default", summarizerThinking: "default", summarizerMaxOutputTokens: null, conciseSummaryMode: true, summarizerPromptMode: "default" },
    { summarizerModel: "default", summarizerThinking: "default", summarizerMaxOutputTokens: null, summarizerPromptMode: "faithful" },
  ];
  let optsEqual = true, promptEqual = true, resEqual = true, optsDetail = "";
  for (const cfg of cfgs) {
    const a = makeCtx(), b = makeCtx();
    const ra = await NEW.summarizeBatch(batch, cfg, a.ctx, {});
    const rb = await REF.summarizeBatch(batch, cfg, b.ctx, {});
    const pick = (o) => { const { signal, headers, env, apiKey, ...rest } = o; return rest; };
    optsEqual = optsEqual && eq(pick(a.recorded.stream[0]), pick(b.recorded.stream[0]));
    if (!eq(pick(a.recorded.stream[0]), pick(b.recorded.stream[0]))) optsDetail = `${JSON.stringify(pick(a.recorded.stream[0]))} vs ${JSON.stringify(pick(b.recorded.stream[0]))}`;
    promptEqual = promptEqual && eq(ra, rb) && eq(a.recorded.notify, b.recorded.notify);
  }
  ok("summarizeBatch -> provider options identical (thinking/maxTokens) for 5 configs", optsEqual, optsDetail);
  ok("summarizeBatch -> result + notifications identical for 5 configs", promptEqual);
  // stopReason handling
  for (const sr of ["stop", "length", "error", "aborted"]) {
    const a = makeCtx({ stopReason: sr }), b = makeCtx({ stopReason: sr });
    const cfg = { summarizerModel: "default", summarizerThinking: "default", summarizerMaxOutputTokens: 4096, summarizerPromptMode: "default" };
    const ra = await NEW.summarizeBatch(batch, cfg, a.ctx, {}).catch((e) => ({ threw: e.message }));
    const rb = await REF.summarizeBatch(batch, cfg, b.ctx, {}).catch((e) => ({ threw: e.message }));
    resEqual = resEqual && eq(ra, rb) && eq(a.recorded.notify, b.recorded.notify);
  }
  ok("stopReason stop/length/error/aborted handled identically (incl. notifications)", resEqual);
  // rate-limit path
  const makeThrowing = (err) => ({ model: { provider: "p", id: "m" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "s", headers: {}, env: {} }), getProvider: () => ({ stream() { throw err; } }), find: () => undefined }, ui: { notify: () => {} } });
  const errs = [Object.assign(new Error("429 Too Many Requests"), { status: 429 }), Object.assign(new Error("400: insufficient credits"), { status: 400 }), new Error("boom")];
  ok("summarizeBatch error path identical (rate-limit / credit / generic)",
    eq(await Promise.all(errs.map((e) => NEW.summarizeBatch(batch, { summarizerModel: "default", summarizerThinking: "default" }, makeThrowing(e), {}))),
       await Promise.all(errs.map((e) => REF.summarizeBatch(batch, { summarizerModel: "default", summarizerThinking: "default" }, makeThrowing(e), {})))));
}

console.log("S9 session/index format + restore path (static, both bundles)");
{
  const newSrc = readFileSync(join(here, "..", "dist", "index.js"), "utf-8");
  const refSrc = readFileSync(process.env.PRUNER_PHASE5_BUNDLE, "utf-8");
  const pat = /context-prune-[a-z]+/g;
  ok("session entry type strings identical", eq(newSrc.match(pat), refSrc.match(pat)));
  ok("refs footer format function present in both", newSrc.includes("formatSummaryToolCallRefs") && refSrc.includes("formatSummaryToolCallRefs"));
  ok("restore path present in both", newSrc.includes("restoreBatches") && refSrc.includes("restoreBatches"));
  ok("SUMMARY_CONTEXT_TAG identical", (newSrc.match(/context-prune-summary"/g) || []).length === (refSrc.match(/context-prune-summary"/g) || []).length);
}

console.log("S10 RateLimitRegistry equivalence (exponential backoff, window, clear)");
{
  const batch = { toolCalls: [{ toolCallId: "a" }, { toolCallId: "b" }] };
  // Reference = the behaviour of the OPT-025 inline closure in the phase5 bundle.
  const refRecord = (prev, cooldownMs) => {
    const retries = (prev?.retries ?? 0) + 1;
    const baseMs = Number.isFinite(cooldownMs) && cooldownMs >= 0 ? cooldownMs : 30 * 60 * 1000;
    return { retries, cooldownMs: Math.min(baseMs * 2 ** (retries - 1), 60 * 60 * 1000) };
  };
  const reg = new NEW.RateLimitRegistry(() => 30 * 60 * 1000);
  let prev;
  const seq = [];
  for (let i = 1; i <= 4; i++) {
    const d = reg.record(batch, "e" + i);
    prev = refRecord(prev, 30 * 60 * 1000);
    seq.push(JSON.stringify(d) === JSON.stringify(prev));
  }
  ok("record() cooldown sequence matches reference (30/60/120/... capped at 60min)", seq.every(Boolean), seq.join(","));
  ok("4th record is capped at the 60 min maximum", reg.record(batch, "e5").cooldownMs === 60 * 60 * 1000);
  ok("isBlocked() true inside the window", reg.isBlocked(batch) === true);
  ok("isBlocked() false once the window elapsed", reg.isBlocked(batch, Date.now() + 61 * 60 * 1000) === false);
  ok("lastError() retains the latest message", reg.lastError(batch) === "e5");
  ok("has()/clear() lifecycle", reg.has(batch) === true && (reg.clear(batch), reg.has(batch) === false));
  ok("clear() resets the backoff exponent", (() => { const r2 = new NEW.RateLimitRegistry(() => 1000); r2.record(batch, "a"); r2.clear(batch); return r2.record(batch, "b").cooldownMs === 1000; })());
  ok("cooldownMs=0 config falls back to the 30 min default", new NEW.RateLimitRegistry(() => -1).record(batch, "x").cooldownMs === 30 * 60 * 1000);
}

console.log(`\nDIFF RESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
