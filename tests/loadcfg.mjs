import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const { loadConfig } = await import(join(here, ".test-work", "testable.mjs"));
const c = await loadConfig();
console.log(JSON.stringify({ concise: c.conciseSummaryMode, maxOut: c.summarizerMaxOutputTokens, mode: c.summarizerPromptMode }));
