import { createHash } from "node:crypto";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { ToolCallIndexer, ok, registerQueryTool } from "./test-support.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const indexer = new ToolCallIndexer();
const api = { registerTool(tool) { this.tool = tool; } };
registerQueryTool(api, indexer);

function indexRaw(id, raw) {
  indexer.indexPersistedRecord({
    toolCallId: id,
    toolName: "bash",
    args: { command: "fixture" },
    resultText: raw,
    isError: false,
    turnIndex: 1,
    timestamp: 1,
    __contextPruneRawOnly: true,
    __contextPruneRawSha256: sha(Buffer.from(raw)),
    __contextPruneRawByteLength: Buffer.byteLength(raw),
  });
}

function parsePage(text) {
  const bodyStart = text.indexOf("\n\n");
  if (bodyStart < 0) return { body: "", nextByte: undefined, invalid: true };
  let body = text.slice(bodyStart + 2);
  const marker = /\n\[Raw page: bytes (\d+)-(\d+) of (\d+); continue with startByte=(\d+), startLine=(\d+)\.\]$/.exec(body);
  if (!marker) return { body, nextByte: undefined, invalid: false };
  const rawPage = body.slice(0, marker.index);
  return { body: rawPage, nextByte: Number(marker[4]), invalid: false };
}

async function reconstruct(id, raw, lineLimit) {
  const ref = indexer.getSearchRef(id);
  const pages = [];
  let cursor = 0;
  let first = true;
  for (let count = 0; count < 100; count++) {
    const result = await api.tool.execute("pager-test", {
      toolCallIds: [ref], ...(first ? { startLine: 1 } : { startByte: cursor }), lineLimit,
    });
    first = false;
    const page = parsePage(result.content[0].text);
    const bytes = Buffer.from(page.body, "utf8");
    if (page.invalid || bytes.length > DEFAULT_MAX_BYTES) return { ok: false, reason: "bad-page-or-size" };
    pages.push(bytes);
    if (page.nextByte === undefined) {
      const rebuilt = Buffer.concat(pages);
      return { ok: rebuilt.equals(Buffer.from(raw, "utf8")), bytes: rebuilt.length, pages: pages.length };
    }
    if (page.nextByte <= cursor || page.nextByte > Buffer.byteLength(raw) || bytes.length === 0) {
      return { ok: false, reason: "cursor-did-not-advance" };
    }
    cursor = page.nextByte;
  }
  return { ok: false, reason: "page-limit-exceeded" };
}

for (const lineCount of [1, 200, 201, 2001]) {
  for (const trailingNewline of [false, true]) {
    const body = Array.from({ length: lineCount }, (_, i) => `line-${i + 1}: unicode-監査🙂`).join("\n");
    const raw = body + (trailingNewline ? "\n" : "");
    const id = `lines-${lineCount}-${trailingNewline}`;
    indexRaw(id, raw);
    const result = await reconstruct(id, raw, 200);
    ok(`byte-exact paging: ${lineCount} lines, trailing newline ${trailingNewline}`, result.ok, JSON.stringify(result));
  }
}

const longLine = `${"監査🙂payload".repeat(12_000)}\n`;
indexRaw("byte-boundary-unicode", longLine);
const byteResult = await reconstruct("byte-boundary-unicode", longLine, 2000);
ok("byte cap pages a long UTF-8 line without splitting code points", byteResult.ok && byteResult.pages > 1, JSON.stringify(byteResult));

const corruptText = "integrity sentinel";
indexRaw("corrupt-record", corruptText);
indexer.getRecord("corrupt-record").resultText = "tampered";
const corruptResult = await api.tool.execute("pager-test", { toolCallIds: [indexer.getSearchRef("corrupt-record")] });
ok("Raw SHA mismatch fails closed without returning bytes", corruptResult.content[0].text.includes("Raw integrity validation failed") && !corruptResult.content[0].text.includes("tampered"));

indexRaw("invalid-byte-cursor", "🙂 boundary test");
const invalidCursor = await api.tool.execute("pager-test", {
  toolCallIds: [indexer.getSearchRef("invalid-byte-cursor")], startByte: 1,
});
ok("continuation cursor inside UTF-8 character is rejected", invalidCursor.content[0].text.includes("Invalid page cursor"));
