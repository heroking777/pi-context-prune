// Phase 23 STEP 4 — observability overhead, synthetic workload only.
//
// Measures the wall-clock cost and synchronous write count of the metadata
// observer OFF vs ON. No provider, no network, no real tool results. Timing is
// reported as a median with range because the shared runner is noisy; only the
// deterministic counts are asserted.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, MetadataObserver, measureSummary, ok } from "./test-support.mjs";

const OBSERVATIONS = 300;
const REPEATS = 5;
const config = { ...DEFAULT_CONFIG, pruneOn: "agent-message", midTaskAutoPrune: true };
const batches = Array.from({ length: OBSERVATIONS }, (_, index) => ({
  turnIndex: index,
  timestamp: index,
  toolCalls: [{ toolName: "bash", toolCallId: `overhead-${index}`, resultText: "x".repeat(120), args: {} }],
}));
const result = { summaryText: "synthetic summary", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } };

function logCount(directory) {
  if (!existsSync(directory)) return 0;
  return readdirSync(directory).filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(directory, name), "utf8").trim().split("\n").filter(Boolean)).length;
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
async function run(observer) {
  const started = performance.now();
  for (const batch of batches) {
    await measureSummary(batch, config, async () => result, observer);
  }
  return performance.now() - started;
}

const offDir = join(mkdtempSync(join(tmpdir(), "pruner-overhead-off-")), "never-created");
const off = new MetadataObserver({ enabled: false, directory: offDir });
const onDir = mkdtempSync(join(tmpdir(), "pruner-overhead-on-"));
const on = new MetadataObserver({ enabled: true, directory: onDir, loadedBuildIdentity: "o".repeat(64) });

const offRuns = [];
const onRuns = [];
for (let repeat = 0; repeat < REPEATS; repeat++) {
  offRuns.push(await run(off));
  onRuns.push(await run(on));
}

const onRecords = logCount(onDir);
ok("observer OFF writes no log and creates no directory", logCount(offDir) === 0 && !existsSync(offDir));
ok("observer ON writes exactly one record per summary attempt", onRecords === OBSERVATIONS * REPEATS, `got ${onRecords}`);

const offMedian = median(offRuns);
const onMedian = median(onRuns);
const overheadMs = onMedian - offMedian;
const overheadRatio = offMedian > 0 ? onMedian / offMedian : Number.POSITIVE_INFINITY;
console.log(`  INFO overhead synthetic: observations=${OBSERVATIONS} repeats=${REPEATS}`);
console.log(`  INFO off_ms median=${offMedian.toFixed(1)} range=${Math.min(...offRuns).toFixed(1)}..${Math.max(...offRuns).toFixed(1)}`);
console.log(`  INFO on_ms  median=${onMedian.toFixed(1)} range=${Math.min(...onRuns).toFixed(1)}..${Math.max(...onRuns).toFixed(1)}`);
console.log(`  INFO per_record_sync_write_ms median=${(overheadMs / (OBSERVATIONS * REPEATS)).toFixed(4)} ratio=${overheadRatio.toFixed(2)}x`);
console.log("  INFO timing measured on a shared runner and is indicative only; no assertion is made on it");

rmSync(onDir, { recursive: true, force: true });
rmSync(join(offDir, ".."), { recursive: true, force: true });
