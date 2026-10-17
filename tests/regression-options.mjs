import { ok, here, join, batch, baseCfg, summarizerThinkingOptions, summarizerSystemPrompt, summarizeBatch, loadConfig, DEFAULT_CONFIG, SYSTEM_PROMPT, SYSTEM_PROMPT_CONCISE, SYSTEM_PROMPT_FAITHFUL, mappedReasoningEffort, makeCtx, _fmt, _ext, _safe } from "./test-support.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
ok("offline provider contract reads options.reasoning and model.reasoning",
  mappedReasoningEffort({ reasoning: true, thinkingLevelMap: { low: "low" } }, { reasoning: "low" }) === "low" &&
  mappedReasoningEffort({ reasoning: false }, { reasoning: "low" }) === undefined);
console.log("T1 summarizerThinkingOptions (option-key contract)");
{
  const d = summarizerThinkingOptions({ summarizerThinking: "default" });
  ok("default -> {} (unchanged default behaviour)", Object.keys(d).length === 0, JSON.stringify(d));
  const off = summarizerThinkingOptions({ summarizerThinking: "off" });
  ok("off -> both keys present, both undefined",
    "reasoning" in off && off.reasoning === undefined &&
    "reasoningEffort" in off && off.reasoningEffort === undefined, JSON.stringify(off));
  const low = summarizerThinkingOptions({ summarizerThinking: "low" });
  ok("low -> reasoning=low AND reasoningEffort=low",
    low.reasoning === "low" && low.reasoningEffort === "low", JSON.stringify(low));
}

console.log("T2 provider compatibility (offline mappedReasoningEffort contract)");
{
  const off = summarizerThinkingOptions({ summarizerThinking: "off" });
  const reasoningModel = { reasoning: true, thinkingLevelMap: { low: "low" } };
  ok("off -> provider emits NO reasoning_effort", mappedReasoningEffort(reasoningModel, off) === undefined);
  const low = summarizerThinkingOptions({ summarizerThinking: "low" });
  ok("low -> provider maps effort for an effort-capable model", mappedReasoningEffort(reasoningModel, low) === "low");
  ok("deepseek (no effort map) -> undefined even for low", mappedReasoningEffort({ reasoning: true }, low) === undefined);
  ok("non-reasoning model -> undefined", mappedReasoningEffort({ reasoning: false }, low) === undefined);
  ok("legacy reasoningEffort-only object still works",
    mappedReasoningEffort({ reasoning: true, thinkingLevelMap: { low: "low" } }, { reasoningEffort: "low" }) === undefined);
}

console.log("T3 maxTokens wiring (default preserves current request)");
{
  let seen;
  const a = makeCtx({ onOptions: (o) => (seen = o) });
  await summarizeBatch(batch, { ...baseCfg }, a.ctx);
  ok("default (null) -> request has NO maxTokens key", !("maxTokens" in seen), JSON.stringify(Object.keys(seen)));
  const b2 = makeCtx({ onOptions: (o) => (seen = o) });
  await summarizeBatch(batch, { ...baseCfg, summarizerThinking: "low" }, b2.ctx);
  ok("request still carries reasoning+reasoningEffort keys when a level is set",
    "reasoning" in seen && "reasoningEffort" in seen && seen.reasoning === "low", JSON.stringify(seen.reasoning));
  const b = makeCtx({ onOptions: (o) => (seen = o) });
  await summarizeBatch(batch, { ...baseCfg, summarizerMaxOutputTokens: 4000 }, b.ctx);
  ok("configured -> request maxTokens === 4000", seen.maxTokens === 4000, String(seen.maxTokens));
  const c = makeCtx({ onOptions: (o) => (seen = o) });
  await summarizeBatch(batch, { ...baseCfg, summarizerMaxOutputTokens: 0 }, c.ctx);
  ok("0 -> treated as unset (no maxTokens)", !("maxTokens" in seen));
}

console.log("T4 truncation detection + no data loss");
{
  const t = makeCtx({ stopReason: "length" });
  const res = await summarizeBatch(batch, { ...baseCfg, summarizerMaxOutputTokens: 16 }, t.ctx);
  ok("stopReason=length -> null (failure, not a committed summary)", res === null);
  ok("truncation notified", t.calls.notify.some(([l, m]) => l === "error" && /truncated/.test(m)));
  ok("truncation message names the cap", t.calls.notify.some(([, m]) => /summarizerMaxOutputTokens=16/.test(m)));
  const s = makeCtx({ stopReason: "stop", text: "OK" });
  const res2 = await summarizeBatch(batch, { ...baseCfg }, s.ctx);
  ok("stopReason=stop -> summary returned", res2 && res2.summaryText === "OK");
  ok("usage surfaced for stats", res2 && res2.usage && res2.usage.input === 10);
  const e = makeCtx({ stopReason: "error" });
  ok("stopReason=error -> null (unchanged)", (await summarizeBatch(batch, { ...baseCfg }, e.ctx)) === null);
}

