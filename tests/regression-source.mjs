import { ok, here, join, batch, baseCfg, summarizerThinkingOptions, summarizerSystemPrompt, summarizeBatch, loadConfig, DEFAULT_CONFIG, SYSTEM_PROMPT, SYSTEM_PROMPT_CONCISE, SYSTEM_PROMPT_FAITHFUL, mappedReasoningEffort, makeCtx, _fmt, _ext, _safe } from "./test-support.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
console.log("P1 concise mode OFF -> prompt byte-identical to baseline");
{
  const off = summarizerSystemPrompt({ conciseSummaryMode: false });
  ok("conciseSummaryMode=false returns SYSTEM_PROMPT verbatim", off === SYSTEM_PROMPT);
  ok("undefined config falls back to SYSTEM_PROMPT", summarizerSystemPrompt(undefined) === SYSTEM_PROMPT);
  const baseline = readFileSync(join(here, ".test-work", "backup", "index.js.orig"), "utf-8");
  ok("SYSTEM_PROMPT text unchanged from original baseline", baseline.includes(SYSTEM_PROMPT));
  ok("DEFAULT_CONFIG.conciseSummaryMode === false", DEFAULT_CONFIG.conciseSummaryMode === false,
    String(DEFAULT_CONFIG.conciseSummaryMode));
}

console.log("P2 concise mode ON -> revised prompt with all required clauses");
{
  const on = summarizerSystemPrompt({ conciseSummaryMode: true });
  ok("conciseSummaryMode=true returns SYSTEM_PROMPT_CONCISE", on === SYSTEM_PROMPT_CONCISE && on !== SYSTEM_PROMPT);
  const needs = [
    ["R1 merge same target", /Merge repeated or similar calls on the same target/i],
    ["R2 edit before/after diff", /before\/after differences for edits/i],
    ["R2b verification results", /verification results/i],
    ["R2c failure->fix->success", /failure -> fix -> success/i],
    ["R3 collapse routine successes", /Collapse routine successful calls/i],
    ["R4 verbatim SHA/commit", /SHA-1\/SHA-256 hashes and commit SHAs/i],
    ["R4b verbatim paths", /file paths and directory names/i],
    ["R4c important commands", /important commands/i],
    ["R4d error strings + exit codes", /error strings and exit codes/i],
    ["R5 decisions/unresolved/next", /decisions made[\s\S]*unresolved issues and open questions[\s\S]*next actions/i],
    ["R6 avoid long bullets", /keep each bullet short/i],
    ["R6b minimise bullet count", /fewest bullets/i],
  ];
  for (const [name, re] of needs) ok(`clause present: ${name}`, re.test(on));
  ok("no hard token cap implied in prompt", !/max_tokens|maxTokens|token limit|character limit/i.test(on));
  ok("batch wrapper markup untouched", /<tool-call-batch>/.test(readFileSync(join(here, "..", "dist", "index.js"), "utf-8")));
}

console.log("P3 concise mode reaches the request (real summarizeBatch)");
{
  let seenText = null;
  const ctxProbe = makeCtx();
  const provider = {
    stream(_m, c, _o) { seenText = JSON.stringify(c); return makeCtx().ctx.modelRegistry.getProvider().stream(_m, c, _o); },
  };
  const c2 = makeCtx();
  c2.ctx.modelRegistry.getProvider = () => provider;
  await summarizeBatch(batch, { ...baseCfg, conciseSummaryMode: true }, c2.ctx);
  ok("ON  -> concise prompt sent in request context", seenText && seenText.includes("Group by DISTINCT TARGET"));
  const c3 = makeCtx();
  const provider2 = { stream: (m, c, o) => { seenText = JSON.stringify(c); return makeCtx().ctx.modelRegistry.getProvider().stream(m, c, o); } };
  c3.ctx.modelRegistry.getProvider = () => provider2;
  await summarizeBatch(batch, { ...baseCfg, conciseSummaryMode: false }, c3.ctx);
  ok("OFF -> original prompt sent in request context", seenText && seenText.includes("For each tool call provide"));
  ok("OFF request does not leak concise text", seenText && !seenText.includes("Group by DISTINCT TARGET"));
}

console.log("P4 concise mode + cap interaction (no hard cap by default)");
{
  let seen;
  const c = makeCtx({ onOptions: (o) => (seen = o) });
  await summarizeBatch(batch, { ...baseCfg, conciseSummaryMode: true }, c.ctx);
  ok("concise ON does not set maxTokens by itself", !("maxTokens" in seen));
  const c2 = makeCtx({ onOptions: (o) => (seen = o) });
  await summarizeBatch(batch, { ...baseCfg, conciseSummaryMode: true, summarizerMaxOutputTokens: 6000 }, c2.ctx);
  ok("explicit cap still honoured when configured", seen.maxTokens === 6000);
}

