// Phase55 — batch provenance (cwd) and authoritative bare-SHA HEAD capture.
import { buildProtectedCore, expectedRecords, parseRecords, verifyProtectedSummary, ok } from "./test-support.mjs";

const S1 = "1".repeat(40), S256 = "a".repeat(64);
const withCwd = (cwd, body) => `@batch-cwd ${cwd}\n${body}`;
const tool = (cmd) => `Tool: bash({"command":${JSON.stringify(cmd)}})`;

// 1. cwd provenance: known but not a repository binding.
const noPath = withCwd("/srv/project", `${tool("pytest -q")}\nResult (ERROR): 3 failed; FAIL`);
const cwdRecord = expectedRecords(noPath).records.find((r) => r.c === "st");
ok("cwd becomes a known provenance subject", cwdRecord.s === "/srv/project" && cwdRecord.p === "cwd" && cwdRecord.u === undefined);
ok("cwd records round-trip through the parser", parseRecords(buildProtectedCore(noPath).core).every((r) => r.p === "cwd"));
const noCwd = `${tool("pytest -q")}\nResult (ERROR): 3 failed; FAIL`;
ok("without cwd the subject stays explicitly unknown", expectedRecords(noCwd).records.find((r) => r.c === "st").u === true);
ok("the @batch-cwd line is excluded from the LLM input", !buildProtectedCore(noPath).notesInput.includes("@batch-cwd"));

// 2. Explicit path wins over cwd.
const explicit = withCwd("/srv/project", `${tool("git -C /srv/other status")}\nResult (OK): clean`);
ok("an explicit -C path beats cwd", expectedRecords(explicit).records.length === 0 || expectedRecords(explicit).records.every((r) => r.s === "/srv/other"));

// 3. Multiple repositories / multiple tool calls in one batch.
const multi = [
  tool("git -C /srv/r1 rev-parse HEAD"), `Result (OK): ${S1}`,
  tool("git -C /srv/r2 rev-parse HEAD"), `Result (OK): ${"2".repeat(40)}`,
].join("\n");
const multiHeads = expectedRecords(multi).records.filter((r) => r.r === "HEAD");
ok("two repositories yield two bound HEAD records",
  multiHeads.length === 2 && multiHeads.some((r) => r.s === "/srv/r1") && multiHeads.some((r) => r.s === "/srv/r2"));

// 4. Bare SHA from authoritative commands.
for (const [label, sha] of [["SHA-1", S1], ["SHA-256", S256]]) {
  const raw = `${tool("git -C /srv/r rev-parse HEAD")}\nResult (OK): ${sha}`;
  const head = expectedRecords(raw).records.find((r) => r.r === "HEAD");
  ok(`${label} from rev-parse HEAD is promoted`, head && head.v === sha && head.s === "/srv/r");
}
ok("a HEAD SHA without a repo uses cwd provenance",
  expectedRecords(withCwd("/srv/ws", `${tool("git rev-parse HEAD")}\nResult (OK): ${S1}`)).records.find((r) => r.r === "HEAD").p === "cwd");
ok("a HEAD SHA without repo or cwd stays unresolved",
  expectedRecords(`${tool("git rev-parse HEAD")}\nResult (OK): ${S1}`).records.find((r) => r.r === "HEAD").u === true);

// 5. Never promoted from non-authoritative sources.
const notPromoted = [
  ["git log", `${tool("git -C /srv/r log --oneline")}\nResult (OK): ${S1}`],
  ["git show", `${tool("git -C /srv/r show HEAD")}\nResult (OK): ${S1}`],
  ["mixed output", `${tool("git -C /srv/r rev-parse HEAD")}\nResult (OK): ${S1}\nmore text`],
  ["failed command", `${tool("git -C /srv/r rev-parse HEAD")}\nResult (ERROR): ${S1}`],
  ["non-sha output", `${tool("git -C /srv/r rev-parse HEAD")}\nResult (OK): refs/heads/main`],
];
for (const [label, raw] of notPromoted) {
  ok(`${label} does not produce an active HEAD`, expectedRecords(raw).records.every((r) => r.r !== "HEAD"));
}
const labelledHistorical = `${tool("git -C /srv/r log --oneline")}\nResult (OK): HEAD=${S1}`;
ok("a labelled HEAD from history is not promoted", expectedRecords(labelledHistorical).records.every((r) => r.r !== "HEAD"));

// 6. Conflicting authoritative values for one subject fail closed.
const conflict = [tool("git -C /srv/r rev-parse HEAD"), `Result (OK): ${S1}`, tool("git -C /srv/r rev-parse HEAD"), `Result (OK): ${"3".repeat(40)}`].join("\n");
ok("contradictory authoritative HEAD values fail closed", buildProtectedCore(conflict).ok === false);

// 7. Legacy batch compatibility and no invented subject from result text.
const legacy = `Tool: bash({"command":"pytest -q"})\nResult (ERROR): failing in /srv/elsewhere/file.py\nFAIL`;
const legacyRecords = expectedRecords(legacy).records.filter((r) => r.c === "st");
ok("legacy batches still parse", buildProtectedCore(legacy).ok === true);
ok("a path in the result text does not become the subject", legacyRecords.every((r) => r.s === "unknown" && r.u === true));

// 8. Structural verification still holds with provenance.
const raw = withCwd("/srv/ws", `${tool("plan")}\nResult (OK): UNFINISHED_TASK: do X`);
const core = buildProtectedCore(raw);
ok("provenance core verifies structurally", verifyProtectedSummary(raw, core.core, { structuredOnly: true }).ok === true);
