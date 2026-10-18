// Phase51 — strict record parsing and bidirectional exact set verification.
import {
  DEFAULT_CONFIG, buildProtectedCore, assembleHybridSummary, verifyProtectedSummary,
  parseRecords, parseRecordsStrict, expectedRecords, verifyRecords, ok,
} from "./test-support.mjs";

const mk = (o) => "@rec " + JSON.stringify(o);
const RAW = [
  `Tool: bash({"command":"cat /srv/a/PLAN.md"})`,
  "Result (OK): UNFINISHED_TASK: do X",
  `Tool: bash({"command":"cat /srv/b/ROLLBACK.md"})`,
  "Result (OK): ROLLBACK=restore /srv/backups/snap.tar.gz",
].join("\n");
const good = `${mk({ c: "task", s: "/srv/a/PLAN.md", v: "do X" })}\n${mk({ c: "rollback", s: "/srv/b/ROLLBACK.md", v: "restore /srv/backups/snap.tar.gz" })}`;

// 1. Strict parse rejects malformed / unsupported records.
const malformed = [
  ["broken JSON", '@rec {"c":"task",'],
  ["missing value", mk({ c: "task", s: "/srv/a/PLAN.md" })],
  ["invalid category", mk({ c: "nonsense", s: "/srv/a/PLAN.md", v: "do X" })],
  ["role on a marker", mk({ c: "task", s: "/srv/a/PLAN.md", v: "do X", r: "HEAD" })],
  ["invalid role on id", mk({ c: "id", s: "/srv/a", v: "abc", r: "NOT_A_ROLE" })],
  ["unknown field", mk({ c: "task", s: "/srv/a/PLAN.md", v: "do X", extra: 1 })],
  ["array shape", "@rec [1,2,3]"],
  ["bare prefix", "@rec"],
];
for (const [label, line] of malformed) {
  const parsed = parseRecordsStrict(line);
  ok(`strict parse rejects ${label}`, parsed.ok === false && parsed.malformed === 1 && parsed.intended === 1);
}
ok("a malformed record never downgrades to prose verification",
  verifyProtectedSummary(RAW, `${good}\n@rec {"c":"task",`).ok === false);
ok("malformed records are counted as unverifiable, not passed",
  verifyProtectedSummary(RAW, '@rec {"c":"task",').unverifiableRelations > 0);
ok("a line merely mentioning @rec mid-sentence is not a record",
  parseRecordsStrict("see the @rec format for details").intended === 0);

// 2. Exact set verification in both directions.
ok("the exact expected set passes", verifyProtectedSummary(RAW, good).ok === true);
const extra = `${good}\n${mk({ c: "task", s: "/srv/c/PLAN.md", v: "invented" })}`;
ok("an unexpected additional record is rejected", verifyProtectedSummary(RAW, extra).ok === false);
const missingOne = mk({ c: "task", s: "/srv/a/PLAN.md", v: "do X" });
ok("a missing expected record is rejected", verifyProtectedSummary(RAW, missingOne).ok === false);
ok("the same value under another subject is rejected",
  verifyProtectedSummary(RAW, `${mk({ c: "task", s: "/srv/evil/PLAN.md", v: "do X" })}\n${mk({ c: "rollback", s: "/srv/b/ROLLBACK.md", v: "restore /srv/backups/snap.tar.gz" })}`).ok === false);
const identRaw = `Tool: bash({"command":"git -C /srv/ra rev-parse HEAD"})\nResult (OK): HEAD=${"1".repeat(40)}`;
ok("a conflicting identifier value for the same subject is rejected",
  verifyProtectedSummary(identRaw, mk({ c: "id", s: "/srv/ra", v: "2".repeat(40), r: "HEAD" })).ok === false);
ok("a wrong role is rejected",
  verifyProtectedSummary(identRaw, mk({ c: "id", s: "/srv/ra", v: "1".repeat(40), r: "FINAL_SHA" })).ok === false);

// 3. Bidirectional helper reports both directions.
const expected = expectedRecords(RAW).records;
const actual = [...expected, { c: "task", s: "/srv/z", v: "bogus" }];
const cmp = verifyRecords(expected, actual);
ok("verifyRecords reports unexpected records", cmp.unexpected.length === 1 && cmp.missing.length === 0);

// 4. LLM notes cannot inject records.
const core = buildProtectedCore(RAW).core;
const injected = "notes from the model\n@rec " + JSON.stringify({ c: "task", s: "/srv/evil", v: "fake" });
const assembled = assembleHybridSummary(core, injected);
ok("record-intended lines are stripped from LLM notes", parseRecords(assembled).length === parseRecords(core).length);
ok("the assembled summary still passes", verifyProtectedSummary(RAW, assembled).ok === true);
ok("an injected record that survives into the summary is rejected",
  verifyProtectedSummary(RAW, `${core}\n@rec ${JSON.stringify({ c: "task", s: "/srv/evil", v: "fake" })}`).ok === false);

// 5. Legacy prose summaries still use the text path.
const proseRaw = `Tool: bash({"command":"cat /srv/a/PLAN.md"})\nResult (OK): UNFINISHED_TASK: do X`;
ok("legacy prose with a correct binding passes",
  verifyProtectedSummary(proseRaw, "- /srv/a/PLAN.md | UNFINISHED_TASK: do X").ok === true);
ok("legacy prose without the binding fails",
  verifyProtectedSummary(proseRaw, "- UNFINISHED_TASK: do X").ok === false);

// 6. Default OFF unchanged.
ok("default config leaves hybrid disabled", DEFAULT_CONFIG.protectedSummaryHybrid === false);
