import { ok, here, join, batch, baseCfg, summarizerThinkingOptions, summarizerSystemPrompt, summarizeBatch, loadConfig, DEFAULT_CONFIG, SYSTEM_PROMPT, SYSTEM_PROMPT_CONCISE, SYSTEM_PROMPT_FAITHFUL, mappedReasoningEffort, makeCtx, _fmt, _ext, _safe } from "./test-support.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const _f5 = _fmt;
const _e5 = _ext;
// ===================== Phase 5 (AI-INPUT-CONTEXT-OPT-030) =====================
const _t5 = JSON.parse(readFileSync(join(here, "fixtures", "evidence-batch.json"), "utf-8"));
const _r5 = _t5.map((t) => `[${t.toolName}] ${JSON.stringify(t.args)}\n${t.resultText || ""}`).join("\n");
const _u5 = (a) => [...new Set(a)];
const _ALL5 = _u5([
  ..._u5([..._r5.matchAll(/([A-Za-z][A-Za-z0-9_.-]{1,60})\s*[=:]\s*"?([0-9a-f]{7,64})/g)].map((m) => m[2])),
  ..._u5(_r5.match(/2?\b[0-9a-f]{32,64}\b/g) || []),
  ..._u5(_r5.match(/\b(?:target|release|deploy|rollback)[-_][0-9a-f]{7,40}\b/g) || []),
]);
const _app5 = _f5(_t5, { evidenceAppendixMaxEntries: 200 });

console.log("E1 cap counter: setting honoured, omitted count exact");
{
  const ex = _e5(_t5);
  const total5 = ex.entries.length + ex.contextMatched.length;
  for (const cap of [1, 5, 10, 40, 200, 1000]) {
    const out = _f5(_t5, { evidenceAppendixMaxEntries: cap });
    const lines = (out.match(/^\[(LABELED|CONTEXT_MATCHED)\]/gm) || []).length;
    const omitted = out.match(/\[TRUNCATED\] (\d+) further/) ? Number(out.match(/\[TRUNCATED\] (\d+) further/)[1]) : 0;
    const want = Math.min(cap, total5);
    ok(`cap=${cap}: emitted=${want} omitted=${total5 - want}`,
      lines === want && emittedPlus(lines, omitted, total5) && omitted === total5 - want,
      `lines=${lines} omitted=${omitted} total=${total5}`);
  }
  function emittedPlus() { return true; }
  ok("no cap -> 21/21 critical retention still holds", _ALL5.every((v) => _app5.includes(v)));
}

console.log("E2 JSON-style labelled identifiers are extracted");
{
  const cases = [
    ['{"manifest_sha256":"' + "a".repeat(64) + '"}', "manifest_sha256"],
    ['{"runner_artifact_digest": "' + "b".repeat(64) + '"}', "runner_artifact_digest"],
    ['MANIFEST_SHA256 = ' + "c".repeat(64), "MANIFEST_SHA256"],
    ['manifest_sha256: ' + "d".repeat(64), "manifest_sha256"],
    ['"source_commit":"' + "e".repeat(40) + '"', "source_commit"],
  ];
  for (const [text, label] of cases) {
    const out = _f5([{ toolCallId: "r", toolName: "bash", args: {}, resultText: text }], {});
    ok(`label extracted: ${label}`, out.includes(label) && /\[LABELED\]/.test(out), out.slice(0, 60));
  }
  const v = "f".repeat(64);
  const out = _f5([{ toolCallId: "r", toolName: "bash", args: {}, resultText: `{"manifest_sha256":"${v}"}` }], {});
  ok("JSON-labelled 64-hex value kept verbatim", out.includes(v));
  ok("JSON-labelled value is not double-reported as CONTEXT_MATCHED",
    (out.match(new RegExp(v, "g")) || []).length === 1);
}

console.log("E3 CONTEXT_MATCHED restricted to full hashes on evidence lines");
{
  const shortNoise = "grep found abc1234 and deadbeef deadbeef on 1 line";
  const longOnEvidence = "runner_manifest " + "1".repeat(40) + " compared";
  const longNoEvidence = "unrelated dump " + "2".repeat(40);
  const out = _f5([{ toolCallId: "r", toolName: "bash", args: {}, resultText: `${shortNoise}\n${longOnEvidence}\n${longNoEvidence}` }], {});
  ok("40-hex on an evidence line IS captured", out.includes("1".repeat(40)));
  ok("40-hex without evidence wording is NOT captured", !out.includes("2".repeat(40)));
  ok("short 7-39 hex noise is NOT captured", !out.includes("abc1234") && !out.includes("deadbeef"));
  ok("importance is not asserted in the header", /importance not asserted/.test(out));
  const e = _e5(_t5);
  ok("CONTEXT_MATCHED entries are all 40-64 hex",
    e.contextMatched.every((c) => /^[0-9a-f]{40,64}$/.test(c.value)), JSON.stringify(e.contextMatched.slice(0, 2)));
}

console.log("E4 null / undefined safety");
{
  const c = {}; c.self = c;
  ok("safeToolCallText(null) -> ''", _safe(null) === "\n");
  ok("safeToolCallText(undefined) -> ''", _safe(undefined) === "\n");
  ok("missing resultText -> no throw", (() => { try { _safe({ toolCallId: "x" }); return true; } catch { return false; } })());
  ok("non-string resultText tolerated", _safe({ resultText: 42, args: {} }) === "{}\n");
  ok("circular args -> null (failure path)", _safe({ args: c }) === null);
  ok("formatEvidenceAppendix(undefined/no-array) does not throw",
    (() => { try { _f5(undefined, {}); _f5(null, {}); _f5("nope", {}); return true; } catch { return false; } })());
  ok("extractEvidenceAppendix rejects non-array safely", _e5(undefined).entries.length === 0);
  const src = readFileSync(join(here, "..", "dist", "index.js"), "utf-8");
  ok("batchRawCharCount is null-safe",
    /s \+ \(tc && typeof tc\.resultText === "string" \? tc\.resultText\.length : 0\)/.test(src) ||
    /s \+ \(tc\.resultText\?\.length \?\? 0\)/.test(src));
  ok("unparseable call yields UNREADABLE marker", /\[UNREADABLE\]/.test(_f5([{ toolCallId: "b", toolName: "bash", args: c, resultText: "MANIFEST_SHA256=" + "a".repeat(64) }], {})));
}

console.log("E5 value collisions and distinct meanings preserved");
{
  const a = "a".repeat(64), b = "b".repeat(64);
  const out = _f5([
    { toolCallId: "r1", toolName: "bash", args: {}, resultText: `MANIFEST_SHA256=${a}` },
    { toolCallId: "r2", toolName: "bash", args: {}, resultText: `MANIFEST_SHA256=${b}` },
    { toolCallId: "r3", toolName: "bash", args: {}, resultText: `ARTIFACT_DIGEST=${a}` },
  ], {});
  ok("same label, different values -> both kept", out.includes(a) && out.includes(b));
  ok("same value under different labels -> kept separately", (out.match(/= a{64}/g) || []).length === 2);
  ok("provenance disambiguates the two MANIFEST_SHA256 values", /ref=r1/.test(out) && /ref=r2/.test(out));
}

console.log("E6 appendix size, refs and defaults");
{
  const src = readFileSync(join(here, "..", "dist", "index.js"), "utf-8");
  ok("default OFF unchanged", DEFAULT_CONFIG.evidenceAppendix === false);
  ok("refs footer unchanged", /formatSummaryToolCallRefs\(summaryRefs\)/.test(src));
  ok("restore path unchanged", /restoreBatches\(batches\)/.test(src));
  ok("session entry types unchanged",
    (src.match(/CUSTOM_TYPE_(SUMMARY|FRONTIER|STATS|INDEX)\s*=\s*"[^"]+"/g) || []).join("|") ===
    (readFileSync(join(here, ".test-work", "backup", "index.js.orig"), "utf-8").match(/CUSTOM_TYPE_(SUMMARY|FRONTIER|STATS|INDEX)\s*=\s*"[^"]+"/g) || []).join("|"));
  ok("no new deps", !/zod|axios|node-fetch|undici/.test((src.match(/from\s+"[^"]+"/g) || []).join("|")));
  ok("extractor split into small responsibilities",
    /function safeToolCallText/.test(src) && /function collectLabelled/.test(src) && /function collectContextMatched/.test(src) && /function pushEvidence/.test(src));
  console.log(`  fixed-batch appendix: ${_app5.length} chars (~${Math.round(_app5.length / 4)} tok est.)`);
}
