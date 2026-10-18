import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { createRequire, registerHooks } from "node:module";
import { createFakeWebSocket } from "./fake-websocket.mjs";
import { rejectOAuthRefresh } from "./oauth-refresh-guard.mjs";
import { patchCodexProvider, sendResponseCreate } from "./provider-transport-guard.mjs";
import { createWebSocketWrapper } from "./websocket-cap.mjs";

const require = createRequire(import.meta.url);
const websocketWrappers = new WeakMap();
const wrapperBudgets = new WeakMap();

export const SEND_LIMIT = 8;

function newState() {
  return { limit: SEND_LIMIT, used: 0, attempts: 0, dryRunBlocks: 0, capBlocks: 0 };
}

function readState(statePath) {
  if (!existsSync(statePath)) return newState();
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const counters = [state.used, state.attempts, state.dryRunBlocks, state.capBlocks];
  if (state.limit !== SEND_LIMIT || counters.some((count) => !Number.isInteger(count) || count < 0)) {
    throw new Error("API send-cap state invalid; refusing network");
  }
  if (state.used > SEND_LIMIT) throw new Error("API send-cap state exceeds limit; refusing network");
  return state;
}

function saveState(statePath, state) {
  const fd = openSync(statePath, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(state)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function appendEvent(logPath, event) {
  appendFileSync(logPath, `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`, { mode: 0o600 });
}

function withStateLock(lockPath, action) {
  let lockFd;
  try {
    lockFd = openSync(lockPath, "wx", 0o600);
  } catch {
    throw new Error("API send denied: cap lock unavailable (fail closed)");
  }
  try {
    return action();
  } finally {
    closeSync(lockFd);
    unlinkSync(lockPath);
  }
}

function reserveSend(paths, dryRun, transport, target) {
  return withStateLock(paths.lockPath, () => {
    const state = readState(paths.statePath);
    state.attempts++;
    if (dryRun) {
      if (state.dryRunBlocks >= SEND_LIMIT) {
        state.capBlocks++;
        saveState(paths.statePath, state);
        appendEvent(paths.logPath, { event: "denied", reason: "dry-run-attempt-limit", transport, target: safeTarget(target) });
        throw new Error("API send denied: dry-run attempt cap reached");
      }
      state.dryRunBlocks++;
      saveState(paths.statePath, state);
      appendEvent(paths.logPath, { event: "blocked", reason: "dry-run", transport, target: safeTarget(target) });
      throw new Error("API send denied: dry-run mode");
    }
    if (state.used >= SEND_LIMIT) {
      state.capBlocks++;
      saveState(paths.statePath, state);
      appendEvent(paths.logPath, { event: "denied", reason: "limit-8", transport, target: safeTarget(target) });
      throw new Error("API_SEND_CAP_REACHED: limit 8");
    }
    state.used++;
    saveState(paths.statePath, state);
    appendEvent(paths.logPath, { event: "reserved", used: state.used, limit: SEND_LIMIT, transport, target: safeTarget(target) });
    return state.used;
  });
}

export function createBudget(directory, dryRun = true) {
  if (!directory || !isAbsolute(directory)) throw new Error("PI_API_SEND_CAP_DIR must be an absolute path");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const paths = {
    directory,
    statePath: join(directory, "state.json"),
    lockPath: join(directory, "state.lock"),
    logPath: join(directory, "events.jsonl"),
  };
  if (!existsSync(paths.statePath) &&
      (existsSync(paths.logPath) || existsSync(join(directory, "preload.jsonl")))) {
    throw new Error("API send-cap state missing from a used directory; refusing network");
  }
  return {
    directory,
    dryRun,
    reserve: (transport, target) => reserveSend(paths, dryRun, transport, target),
    blockConnection: (target, reason) => appendEvent(paths.logPath, { event: "connection-blocked", reason, target: safeTarget(target) }),
    snapshot: () => readState(paths.statePath),
  };
}

function safeTarget(value) {
  try {
    const url = new URL(String(value));
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "unparseable-target";
  }
}

export function isExternalUrl(value) {
  try {
    const url = new URL(String(value));
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
    return !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function httpTarget(input, options, defaultProtocol) {
  if (input instanceof URL) return input.href;
  if (typeof input === "string" && /^https?:\/\//i.test(input)) return input;
  const opts = typeof options === "object" && options !== null ? options : {};
  const values = typeof input === "object" && input !== null ? input : {};
  const protocol = opts.protocol ?? values.protocol ?? defaultProtocol;
  const hostname = opts.hostname ?? values.hostname ?? opts.host ?? values.host;
  const path = opts.path ?? values.path ?? "/";
  if (!hostname) return "";
  return `${protocol}//${hostname}${path}`;
}

export function wrapFetch(originalFetch, budget, onBlocked = () => {}) {
  return async function cappedFetch(input, options = {}) {
    const url = input?.url ?? input;
    rejectOAuthRefresh(url, budget, onBlocked);
    if (isExternalUrl(url)) {
      try {
        budget.reserve("fetch", url);
      } catch (error) {
        onBlocked(error, url);
        throw error;
      }
    }
    return originalFetch.call(globalThis, input, options);
  };
}

export function wrapHttpRequest(module, protocol, budget, onBlocked = () => {}) {
  const original = module.request;
  module.request = function cappedRequest(...args) {
    const [input, options] = args;
    const url = httpTarget(input, options, protocol);
    if (isExternalUrl(url)) {
      try {
        budget.reserve("http.request", url);
      } catch (error) {
        onBlocked(error, url);
        throw error;
      }
    }
    return original.apply(this, args);
  };
}

export function wrapWebSocket(Base, budget, options = {}) {
  return createWebSocketWrapper(Base, budget, options, websocketWrappers, wrapperBudgets);
}

export function installApiSendCap(environment = process.env) {
  const directory = environment.PI_API_SEND_CAP_DIR;
  const dryRun = environment.PI_API_SEND_CAP_DRY_RUN !== "0";
  const budget = createBudget(directory, dryRun);
  globalThis.__PI_API_SEND_CAP_PROVIDER_VERIFIED = false;
  const testExit = environment.PI_API_SEND_CAP_TEST_EXIT_AFTER_BLOCK === "1";
  const onBlocked = (error) => {
    if (testExit && /dry-run mode/.test(String(error))) process.exit(0);
    if (/API_SEND_CAP_REACHED|OAuth refresh prohibited|cap lock unavailable/.test(String(error))) process.exit(78);
  };
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== "function") throw new Error("fetch unavailable; refusing unguarded run");
  const guardedFetch = wrapFetch(nativeFetch, budget, onBlocked);
  const fakeWebSocket = environment.PI_API_SEND_CAP_FAKE_WEBSOCKET === "1"
    ? createFakeWebSocket(join(directory, "fake-websocket.jsonl"))
    : undefined;
  const nativeWebSocket = fakeWebSocket ?? globalThis.WebSocket;
  if (typeof nativeWebSocket !== "function") throw new Error("WebSocket unavailable; refusing unguarded run");
  const wrapResolvedWebSocket = (Base) => {
    const selectedBase = fakeWebSocket ?? Base;
    const guarded = wrapWebSocket(selectedBase, budget, {
      blockExternalInDryRun: !fakeWebSocket,
      requireVerifiedProvider: true,
      reserveBeforeHandshake: !fakeWebSocket,
      onBlocked,
    });
    appendFileSync(join(directory, "websocket-constructor.jsonl"), `${JSON.stringify({
      requestedConstructor: Base?.name ?? "unknown",
      selectedConstructor: selectedBase.name,
      forcedOfflineFake: Boolean(fakeWebSocket),
    })}\n`, { mode: 0o600 });
    return guarded;
  };
  globalThis.__PI_API_SEND_CAP_FETCH = guardedFetch;
  globalThis.__PI_API_SEND_CAP_WRAP_WEBSOCKET = wrapResolvedWebSocket;
  globalThis.__PI_API_SEND_CAP_RESPONSE_CREATE = (socket, payload, target) =>
    sendResponseCreate(socket, payload, target, budget, onBlocked);
  registerHooks({
    load(url, context, nextLoad) {
      return patchCodexProvider(url, nextLoad(url, context), budget);
    },
  });
  globalThis.fetch = guardedFetch;
  wrapHttpRequest(awaitImportHttp(), "http:", budget, onBlocked);
  wrapHttpRequest(awaitImportHttps(), "https:", budget, onBlocked);
  const guarded = wrapResolvedWebSocket(nativeWebSocket);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { ...descriptor, value: guarded });
  appendFileSync(join(directory, "preload.jsonl"), `${JSON.stringify({ pid: process.pid, node: process.version, limit: SEND_LIMIT, dryRun, fetchWrapped: true, httpWrapped: true, websocketWrapped: true, offlineFake: Boolean(fakeWebSocket) })}\n`, { mode: 0o600 });
  return budget;
}

function awaitImportHttp() {
  return require("node:http");
}

function awaitImportHttps() {
  return require("node:https");
}
