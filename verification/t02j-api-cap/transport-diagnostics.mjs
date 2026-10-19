import { appendFileSync, accessSync, readFileSync, readlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CAUSE_DEPTH = 3;
const SAFE_CODE = /^[A-Z0-9_./-]{1,80}$/i;
const SAFE_MESSAGE = /^[\w .,:;()/-]{0,240}$/;

function safeText(value) {
  const text = String(value ?? "");
  if (/https?:\/\/|wss?:\/\/|bearer|authorization|cookie|token|secret|\?[\w%.-]+=|(?:[a-z0-9-]+\.)+[a-z]{2,}|[A-Za-z0-9_-]{32,}/i.test(text)) return "REDACTED";
  return SAFE_MESSAGE.test(text) ? text : "REDACTED";
}

function safeCode(value) {
  const text = String(value ?? "");
  return SAFE_CODE.test(text) ? text : "REDACTED";
}

function errorFields(error, depth = 0) {
  if (!error || typeof error !== "object") return { status: "MISSING" };
  const result = {
    name: safeCode(error.name ?? "MISSING"),
    message: safeText(error.message ?? "MISSING"),
    code: error.code == null ? "MISSING" : safeCode(error.code),
    errno: error.errno == null ? "MISSING" : safeCode(error.errno),
    syscall: error.syscall == null ? "MISSING" : safeCode(error.syscall),
  };
  if (depth >= MAX_CAUSE_DEPTH) {
    result.cause = error.cause == null ? "MISSING" : "TRUNCATED";
  } else {
    result.cause = error.cause == null ? "MISSING" : errorFields(error.cause, depth + 1);
  }
  return result;
}

export function createDiagnostics(logPath, { transport, operationId = "UNKNOWN", retryAttempt = 1, requestId = randomUUID(), now = () => new Date().toISOString() }) {
  return {
    requestId,
    async fetch(fetchImpl, input, init) {
      try {
        return await fetchImpl(input, init);
      } catch (error) {
        const record = {
          event: "fetch-error",
          transport,
          requestId,
          operationId,
          retryAttempt,
          at: now(),
          error: errorFields(error),
        };
        try {
          appendFileSync(logPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        } catch {
          throw new Error("Transport diagnostics unavailable; refusing to continue");
        }
        throw error;
      }
    },
  };
}

export function recordWebSocket(logPath, requestId, event, at = new Date().toISOString(), operationId = "UNKNOWN", error = undefined) {
  if (!["websocket-attempt-start", "handshake-reserved", "constructor-attempt", "constructor-failure", "open", "error", "close"].includes(event)) throw new Error("Invalid WebSocket diagnostic event");
  appendFileSync(logPath, `${JSON.stringify({ event, requestId, operationId, transport: "websocket", at, ...(["error", "constructor-failure"].includes(event) ? { error: errorFields(error) } : {}) })}\n`, { mode: 0o600 });
}

export function recordOperationEvent(logPath, operationId, event, details = {}) {
  const allowed = ["operation-start", "sse-fallback-selected", "fetch-attempt", "fetch-request", "websocket-attempt-start"];
  if (!allowed.includes(event)) throw new Error("Invalid operation diagnostic event");
  appendFileSync(logPath, `${JSON.stringify({ event, operationId, ...details, at: new Date().toISOString() })}\n`, { mode: 0o600 });
}

export function sandboxSnapshot({ harnessPath, providerPath, env = process.env, fs = undefined }) {
  const f = fs ?? { accessSync, readFileSync, readlinkSync };
  const present = (path) => Boolean(path && env[path]);
  const check = (path) => {
    try { f.accessSync(path); return true; } catch { return false; }
  };
  let namespace = "UNKNOWN";
  try { namespace = f.readlinkSync("/proc/self/ns/net"); } catch { /* unavailable */ }
  return {
    networkNamespace: namespace,
    resolvConf: { exists: check("/etc/resolv.conf"), readable: checkReadable(f, "/etc/resolv.conf") },
    ca: { nodeExtraCaCertsSet: present("NODE_EXTRA_CA_CERTS"), nodeUseSystemCa: env.NODE_USE_SYSTEM_CA === "1", standardBundleReadable: ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"].some((p) => checkReadable(f, p)) },
    proxy: { httpProxySet: present("HTTP_PROXY") || present("http_proxy"), httpsProxySet: present("HTTPS_PROXY") || present("https_proxy"), allProxySet: present("ALL_PROXY") || present("all_proxy") },
    fetch: { implementation: typeof globalThis.fetch === "function" ? "globalThis.fetch" : "MISSING", node: process.version },
    harnessSha: hashFile(f, harnessPath),
    provider: providerIdentity(providerPath, f),
  };
}

export function recordSandboxSnapshot(logPath, options) {
  const snapshot = sandboxSnapshot(options);
  appendFileSync(logPath, `${JSON.stringify({ event: "sandbox-snapshot", ...snapshot })}\n`, { mode: 0o600 });
  return snapshot;
}

function checkReadable(f, path) { try { f.accessSync(path); f.readFileSync(path, { flag: "r" }); return true; } catch { return false; } }
function hashFile(f, path) { try { return createHash("sha256").update(f.readFileSync(path)).digest("hex"); } catch { return "UNKNOWN"; } }
function providerIdentity(path, f) {
  if (!path) return { module: "UNKNOWN", version: "UNKNOWN" };
  try {
    const modulePath = path.startsWith("file:") ? fileURLToPath(path) : path;
    const root = resolve(dirname(modulePath), "../..");
    const pkg = JSON.parse(f.readFileSync(`${root}/package.json`, "utf8"));
    return { module: basename(modulePath), version: safeCode(pkg.version) };
  } catch { return { module: basename(path), version: "UNKNOWN" }; }
}
