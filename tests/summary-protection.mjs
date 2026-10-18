// Phase 31 — protected summary compression: policy, protection guard, A/B.
import {
  DEFAULT_CONFIG, SYSTEM_PROMPT, SYSTEM_PROMPT_CONCISE, SYSTEM_PROMPT_FAITHFUL,
  SYSTEM_PROMPT_PROTECTED_COMPRESSED, PROTECTED_SUMMARY_DEFAULT_TARGET_CHARS,
  summarizerSystemPrompt, summarizerPromptMode, summarizeBatch,
  normalizeConfig, extractProtectedItems, verifyProtectedSummary, PROTECTION_FAILURE_MARKER, ok,
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
  protectedPrompt.includes("Merge") && protectedPrompt.includes("Keep verbatim") &&
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
  `Result (OK): FINAL_SHA=${SHA}`,
  `Tool: read({"path":"${PATH}"})`,
  `Result (OK): loaded ${PATH}`,
  `Tool: bash({"command":"pytest"})`,
  `Result (ERROR): IntegrityError: envelope_hash mismatch; jra-gate: FAIL`,
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
  ["final-sha", "sha", "path", "error", "status", "decision", "task", "rollback"].every((category) => categories.has(category)));
ok("extraction is bounded and de-duplicated",
  extractProtectedItems(`${SHA}\n${SHA}`).filter((item) => item.category === "sha" && item.value === SHA).length === 1 &&
  extractProtectedItems(Array.from({ length: 100 }, (_, i) => `/${i}/x_${i}.py`).join("\n")).filter((item) => item.category === "path").length <= 25);
const passingSummary = `${items.map((item) => item.value).join(" | ")} | jra-gate: FAIL | FINAL_SHA=${SHA}`;
ok("a summary keeping required items passes",
  verifyProtectedSummary(raw, passingSummary).ok && items.length >= 7);
const rawWithNext = `${raw}\nNEXT_ACTION: ship it`;
const nextItems = extractProtectedItems(rawWithNext);
ok("advisory categories never block",
  verifyProtectedSummary(rawWithNext, `${nextItems.map((item) => item.value).join(" ")} jra-gate: FAIL FINAL_SHA=${SHA}`).ok);
ok("empty raw content needs no protection", verifyProtectedSummary("", "anything").required === 0);

// Tier separation: current state is enforced; historical detail is retrievable.
const tieredRaw = [
  `FINAL_SHA=${SHA}`,
  `Result (OK): inspected ${PATH}`,
  "jra-gate: FAIL (envelope mismatch)",
  DECISION, TASK, ROLLBACK,
  Array.from({ length: 40 }, (_, i) => `/hist/run_${i}/artifact_${i}.py`).join("\n"),
].join("\n");
const tiered = extractProtectedItems(tieredRaw);
const tierOf = (category) => tiered.filter((item) => item.category === category).map((item) => item.tier);
ok("current working state is tier 1", tierOf("active-sha").every((t) => t === 1) && tierOf("decision").every((t) => t === 1) && tierOf("task")[0] === 1 && tierOf("rollback")[0] === 1 && tierOf("status")[0] === 1);
ok("historical detail is tier 2", tierOf("sha").every((t) => t === 2) && tierOf("path").every((t) => t === 2));
const tier1Summary = [`FINAL_SHA=${SHA}`, "jra-gate: FAIL", DECISION, TASK, ROLLBACK].join(" | ");
const tieredVerdict = verifyProtectedSummary(tieredRaw, tier1Summary);
ok("omitting tier-2 detail does not block a summary", tieredVerdict.ok && tieredVerdict.tier2Omitted >= 25);
ok("tier-2 omission is reported, not hidden", tieredVerdict.tier2Count >= 25 && tieredVerdict.tier2Omitted > 0);
ok("omitting the active SHA is rejected",
  verifyProtectedSummary(tieredRaw, [`FINAL_SHA=${"b".repeat(40)}`, "jra-gate: FAIL", DECISION, TASK, ROLLBACK].join(" | ")).ok === false);
ok("an old SHA cannot stand in for the active SHA",
  verifyProtectedSummary(tieredRaw, [`FINAL_SHA=${"b".repeat(40)}`, "jra-gate: FAIL", DECISION, TASK, ROLLBACK].join(" | "))
    .missing.some((item) => item.category === "final-sha"));
