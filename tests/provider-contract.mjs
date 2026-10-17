// Minimal offline contract copied from pi-commandcode-provider 0.6.4
// src/core.ts mappedReasoningEffort (lines 143-150 at Phase7 baseline).
// This deliberately avoids reading provider files or credentials from the host.
export function mappedReasoningEffort(model, options) {
  const level = options?.reasoning;
  if (!level || level === "off" || !model.reasoning) return undefined;
  const effortMap = model.thinking?.effortMap ?? model.thinkingLevelMap;
  const mapped = effortMap?.[level];
  return typeof mapped === "string" && mapped !== "off" ? mapped : undefined;
}
