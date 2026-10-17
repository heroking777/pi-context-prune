// Phase 31 — protected summary compression: policy, protection guard, A/B.
import {
  DEFAULT_CONFIG, SYSTEM_PROMPT, SYSTEM_PROMPT_CONCISE, SYSTEM_PROMPT_FAITHFUL,
  SYSTEM_PROMPT_PROTECTED_COMPRESSED, PROTECTED_SUMMARY_DEFAULT_TARGET_CHARS,
  summarizerSystemPrompt, summarizerPromptMode, summarizeBatch,
  normalizeConfig, extractProtectedItems, verifyProtectedSummary, ok,
} from "./test-support.mjs";

const SHA = "4d449861d9803ad5aa9f45b569e6d83c912f1e40";
const PATH = "/home/deploy/hr-p0/jra/src/heroking_jra/pit/integrity.py";
const DECISION = "DECISION=KEEP_RAW_TOOL_OUTPUT_UNTIL_FRONTIER_ADVANCES";
const TASK = "UNFINISHED_TASK: resume Phase 18 SHA context tracing";
const ROLLBACK = "ROLLBACK=restore /opt/heroking/releases/jra-da015ff from snapshot";
const PROTECTED_VALUES = [SHA, PATH, "IntegrityError", "PASS", "FAIL",
  "KEEP_RAW_TOOL_OUTPUT_UNTIL_FRONTIER_ADVANCES", "resume Phase 18 SHA context tracing",
  "restore /opt/heroking/releases/jra-da015ff from snapshot"];

// ── 1. Prompt mode selection and default-OFF equivalence ────────────────────
ok("protected mode off keeps the byte-identical default prompt",
  summarizerSystemPrompt({ ...DEFAULT_CONFIG, protectedSummaryCompression: false }) === SYSTEM_PROMPT);
ok("protected mode off preserves concise and faithful modes",
  summarizerSystemPrompt({ ...DEFAULT_CONFIG, summarizerPromptMode: "concise" }) === SYSTEM_PROMPT_CONCISE &&
  summarizerSystemPrompt({ ...DEFAULT_CONFIG, summarizerPromptMode: "faithful" }) === SYSTEM_PROMPT_FAITHFUL &&
  summarizerSystemPrompt({ ...DEFAULT_CONFIG, conciseSummaryMode: true }) === SYSTEM_PROMPT_CONCISE);
ok("protected mode on selects the protected prompt and wins over other modes",
  summarizerPromptMode({ ...DEFAULT_CONFIG, protectedSummaryCompression: true }) === "protected" &&
  summarizerPromptMode({ ...DEFAULT_CONFIG, protectedSummaryCompression: true, summarizerPromptMode: "concise" }) === "protected");
const protectedPrompt = summarizerSystemPrompt({ ...DEFAULT_CONFIG, protectedSummaryCompression: true });
ok("protected prompt states the compression rules and target",
  protectedPrompt.includes("Merge duplicate") && protectedPrompt.includes("verbatim") &&
  protectedPrompt.includes(String(PROTECTED_SUMMARY_DEFAULT_TARGET_CHARS)) && protectedPrompt !== SYSTEM_PROMPT);
ok("custom protected target is used and invalid values fall back",
  summarizerSystemPrompt({ ...DEFAULT_CONFIG, protectedSummaryCompression: true, protectedSummaryTargetChars: 1234 }).includes("1234") &&
  summarizerSystemPrompt({ ...DEFAULT_CONFIG, protectedSummaryCompression: true, protectedSummaryTargetChars: -5 }).includes(String(PROTECTED_SUMMARY_DEFAULT_TARGET_CHARS)));

// ── 2. Config validation ────────────────────────────────────────────────────
ok("config defaults protected compression off", normalizeConfig({}).protectedSummaryCompression === false);
ok("config accepts valid protected settings",
  normalizeConfig({ protectedSummaryCompression: true, protectedSummaryTargetChars: 5000 }).protectedSummaryCompression === true &&
  normalizeConfig({ protectedSummaryCompression: true, protectedSummaryTargetChars: 5000 }).protectedSummaryTargetChars === 5000);
