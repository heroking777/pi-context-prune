import { state } from "./test-support.mjs";
await import("./regression-options.mjs");
await import("./regression-source.mjs");
await import("./regression-evidence.mjs");
await import("./regression-phase5.mjs");
console.log(`\nRESULT pass=${state.pass} fail=${state.fail}`);
process.exit(state.fail === 0 ? 0 : 1);