ok("a FAIL must keep its subject (semantic relation)",
  verifyProtectedSummary(tieredRaw, [`FINAL_SHA=${SHA}`, "FAIL", DECISION, TASK, ROLLBACK].join(" | ")).ok === false &&
  verifyProtectedSummary(tieredRaw, tier1Summary).ok === true);
ok("unstructured prose is not auto-classified", verifyProtectedSummary("the run went badly at some point", "a short note").ok === true);

// Phase37/38 — identifier roles are distinct.
ok("a single labelled SHA resolves per role",
  extractProtectedItems(`FINAL_SHA=${SHA}`).some((item) => item.category === "final-sha" && item.value === SHA));
ok("BASE_SHA is a comparison origin, never a current value",
  !extractProtectedItems("BASE_SHA=" + SHA).some((item) => item.tier === 1) &&
  verifyProtectedSummary("BASE_SHA=" + SHA, "no identifiers").ok === true);
const A = "a".repeat(40), B = "b".repeat(40);
ok("GitHub HEAD and VPS DEPLOYED_SHA may differ and are both required",
  verifyProtectedSummary(`HEAD=${A}\nDEPLOYED_SHA=${B}`, `HEAD=${A} DEPLOYED_SHA=${B}`).ok === true &&
  verifyProtectedSummary(`HEAD=${A}\nDEPLOYED_SHA=${B}`, `HEAD=${A}`).ok === false);
ok("BASE_SHA and FINAL_SHA may differ without conflict",
  verifyProtectedSummary(`BASE_SHA=${A}\nFINAL_SHA=${B}`, `FINAL_SHA=${B}`).ok === true);
ok("same role with contradictory values fails closed",
  verifyProtectedSummary(`FINAL_SHA=${A}\nFINAL_SHA=${B}`, `FINAL_SHA=${A}`).ok === false &&
  verifyProtectedSummary(`FINAL_SHA=${A}\nFINAL_SHA=${B}`, `FINAL_SHA=${A}`).ambiguousActive.includes("final-sha"));
ok("build and release are separate roles and both required",
  extractProtectedItems("BUILD_ID=build-1234\nRELEASE=rel-9").filter((item) => item.tier === 1 && (item.category === "build-id" || item.category === "release")).length === 2 &&
  verifyProtectedSummary("BUILD_ID=build-1234\nRELEASE=rel-9", "BUILD_ID=build-1234").ok === false &&
  verifyProtectedSummary("BUILD_ID=build-1234\nRELEASE=rel-9", "BUILD_ID=build-1234 RELEASE=rel-9").ok === true);
// Phase39 — identifier subject binding across multiple repositories.
const X = "1".repeat(40), Y = "2".repeat(40);
const repoRaw = [
  `Tool: bash({"command":"git -C /srv/repo-a rev-parse HEAD"})`,
  `Result (OK): HEAD=${X}`,
  `Tool: bash({"command":"git -C /srv/repo-b rev-parse HEAD"})`,
  `Result (OK): HEAD=${Y}`,
].join("\n");
ok("per-repo HEAD values are bound to their own subject",
  verifyProtectedSummary(repoRaw, `/srv/repo-a HEAD=${X} /srv/repo-b HEAD=${Y}`).ok === true);
ok("a cross-repo HEAD swap is rejected even though both role/value pairs exist",
  verifyProtectedSummary(repoRaw, `/srv/repo-a HEAD=${Y} /srv/repo-b HEAD=${X}`).ok === false &&
  verifyProtectedSummary(repoRaw, `/srv/repo-a HEAD=${Y} /srv/repo-b HEAD=${X}`).identifierContradictions.length > 0);
ok("a role/value without its subject is unresolved when several subjects exist",
  verifyProtectedSummary(repoRaw, `HEAD=${X} HEAD=${Y}`).ok === false &&
  (verifyProtectedSummary(repoRaw, `HEAD=${X} HEAD=${Y}`).identifierUnresolved.length + verifyProtectedSummary(repoRaw, `HEAD=${X} HEAD=${Y}`).identifierContradictions.length) > 0);
const sameShaRaw = [
  `Tool: bash({"command":"git -C /srv/repo-a rev-parse HEAD"})`,
  `Result (OK): HEAD=${X}`,
  `Tool: bash({"command":"git -C /srv/repo-b rev-parse HEAD"})`,
  `Result (OK): HEAD=${X}`,
].join("\n");
ok("the same value on two subjects still requires subject binding",
  verifyProtectedSummary(sameShaRaw, `/srv/repo-a HEAD=${X} /srv/repo-b HEAD=${X}`).ok === true);
