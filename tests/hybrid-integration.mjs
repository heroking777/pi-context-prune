// Phase56 — end-to-end: session entries → capture → serialize → records → core.
import {
  ToolCallIndexer, captureUnindexedBatchesFromSession, serializeBatchForSummarizer,
  expectedRecords, buildProtectedCore, verifyProtectedSummary, ok,
} from "./test-support.mjs";

const S1 = "1".repeat(40);
const S256 = "a".repeat(64);
function entries(calls) {
  const out = [{ type: "message", message: { role: "user", content: [{ type: "text", text: "task" }] } }];
  out.push({
    type: "message",
    message: { role: "assistant", content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, input: c.args })) },
  });
  for (const c of calls) {
    out.push({
      type: "message",
      message: { role: "toolResult", toolCallId: c.id, isError: c.isError === true, content: [{ type: "text", text: c.text }] },
    });
  }
  return out;
}
function capture(calls, cwd) {
  const indexer = new ToolCallIndexer();
  const batches = captureUnindexedBatchesFromSession(entries(calls), indexer, [], cwd);
  return { batches, serialized: batches[0] ? serializeBatchForSummarizer(batches[0]) : "" };
}

// 1. cwd is preserved by the real capture.
const one = capture([{ id: "t1", name: "bash", args: { command: "pytest -q" }, text: "3 failed; FAIL" }], "/srv/ws");
ok("capture preserves cwd", one.batches.length === 1 && one.batches[0].cwd === "/srv/ws");
const oneRecords = expectedRecords(`@batch-cwd ${one.batches[0].cwd}\n${one.serialized}`).records;
ok("a status record uses cwd provenance", oneRecords.some((r) => r.c === "st" && r.s === "/srv/ws" && r.p === "cwd"));

// 2. Bare HEAD through the real serializer (single and multi tool).
const single = capture([{ id: "t1", name: "bash", args: { command: "git rev-parse HEAD" }, text: S1 }], "/srv/ws");
const singleHead = expectedRecords(`@batch-cwd /srv/ws\n${single.serialized}`).records.find((r) => r.r === "HEAD");
ok("single-tool bare HEAD is captured", singleHead && singleHead.v === S1);
const multi = capture([
  { id: "t1", name: "bash", args: { command: "git -C /srv/r2 rev-parse HEAD" }, text: S256 },
  { id: "t2", name: "bash", args: { command: "pytest -q" }, text: "3 failed; FAIL" },
], "/srv/ws");
const multiRecords = expectedRecords(`@batch-cwd /srv/ws\n${multi.serialized}`).records;
ok("multi-tool batch still captures the bare HEAD", multiRecords.some((r) => r.r === "HEAD" && r.s === "/srv/r2" && r.v === S256));
ok("the multi-tool batch captures both records", multiRecords.some((r) => r.c === "st"));

// 3. Explicit -C wins over cwd; failed commands and history are not promoted.
const explicit = capture([{ id: "t1", name: "bash", args: { command: "git -C /srv/repo rev-parse HEAD" }, text: S1 }], "/srv/ws");
ok("explicit -C wins over cwd", expectedRecords(`@batch-cwd /srv/ws\n${explicit.serialized}`).records.find((r) => r.r === "HEAD").s === "/srv/repo");
const failed = capture([{ id: "t1", name: "bash", args: { command: "git rev-parse HEAD" }, text: S1, isError: true }], "/srv/ws");
ok("a failed command is not promoted", expectedRecords(`@batch-cwd /srv/ws\n${failed.serialized}`).records.every((r) => r.r !== "HEAD"));
const history = capture([{ id: "t1", name: "bash", args: { command: "git log --oneline" }, text: S1 }], "/srv/ws");
ok("git log is not promoted", expectedRecords(`@batch-cwd /srv/ws\n${history.serialized}`).records.every((r) => r.r !== "HEAD"));

// 4. Legacy capture (no cwd) keeps unresolved provenance.
const legacy = capture([{ id: "t1", name: "bash", args: { command: "pytest -q" }, text: "3 failed; FAIL" }], undefined);
ok("legacy capture has no cwd", legacy.batches[0].cwd === undefined);
ok("legacy records stay explicitly unresolved", expectedRecords(legacy.serialized).records.some((r) => r.c === "st" && r.u === true));

// 5. Paths only in result text never become the subject.
const resultPath = capture([{ id: "t1", name: "bash", args: { command: "pytest -q" }, text: "failure in /srv/elsewhere/file.py" }], "/srv/ws");
const rp = expectedRecords(`@batch-cwd /srv/ws\n${resultPath.serialized}`).records;
ok("a path in result text is not promoted to subject", rp.every((r) => r.s !== "/srv/elsewhere/file.py"));

// 6. The full core verifies through the real pipeline.
const coreText = `@batch-cwd /srv/ws\n${multi.serialized}`;
const core = buildProtectedCore(coreText);
ok("pipeline core verifies", core.ok === true && verifyProtectedSummary(coreText, core.core, { structuredOnly: true }).ok === true);
