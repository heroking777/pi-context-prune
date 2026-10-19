import type { ToolCallRecord } from "./types.js";

type RawIndexRecord = ToolCallRecord & Record<string, any>;

export function mergePersistedRawUpdate(
  previousRecord: ToolCallRecord | undefined,
  incomingRecord: ToolCallRecord,
): ToolCallRecord {
  const previous = previousRecord as RawIndexRecord | undefined;
  const incoming = incomingRecord as RawIndexRecord;
  const previousHasRaw = previous?.__contextPruneRawOnly === true &&
    typeof previous.__contextPruneRawSha256 === "string" &&
    typeof previous.__contextPruneRawByteLength === "number";
  const matchesRaw = previousHasRaw &&
    previous.__contextPruneRawSha256 === incoming.__contextPruneRawSha256 &&
    previous.__contextPruneRawByteLength === incoming.__contextPruneRawByteLength;
  const isRawUpdate = incoming.__contextPruneRawUpdate === true &&
    incoming.resultText === "" && matchesRaw;
  const followsRawCapture = previousHasRaw &&
    incoming.__contextPruneRawOnly !== true &&
    incoming.__contextPruneRawUpdate !== true;
  if (!isRawUpdate && !followsRawCapture) return incomingRecord;

  const merged = {
    ...previous,
    ...incoming,
    resultText: previous?.resultText ?? "",
    __contextPruneRawSha256: previous?.__contextPruneRawSha256,
    __contextPruneRawByteLength: previous?.__contextPruneRawByteLength,
  } as RawIndexRecord;
  delete merged.__contextPruneRawOnly;
  delete merged.__contextPruneRawUpdate;
  return merged;
}