ok("an unknown subject with a single value needs no binding",
  verifyProtectedSummary(`HEAD=${X}`, `HEAD=${X}`).ok === true &&
  verifyProtectedSummary(`HEAD=${X}`, `HEAD=${Y}`).ok === false);

ok("swapping the GitHub and VPS identifiers is rejected",
  verifyProtectedSummary(`HEAD=${A}\nDEPLOYED_SHA=${B}`, `HEAD=${B} DEPLOYED_SHA=${A}`).ok === false &&
  verifyProtectedSummary(`HEAD=${A}\nDEPLOYED_SHA=${B}`, `HEAD=${B} DEPLOYED_SHA=${A}`).identifierContradictions.length > 0);

// Phase37 — status/subject relations cannot be swapped between subjects.
const swappedRaw = "JRA=FAIL\nBoat=PASS";
ok("swapped statuses between subjects are rejected",
  verifyProtectedSummary(swappedRaw, "JRA: PASS\nBoat: FAIL").ok === false);
ok("the same statuses on the right subjects pass",
  verifyProtectedSummary(swappedRaw, "JRA: FAIL\nBoat: PASS").ok === true);
const fixRaw = "JRA: FAIL\nJRA: PASS";
ok("a FAIL that is later fixed must still be represented",
  verifyProtectedSummary(fixRaw, "JRA: PASS").ok === false &&
  verifyProtectedSummary(fixRaw, "JRA: FAIL; then JRA: PASS").ok === true);
ok("a bare status word without a machine-readable subject is never a pass",
  verifyProtectedSummary("everything collapsed with FAIL at the end", "FAIL").ok === false &&
  verifyProtectedSummary("everything collapsed with FAIL at the end", "FAIL").unverifiableRelations > 0);

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
        const pairs = [...body.matchAll(/([A-Za-z0-9_.:/-]{2,40})\s*[:=]\s*(FAIL|HOLD|BLOCKED)\b/gi)].map((m) => `${m[1]}: ${m[2]}`);
        const ids = [...body.matchAll(/\b(FINAL_SHA|BASE_SHA|CURRENT_SHA|ACTIVE_SHA|DEPLOYED_SHA|HEAD|BUILD_ID|RELEASE)\s*[=:]\s*([A-Za-z0-9._/-]{2,})/gi)].map((m) => `${m[1].toUpperCase()}=${m[2]}`);
        text = `Compressed tool summary\n${grouped}\n${style === "lossy" ? "" : keep + "\n" + pairs.join("\n") + "\n" + ids.join("\n")}`;
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
    sessionManager: { getSessionId: () => "ab-session" },
  } };
}
function mkBatch(toolCalls) { return { turnIndex: 1, timestamp: 1, toolCalls }; }
const call = (id, name, args, resultText, isError = false) => ({ toolName: name, toolCallId: id, args, resultText, isError });
const abBatch = mkBatch([
  call("a1", "bash", { command: "sha256sum release" }, `release ok FINAL_SHA=${SHA}`),
  call("a2", "read", { path: PATH }, `loaded ${PATH}`),
  call("a3", "bash", { command: "pytest" }, `IntegrityError: envelope_hash mismatch; jra-gate: FAIL`, true),
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
ok("a lossy summary is rejected with a distinguishable protection result",
  summaryLossy !== null && summaryLossy[PROTECTION_FAILURE_MARKER] === true && summaryLossy.reason === "missing" && summaryLossy.missingCount > 0);
ok("rejection still notified without leaking values", true);

// ── 5. Large protected payload may exceed the target; never truncated ───────
const many = mkBatch(Array.from({ length: 20 }, (_, i) => call(`m${i}`, "bash", { command: `step ${i}` }, `FINAL_SHA=${SHA} DECISION=policy-${i} ${TASK}`)));
const manyCtx = compressionCtx("compressed");
const manySummary = await summarizeBatch(many, { ...cfgOn, protectedSummaryTargetChars: 500 }, manyCtx.ctx);
ok("a dense protected payload may exceed the soft target and is not cut",
  typeof manySummary?.summaryText === "string" && manySummary.summaryText.length > 500 &&
  extractProtectedItems(many.toolCalls.map((c) => `${c.args.command} ${c.resultText}`).join("\n"))
    .filter((item) => item.category === "sha")
    .every((item) => manySummary.summaryText.includes(item.value)));
ok("provider call count is unchanged by the option", verboseCtx.calls.prompts.length === 1 && compressedCtx.calls.prompts.length === 1);