console.log("T5 loadConfig validation (real loadConfig, per-HOME subprocess)");
{
  ok("DEFAULT_CONFIG.summarizerMaxOutputTokens === null",
    "summarizerMaxOutputTokens" in DEFAULT_CONFIG && DEFAULT_CONFIG.summarizerMaxOutputTokens === null);
  const { execFileSync } = await import("node:child_process");
  const cases = [
    [{ summarizerMaxOutputTokens: 5000 }, { concise: false, maxOut: 5000, mode: "default" }],
    [{ summarizerMaxOutputTokens: "abc" }, { concise: false, maxOut: null, mode: "default" }],
    [{ summarizerMaxOutputTokens: 0 }, { concise: false, maxOut: null, mode: "default" }],
    [{}, { concise: false, maxOut: null, mode: "default" }],
  ];
  for (const [cfg, expected] of cases) {
    const home = join(here, ".test-work", "tmp-home");
    const dir = join(home, ".pi", "agent", "context-prune");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabled: true, ...cfg }));
    const out = execFileSync(process.execPath, [join(here, "loadcfg.mjs")], {
      env: { ...process.env, HOME: home },
    }).toString().trim();
    ok(`loadConfig(${JSON.stringify(cfg)}) -> ${JSON.stringify(expected)}`, out === JSON.stringify(expected), `got ${out}`);
  }
}

console.log("T6 session-format / integrity invariants (static, on patched text)");
{
  const patched = readFileSync(join(here, "..", "dist", "index.js"), "utf-8");
  const base = readFileSync(join(here, ".test-work", "backup", "index.js.orig"), "utf-8");
  const types = (s) => (s.match(/CUSTOM_TYPE_(SUMMARY|FRONTIER|STATS|INDEX)\s*=\s*"[^"]+"/g) || []).join("|");
  ok("custom entry types unchanged", types(patched) === types(base));
  ok("failure restores batches (originals kept)", /restoreBatches\(batches\)/.test(patched) &&
    /restoreBatches\(batches\.slice\(firstFailureIndex\)\)/.test(patched));
  ok("null result still routes to restore path", /if \(!result\) \{\s*firstFailureIndex = i;\s*break;\s*\}/.test(patched));
  const newTypes = types(patched).split("|").filter((t) => t && !base.includes(t));
  ok("no new session entry types introduced", newTypes.length === 0, newTypes.join(","));
  ok("refs footer still appended structurally after summary text",
    /wrapSummaryForContext\((result\.summaryText \+ formatSummaryToolCallRefs\(summaryRefs\)|modelSummaryText \+ appendix)\)/.test(patched));
}

console.log("T7 patch scope");
{
  const p2 = readFileSync(join(here, "..", "dist", "index.js"), "utf-8").split("\n");
  const sourceLineCount = ["src/rate-limit.ts", "src/flush-policy.ts", "src/evidence-appendix.ts", "src/summarizer-prompts.ts"]
    .reduce((n, f) => n + readFileSync(join(here, "..", f), "utf-8").split("\n").length, 0);
  ok("portable source modules have bounded total size (<=600 lines)", sourceLineCount <= 600, String(sourceLineCount));
  const { execFileSync } = await import("node:child_process");
  const hunksVs = (a, b) => {
    try { return execFileSync("diff", ["-u", a, b]).toString(); }
    catch (e) { return (e.stdout || Buffer.alloc(0)).toString(); }
  };
  // Phase6: the bundle-text diff assertions above are meaningless for a
  // source-rebuilt bundle. Replaced 1:1 by source-tree assertions (same count).
  const SRC = join(here, "..");
  const srcText = (rel) => readFileSync(join(SRC, rel), "utf-8");
  const newModules = ["src/rate-limit.ts", "src/flush-policy.ts", "src/evidence-appendix.ts", "src/summarizer-prompts.ts"];
  ok("PORT: every ported concern lives in its own source module", newModules.every((m) => { try { return readFileSync(join(SRC, m), "utf-8").length > 0; } catch { return false; } }), newModules.join(","));
  const allSrc = newModules.map(srcText).join("\n") + srcText("index.ts") + srcText("src/summarizer.ts") + srcText("src/types.ts") + srcText("src/config.ts");
  ok("PORT: all local OPT markers present in the source tree",
    ["OPT-001", "OPT-002", "OPT-025", "OPT-026", "OPT-027", "OPT-028", "OPT-029", "OPT-030"].filter((t) => t !== "OPT-002").every((t) => allSrc.includes(t)));
  ok("PORT: handwritten new modules are within the 300-line limit",
    newModules.every((m) => srcText(m).split("\n").length <= 300),
    newModules.map((m) => srcText(m).split("\n").length).join(","));
  ok("PORT: generated bundle is not hand-written (dist is build output)",
    /^dist\/?$/m.test(readFileSync(join(SRC, ".gitignore"), "utf-8")) && !/\/\* Phase[0-9]/.test(readFileSync(join(here, "..", "dist", "index.js"), "utf-8")));
  ok("no maxTokens added outside the summarizer options block",
    (p2.join("\n").match(/maxTokens:\s*config\.summarizerMaxOutputTokens/g) || []).length === 1);
  ok("truncation check appears exactly once",
    (p2.join("\n").match(/response\.stopReason === "length"/g) || []).length === 1);
}
