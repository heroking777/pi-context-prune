// Phase57 — flush-time cwd must never be presented as call-time provenance.
import { expectedRecords, buildProtectedCore, verifyProtectedSummary, ok } from "./test-support.mjs";

const S1 = "1".repeat(40);
const tool = (cmd) => `Tool: bash({"command":${JSON.stringify(cmd)}})`;
const batchA = `${tool("pytest -q")}\nResult (ERROR): 3 failed; FAIL`;

// 1. A cwd present at flush never becomes a subject.
ok("cwd is not promoted to a subject", expectedRecords(`@batch-cwd /a\n${batchA}`).records.every((r) => r.u === true));
ok("a different cwd produces the same unresolved result",
  JSON.stringify(expectedRecords(`@batch-cwd /b\n${batchA}`).records) === JSON.stringify(expectedRecords(`@batch-cwd /a\n${batchA}`).records));
ok("no cwd at all is also unresolved", expectedRecords(batchA).records.every((r) => r.u === true));

// 2. Multiple calls in one batch: explicit paths still bind, others stay unresolved.
const mixed = [
  tool("git -C /srv/r1 rev-parse HEAD"), `Result (OK): ${S1}`,
  tool("pytest -q"), "Result (ERROR): 3 failed; FAIL",
].join("\n");
const mixedRecords = expectedRecords(`@batch-cwd /srv/ws\n${mixed}`).records;
ok("explicit -C still binds while the cwd is ignored",
  mixedRecords.some((r) => r.r === "HEAD" && r.s === "/srv/r1") && mixedRecords.some((r) => r.c === "st" && r.u === true));

// 3. Relative -C is not invented into an absolute repository.
ok("a relative -C is not promoted",
  expectedRecords(`${tool("git -C . rev-parse HEAD")}\nResult (OK): ${S1}`).records.find((r) => r.r === "HEAD").u === true);
ok("a relative ./repo path is not promoted",
  expectedRecords(`${tool("git -C ./repo rev-parse HEAD")}\nResult (OK): ${S1}`).records.find((r) => r.r === "HEAD").u === true);

// 4. Malformed or empty cwd headers are ignored.
for (const header of ["@batch-cwd", "@batch-cwd   ", "@batch-cwd not-a-path"]) {
  ok(`malformed provenance header is ignored: ${JSON.stringify(header)}`,
    expectedRecords(`${header}\n${batchA}`).records.every((r) => r.u === true));
}

// 5. Old index entries without provenance behave identically.
ok("legacy entry without provenance stays unresolved", expectedRecords(batchA).records.every((r) => r.u === true));

// 6. No false subject promotion from result text, and structure still verifies.
const resultPath = `${tool("pytest -q")}\nResult (ERROR): failure in /srv/elsewhere/file.py; FAIL`;
ok("a result-only path never becomes a subject", expectedRecords(resultPath).records.every((r) => r.s !== "/srv/elsewhere/file.py"));
const core = buildProtectedCore(`@batch-cwd /srv/ws\n${mixed}`);
ok("the core still verifies structurally", core.ok === true && verifyProtectedSummary(`@batch-cwd /srv/ws\n${mixed}`, core.core, { structuredOnly: true }).ok === true);