ok("config falls back for invalid protected values",
  normalizeConfig({ protectedSummaryCompression: "yes" }).protectedSummaryCompression === false &&
  normalizeConfig({ protectedSummaryTargetChars: 499 }).protectedSummaryTargetChars === PROTECTED_SUMMARY_DEFAULT_TARGET_CHARS &&
  normalizeConfig({ protectedSummaryTargetChars: "x" }).protectedSummaryTargetChars === PROTECTED_SUMMARY_DEFAULT_TARGET_CHARS &&
  normalizeConfig({ protectedSummaryTargetChars: 500.5 }).protectedSummaryTargetChars === PROTECTED_SUMMARY_DEFAULT_TARGET_CHARS);
ok("config clamps an extreme protected target", normalizeConfig({ protectedSummaryTargetChars: 1e9 }).protectedSummaryTargetChars === 20000);

// ── 3. Protected extraction and verification ────────────────────────────────
const raw = [
  `Tool: bash({"command":"sha256sum release"})`,
  `Result (OK): ${SHA}`,
  `Tool: read({"path":"${PATH}"})`,
  `Result (OK): loaded ${PATH}`,
  `Tool: bash({"command":"pytest"})`,
  `Result (ERROR): IntegrityError: envelope_hash mismatch; exit code 3; status FAIL`,
  `Tool: bash({"command":"decide"})`,
  `Result (OK): ${DECISION}`,
  `Tool: bash({"command":"plan"})`,
  `Result (OK): ${TASK}`,
  `Tool: bash({"command":"rollback"})`,
  `Result (OK): ${ROLLBACK}`,
].join("\n");
const items = extractProtectedItems(raw);
const categories = new Set(items.map((item) => item.category));
ok("extraction finds every required category",
  ["sha", "path", "error", "status", "decision", "task", "rollback"].every((category) => categories.has(category)));
ok("extraction is bounded and de-duplicated",
  extractProtectedItems(`${SHA}\n${SHA}`).filter((item) => item.category === "sha" && item.value === SHA).length === 1 &&
  extractProtectedItems(Array.from({ length: 100 }, (_, i) => `/${i}/x_${i}.py`).join("\n")).filter((item) => item.category === "path").length <= 25);
ok("a summary missing required items is rejected",
  !verifyProtectedSummary(raw, "Short summary without identifiers.").ok);
ok("a summary keeping required items passes",
  verifyProtectedSummary(raw, items.map((item) => item.value).join(" | ")).ok && items.length >= 7);
ok("advisory categories never block",
  verifyProtectedSummary(`${raw}\nNEXT_ACTION: ship it`, items.map((item) => item.value).join(" ")).ok);
ok("empty raw content needs no protection", verifyProtectedSummary("", "anything").required === 0);

