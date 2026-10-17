import { ok, here, join, batch, baseCfg, summarizerThinkingOptions, summarizerSystemPrompt, summarizeBatch, loadConfig, DEFAULT_CONFIG, SYSTEM_PROMPT, SYSTEM_PROMPT_CONCISE, SYSTEM_PROMPT_FAITHFUL, mappedReasoningEffort, makeCtx, _fmt, _ext, _safe } from "./test-support.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
// ===================== Phase 4 (AI-INPUT-CONTEXT-OPT-029) =====================
const _tcs = JSON.parse(readFileSync(join(here, "fixtures", "evidence-batch.json"), "utf-8"));
const _raw = _tcs.map((t) => `[${t.toolName}] ${JSON.stringify(t.args)}\n${t.resultText || ""}`).join("\n");
const _uniq = (a) => [...new Set(a)];
const _lat = _uniq([..._raw.matchAll(/([A-Za-z][A-Za-z0-9_.-]{1,60})\s*[=:]\s*"?([0-9a-f]{7,64})/g)].map((m) => m[2]));
const _hex = _uniq(_raw.match(/\b[0-9a-f]{32,64}\b/g) || []);
const _rel = _uniq(_raw.match(/\b(?:target|release|deploy|rollback)[-_][0-9a-f]{7,40}\b/g) || []);
const _ALL = _uniq([..._lat, ..._hex, ..._rel]);
const _app = _fmt(_tcs, { evidenceAppendixMaxEntries: 200 });

console.log("D1 default OFF -> no appendix, unchanged behaviour");
{
  ok("DEFAULT_CONFIG.evidenceAppendix === false", DEFAULT_CONFIG.evidenceAppendix === false);
  ok("DEFAULT_CONFIG.evidenceAppendixMaxEntries === 200", DEFAULT_CONFIG.evidenceAppendixMaxEntries === 200);
  const src = readFileSync(join(here, "..", "dist", "index.js"), "utf-8");
  ok("appendix only added when explicitly enabled",
    /(?:config|currentConfig\.value)\.evidenceAppendix === true\s*\?\s*formatEvidenceAppendix\(batch\.toolCalls, (?:config|currentConfig\.value), batchRawCharCount\)\s*:\s*""/.test(src));
  ok("appendix is appended AFTER the refs footer",
    /wrapSummaryForContext\(modelSummaryText \+ appendix\)/.test(src));
  ok("oversized guard keeps original semantics (model summary + refs only)",
    /const shouldSkipOversized = modelSummaryText\.length > batchRawCharCount;/.test(src));
}

console.log("D2 deterministic critical retention (fixed batch)");
{
  const missing = _ALL.filter((h) => !_app.includes(h));
  ok(`all ${_ALL.length} critical/shape identifiers retained verbatim`, missing.length === 0, missing.join(","));
  ok("appendix is non-empty", _app.length > 0);
  ok("appendix declares its provenance/importance stance", /not model-generated; importance not asserted/.test(_app));
}

console.log("D3 no invention / no truncation / no normalisation");
{
  const emitted = _uniq((_app.match(/= ([0-9a-fA-F]{7,64})|\[CONTEXT_MATCHED\] ([0-9a-fA-F]{7,64})/g) || [])
    .map((s) => s.replace(/^=\s*/, "").replace(/^\[CONTEXT_MATCHED\]\s*/, "")));
  const invented = emitted.filter((v) => !_raw.includes(v));
  ok("every emitted value exists verbatim in the raw text", invented.length === 0, invented.join(","));
  const shortened = emitted.filter((v) => !new RegExp(`\\b${v}\\b`).test(_raw));
  ok("no value is a fabricated shortening", shortened.length === 0, shortened.join(","));
}

console.log("D4 provenance: ref -> originating tool call");
{
  const refToText = Object.fromEntries(_tcs.map((t, i) => [String(t.toolCallId || "idx" + i), JSON.stringify(t.args || {}) + "\n" + (t.resultText || "")]));
  let good = 0; const bad = [];
  for (const line of _app.split("\n")) {
    const m = line.match(/^\[(LABELED|CONTEXT_MATCHED)\] .*?([0-9a-fA-F]{7,64}) \(ref=([^,]+), /);
    if (!m) continue;
    if ((refToText[m[3]] || "").includes(m[2])) good++; else bad.push(`${m[2]}/${m[3]}`);
  }
  ok("all appendix entries carry a valid tool-call ref", bad.length === 0, bad.join(","));
  ok("entries verified against their own source call (>10)", good > 10, String(good));
  ok("tool name recorded per entry", /\(ref=[^,]+, [a-z_]+\)/.test(_app));
}

console.log("D5 distinct values are not confused; before/after preserved");
{
  ok(`all ${_rel.length} distinct release ids present`, _rel.every((r) => _app.includes(r)));
  const synth = [
    { toolCallId: "a", toolName: "bash", args: {}, resultText: "RELEASE_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { toolCallId: "b", toolName: "bash", args: {}, resultText: "RELEASE_SHA256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  ];
  const out = _fmt(synth, {});
  ok("same label, different values -> both kept (no overwrite)", out.includes("a".repeat(64)) && out.includes("b".repeat(64)));
  const dup = _fmt([synth[0], { ...synth[0], toolCallId: "c" }], {});
  const n = (dup.match(/RELEASE_SHA256 = a{64}/g) || []).length;
  ok("identical label+value merged (dedup)", n === 1, `count=${n}`);
  ok("distinct meaning not merged: same value under different labels stays separate",
    (_fmt([{ toolCallId: "x", toolName: "bash", args: {}, resultText: "MANIFEST_SHA=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\nARTIFACT_SHA=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }], {})
      .match(/= c{64}/g) || []).length === 2);
}

console.log("D6 cap is explicit, never silent");
{
  const small = _fmt(_tcs, { evidenceAppendixMaxEntries: 4 });
  ok("truncation marker emitted", /\[TRUNCATED\] \d+ further entr(y|ies) omitted/.test(small));
  ok("marker states extraction was not exhaustive", /NOT exhaustive/.test(small));
  const all = _fmt(_tcs, { evidenceAppendixMaxEntries: 200 });
  ok("no marker when under the cap", !/\[TRUNCATED\]/.test(all));
}

console.log("D7 extraction failure is never a silent success");
{
  const circ = {}; circ.self = circ;
  const out = _fmt([{ toolCallId: "bad", toolName: "bash", args: circ, resultText: "MANIFEST_SHA=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" }], {});
  ok("unparseable call produces an [UNREADABLE] marker, not empty output", /\[UNREADABLE\]/.test(out), out.slice(0, 80));
  ok("formatEvidenceAppendix never throws", (() => { try { _fmt(null, {}); _fmt([null], {}); _fmt([{}], {}); return true; } catch { return false; } })());
  ok("empty input -> empty appendix (no false evidence)",
    _fmt([{ toolCallId: "e", toolName: "bash", args: {}, resultText: "nothing here" }], {}) === "");
  // raw-relative budget: a tiny batch must not produce an appendix larger than the raw text
  const tinyRaw = "RELEASE_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const budgeted = _fmt([{ toolCallId: "t", toolName: "bash", args: { command: "x" }, resultText: tinyRaw }], {}, 20);
  ok("over-budget appendix degrades to an explicit OMITTED marker", /status="OMITTED"/.test(budgeted) && /nothing was shortened/.test(budgeted));
  const within = _fmt([{ toolCallId: "t", toolName: "bash", args: { command: "x" }, resultText: tinyRaw }], {}, 100000);
  ok("within-budget appendix is emitted normally", !/OMITTED/.test(within) && within.includes("a".repeat(64)));
}

console.log("D8 invariants unchanged");
{
  const src = readFileSync(join(here, "..", "dist", "index.js"), "utf-8");
  const base = readFileSync(join(here, ".test-work", "backup", "index.js.orig"), "utf-8");
  const types = (s) => (s.match(/CUSTOM_TYPE_(SUMMARY|FRONTIER|STATS|INDEX)\s*=\s*"[^"]+"/g) || []).join("|");
  ok("session entry types unchanged", types(src) === types(base));
  ok("refs footer unchanged", /formatSummaryToolCallRefs\(summaryRefs\)/.test(src));
  ok("restore path unchanged", /restoreBatches\(batches\)/.test(src));
  ok("no new deps", !/zod|axios|node-fetch|undici/.test((src.match(/from\s+"[^"]+"/g) || []).join("|")));
  ok("evidence extraction adds no API call", !/formatEvidenceAppendix[\s\S]{0,400}(stream|provider|fetch)\s*\(/.test(src));
}

console.log("D9 loadConfig validation for evidence appendix keys");
{
  const { execFileSync } = await import("node:child_process");
  for (const [input, expOn, expMax] of [
    [undefined, false, 200], [{ evidenceAppendix: true }, true, 200],
    [{ evidenceAppendix: "true" }, false, 200], [{ evidenceAppendix: true, evidenceAppendixMaxEntries: 5 }, true, 5],
    [{ evidenceAppendix: true, evidenceAppendixMaxEntries: 0 }, true, 200],
  ]) {
    const home = join(here, ".test-work", "tmp-home");
    const dir = join(home, ".pi", "agent", "context-prune");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabled: true, ...(input || {}) }));
    const out = execFileSync(process.execPath, [join(here, "loadcfg2.mjs")], { env: { ...process.env, HOME: home } }).toString().trim();
    const got = JSON.parse(out);
    ok(`evidenceAppendix=${JSON.stringify(input)} -> on=${expOn} max=${expMax}`, got.on === expOn && got.max === expMax, out);
  }
}