console.log("P5 loadConfig boolean validation for conciseSummaryMode");
{
  const { execFileSync } = await import("node:child_process");
  const cases = [[true, true], [false, false], ["true", false], [1, false], [undefined, false]];
  for (const [input, expected] of cases) {
    const home = join(here, ".test-work", "tmp-home");
    const dir = join(home, ".pi", "agent", "context-prune");
    mkdirSync(dir, { recursive: true });
    const cfg = input === undefined ? { enabled: true } : { enabled: true, conciseSummaryMode: input };
    writeFileSync(join(dir, "settings.json"), JSON.stringify(cfg));
    const out = JSON.parse(execFileSync(process.execPath, [join(here, "loadcfg.mjs")], {
      env: { ...process.env, HOME: home },
    }).toString().trim());
    ok(`conciseSummaryMode=${JSON.stringify(input)} -> ${expected}`, out.concise === expected, `got ${out.concise}`);
  }
}

console.log("P6 no new dependencies / other-provider neutrality");
{
  const p = readFileSync(join(here, "..", "dist", "index.js"), "utf-8");
  const imports = (p.match(/from\s+"[^"]+"/g) || []).join("|");
  ok("import set unchanged (pi-coding-agent + pi-tui only)", !/zod|axios|node-fetch|undici/.test(imports));
  ok("prompt change is provider-agnostic text (no provider branching added)",
    (p.match(/conciseSummaryMode/g) || []).length >= 3 &&
    !/conciseSummaryMode[\s\S]{0,80}(provider|anthropic|openai)/i.test(p));
}


// ===================== Phase 3 (AI-INPUT-CONTEXT-OPT-028) =====================
console.log("C1 default mode -> A, byte-identical");
{
  ok("DEFAULT_CONFIG.summarizerPromptMode === 'default'", DEFAULT_CONFIG.summarizerPromptMode === "default",
    String(DEFAULT_CONFIG.summarizerPromptMode));
  ok("no config -> SYSTEM_PROMPT", summarizerSystemPrompt(undefined) === SYSTEM_PROMPT);
  ok("mode 'default' -> SYSTEM_PROMPT", summarizerSystemPrompt({ summarizerPromptMode: "default" }) === SYSTEM_PROMPT);
  ok("bogus mode -> SYSTEM_PROMPT", summarizerSystemPrompt({ summarizerPromptMode: "zzz" }) === SYSTEM_PROMPT);
  ok("SYSTEM_PROMPT text unchanged from original baseline",
    readFileSync(join(here, ".test-work", "backup", "index.js.orig"), "utf-8").includes(SYSTEM_PROMPT));
}

console.log("C2 mode 'faithful' -> SYSTEM_PROMPT_FAITHFUL (original structure preserved)");
{
  const c = summarizerSystemPrompt({ summarizerPromptMode: "faithful" });
  ok("faithful -> SYSTEM_PROMPT_FAITHFUL", c === SYSTEM_PROMPT_FAITHFUL);
  ok("C starts with A byte-for-byte (structure preserved)", c.startsWith(SYSTEM_PROMPT));
  ok("C keeps A's per-tool-call structure", /For each tool call provide:/.test(c) && /1-3 bullet points/.test(c));
  ok("C adds no consolidation mandate (that was B)", !/Merge repeated or similar calls/i.test(c));
  ok("C adds no hard output cap wording", !/max_tokens|maxTokens|token limit|character limit|fewest bullets/i.test(c));
  ok("C is a bounded addition (<600 chars) ", c.length - SYSTEM_PROMPT.length < 600, `+${c.length - SYSTEM_PROMPT.length}`);
}

console.log("C3 C covers all required fidelity clauses");
{
  const c = SYSTEM_PROMPT_FAITHFUL;
  const needs = [
    ["full commit SHA / HEAD / deployed / verified revisions", /commit SHAs and HEAD \/ deployed \/ verified revisions/i],
    ["never abbreviate/truncate", /never abbreviate, truncate, round or paraphrase/i],
    ["full hash not shortened", /write the full hash, never a shortened form/i],
    ["file paths / commands / error strings / exit codes", /file paths, important commands, error strings and exit codes/i],
    ["failure -> fix -> re-verification", /what failed, how it was fixed, and the result of re-verification/i],
    ["test counts", /test counts/i],
    ["decisions / unresolved / next actions", /decisions made, unresolved items, and next actions/i],
    ["do not list irrelevant identifiers", /Do not list identifiers that are not needed for the next steps/i],
  ];
  for (const [n, re] of needs) ok(`C clause: ${n}`, re.test(c));
}

console.log("C4 mode switching A/B/C + backwards compatibility");
{
  const A = summarizerSystemPrompt({ summarizerPromptMode: "default", conciseSummaryMode: false });
  const B = summarizerSystemPrompt({ summarizerPromptMode: "concise" });
  const C = summarizerSystemPrompt({ summarizerPromptMode: "faithful" });
  ok("A/B/C are three distinct prompts", A !== B && B !== C && A !== C);
  ok("B via summarizerPromptMode === B via conciseSummaryMode",
    B === summarizerSystemPrompt({ conciseSummaryMode: true }));
  ok("summarizerPromptMode wins over conciseSummaryMode",
    summarizerSystemPrompt({ summarizerPromptMode: "faithful", conciseSummaryMode: true }) === C);
  ok("conciseSummaryMode=false + default mode -> A",
    summarizerSystemPrompt({ conciseSummaryMode: false, summarizerPromptMode: "default" }) === A);
}

console.log("C5 real summarizeBatch sends the selected prompt");
{
  const probe = async (cfg, needle, label) => {
    let sent = null;
    const c2 = makeCtx();
    const orig = c2.ctx.modelRegistry.getProvider;
    c2.ctx.modelRegistry.getProvider = () => {
      const p = orig();
      return { stream: (m, ct, o) => { sent = JSON.stringify(ct); return p.stream(m, ct, o); } };
    };
    await summarizeBatch(batch, { ...baseCfg, ...cfg }, c2.ctx);
    ok(`${label}: correct prompt in request`, sent && sent.includes(needle));
  };
  await probe({ summarizerPromptMode: "default" }, "For each tool call provide", "A");
  await probe({ summarizerPromptMode: "concise" }, "Group by DISTINCT TARGET", "B");
  await probe({ summarizerPromptMode: "faithful" }, "never a shortened form", "C");
}

console.log("C6 loadConfig validation for summarizerPromptMode");
{
  const { execFileSync } = await import("node:child_process");
  const cases = [["concise", "concise"], ["faithful", "faithful"], ["default", "default"], ["bogus", "default"], [undefined, "default"], [1, "default"]];
  for (const [input, expected] of cases) {
    const home = join(here, ".test-work", "tmp-home");
    const dir = join(home, ".pi", "agent", "context-prune");
    mkdirSync(dir, { recursive: true });
    const cfg = input === undefined ? { enabled: true } : { enabled: true, summarizerPromptMode: input };
    writeFileSync(join(dir, "settings.json"), JSON.stringify(cfg));
    const out = JSON.parse(execFileSync(process.execPath, [join(here, "loadcfg.mjs")], {
      env: { ...process.env, HOME: home },
    }).toString().trim());
    ok(`summarizerPromptMode=${JSON.stringify(input)} -> ${expected}`, out.mode === expected, `got ${out.mode}`);
  }
}

console.log("C7 invariants unchanged by Phase 3");
{
  const p = readFileSync(join(here, "..", "dist", "index.js"), "utf-8");
  const base = readFileSync(join(here, ".test-work", "backup", "index.js.orig"), "utf-8");
  const types = (s) => (s.match(/CUSTOM_TYPE_(SUMMARY|FRONTIER|STATS|INDEX)\s*=\s*"[^"]+"/g) || []).join("|");
  ok("session entry types unchanged", types(p) === types(base));
  ok("refs footer appended structurally, unchanged",
    /formatSummaryToolCallRefs\(summaryRefs\)/.test(p) && /wrapSummaryForContext\(modelSummaryText \+ appendix\)/.test(p));
  ok("failure restore path unchanged", /restoreBatches\(batches\)/.test(p));
  ok("no maxTokens added by the prompt modes",
    (p.match(/maxTokens:\s*config\.summarizerMaxOutputTokens/g) || []).length === 1);
  const imports = (p.match(/from\s+"[^"]+"/g) || []).join("|");
  ok("import set unchanged (no new deps)", !/zod|axios|node-fetch|undici/.test(imports));
  ok("prompt selection is provider-agnostic (no provider branching)",
    (p.match(/summarizerPromptMode/g) || []).length >= 3 && !/summarizerPromptMode[\s\S]{0,80}(anthropic|openai|provider\()/i.test(p));
}