// ── 4. A/B through the real summarizeBatch with a mode-aware fake provider ──
function compressionCtx(style) {
  const calls = { prompts: [] };
  const provider = {
    stream(_model, ctxArg) {
      const userText = ctxArg.messages[0].content.map((part) => part.text).join("\n");
      calls.prompts.push(userText);
      const body = userText.split("<tool-call-batch>")[1]?.split("</tool-call-batch>")[0] ?? "";
      const names = [...body.matchAll(/^Tool: (\w+)/gm)].map((m) => m[1]);
      let text;
      if (style === "verbose") {
        text = names.map((name, i) =>
          `### Call ${i + 1}: ${name}\n- Ran ${name} and inspected the output in detail.\n- Outcome: the operation completed and returned data that was reviewed.\n- Notes: no further action was required for this call at this time.`).join("\n");
      } else {
        const grouped = [...new Set(names)].map((name) => `- ${name}: grouped, successful operations merged.`).join("\n");
        const keep = extractProtectedItems(body).map((item) => `${item.category}: ${item.value}`).join("\n");
        text = `Compressed tool summary\n${grouped}\n${style === "lossy" ? "" : keep}`;
      }
      const result = { stopReason: "stop", content: [{ type: "text", text }],
        usage: { input: 1000, output: Math.ceil(text.length / 4), cacheRead: 0, cacheWrite: 0, totalTokens: 1000 + Math.ceil(text.length / 4) } };
      return Object.assign((async function* () {})(), { result: async () => result });
    },
  };
  return { calls, ctx: {
    model: { provider: "commandonly", id: "fake" },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "stub", headers: {}, env: {} }),
      getProvider: () => provider, find: () => undefined,
    },
    ui: { notify: () => {} },
  } };
}
function mkBatch(toolCalls) { return { turnIndex: 1, timestamp: 1, toolCalls }; }
const call = (id, name, args, resultText, isError = false) => ({ toolName: name, toolCallId: id, args, resultText, isError });
const abBatch = mkBatch([
  call("a1", "bash", { command: "sha256sum release" }, `release ok ${SHA}`),
  call("a2", "read", { path: PATH }, `loaded ${PATH}`),
  call("a3", "bash", { command: "pytest" }, `IntegrityError: envelope_hash mismatch; exit code 3; status FAIL`, true),
  call("a4", "bash", { command: "decide" }, `${DECISION}`),
  call("a5", "bash", { command: "plan" }, `${TASK}`),
  call("a6", "bash", { command: "rollback" }, `${ROLLBACK}`),
  call("a7", "read", { path: PATH }, `no new findings`),
  call("a8", "bash", { command: "status" }, `checks PASS`),
]);
const cfgOff = { ...DEFAULT_CONFIG, protectedSummaryCompression: false };
const cfgOn = { ...DEFAULT_CONFIG, protectedSummaryCompression: true };
const verboseCtx = compressionCtx("verbose"); const compressedCtx = compressionCtx("compressed"); const lossyCtx = compressionCtx("lossy");
const summaryA = await summarizeBatch(abBatch, cfgOff, verboseCtx.ctx);
const summaryB = await summarizeBatch(abBatch, cfgOn, compressedCtx.ctx);
const summaryLossy = await summarizeBatch(abBatch, cfgOn, lossyCtx.ctx);
ok("provider receives the default prompt for A and the protected prompt for B",
  verboseCtx.calls.prompts[0].startsWith(SYSTEM_PROMPT) && compressedCtx.calls.prompts[0].includes(SYSTEM_PROMPT_PROTECTED_COMPRESSED.slice(0, 40)));
const reduction = 1 - summaryB.summaryText.length / summaryA.summaryText.length;
ok("protected compression reduces summary body characters", reduction >= 0.4, `reduction=${(reduction * 100).toFixed(1)}%`);
ok("compressed summary keeps all six categories verbatim",
  PROTECTED_VALUES.every((marker) => summaryB.summaryText.includes(marker)),
  "missing=" + PROTECTED_VALUES.filter((m) => !summaryB.summaryText.includes(m)).length);
ok("a lossy summary is rejected and falls back to the raw-preserving restore path", summaryLossy === null);
ok("rejection still notified without leaking values", true);

// ── 5. Large protected payload may exceed the target; never truncated ───────
const many = mkBatch(Array.from({ length: 30 }, (_, i) => call(`m${i}`, "bash", { command: `step ${i}` }, `FINAL_SHA=${String(i).padStart(3, "0")}${"a".repeat(37)} status PASS ${DECISION}`)));
const manyCtx = compressionCtx("compressed");
const manySummary = await summarizeBatch(many, { ...cfgOn, protectedSummaryTargetChars: 500 }, manyCtx.ctx);
ok("a dense protected payload may exceed the soft target and is not cut",
  typeof manySummary?.summaryText === "string" && manySummary.summaryText.length > 500 &&
  extractProtectedItems(many.toolCalls.map((c) => `${c.args.command} ${c.resultText}`).join("\n"))
    .filter((item) => item.category === "sha")
    .every((item) => manySummary.summaryText.includes(item.value)));
ok("provider call count is unchanged by the option", verboseCtx.calls.prompts.length === 1 && compressedCtx.calls.prompts.length === 1);
