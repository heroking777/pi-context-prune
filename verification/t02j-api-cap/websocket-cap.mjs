const RAW_WEBSOCKET_SEND = Symbol.for("pi.api-send-cap.raw-websocket-send");
const RESERVATION_CONSUMER = Symbol.for("pi.api-send-cap.consume-websocket-reservation");

function isExternalUrl(value) {
  try {
    const url = new URL(String(value));
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
    return !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isValidWebSocketUrl(value) {
  try {
    return ["ws:", "wss:"].includes(new URL(String(value)).protocol);
  } catch {
    return false;
  }
}

function createCappedWebSocket(Base, budget, options) {
  const blockExternalInDryRun = options.blockExternalInDryRun ?? true;
  const requireVerifiedProvider = options.requireVerifiedProvider ?? true;
  const reserveBeforeHandshake = options.reserveBeforeHandshake ?? true;
  const onBlocked = options.onBlocked ?? (() => {});
  return class CappedWebSocket extends Base {
    constructor(url, protocols) {
      const target = String(url);
      if (!isValidWebSocketUrl(target)) {
        budget.blockConnection(target, "invalid-websocket-url");
        throw new Error("Invalid WebSocket target; refusing transport");
      }
      const external = isExternalUrl(target);
      if (external && requireVerifiedProvider && !globalThis.__PI_API_SEND_CAP_PROVIDER_VERIFIED) {
        budget.blockConnection(target, "provider-path-unverified");
        throw new Error("Unverified provider WebSocket blocked");
      }
      if (external && budget.dryRun && blockExternalInDryRun) {
        budget.blockConnection(target, "dry-run-before-handshake");
        throw new Error("WebSocket handshake blocked in dry-run");
      }
      const pending = external && reserveBeforeHandshake;
      const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
      const record = options.recordDiagnostic ?? (() => {});
      if (pending) {
        try {
          budget.reserve("websocket.handshake", target);
          record(requestId, "handshake-reserved");
        } catch (error) {
          onBlocked(error, target);
          throw error;
        }
      }
      super(url, protocols);
      this.__piApiSendCapTarget = target;
      this.__piApiSendCapRequestId = requestId;
      this.__piApiSendCapReservationPending = pending;
      for (const event of ["open", "error", "close"]) {
        this.addEventListener?.(event, () => record(requestId, event));
      }
    }

    [RESERVATION_CONSUMER]() {
      if (!this.__piApiSendCapReservationPending) return false;
      this.__piApiSendCapReservationPending = false;
      return true;
    }

    send(...args) {
      const target = this.__piApiSendCapTarget ?? this.url ?? "unknown";
      try {
        if (!this[RESERVATION_CONSUMER]()) budget.reserve("websocket.send", target);
      } catch (error) {
        onBlocked(error, target);
        throw error;
      }
      return super.send(...args);
    }

    [RAW_WEBSOCKET_SEND](...args) {
      return super.send(...args);
    }
  };
}

export function createWebSocketWrapper(Base, budget, options, websocketWrappers, wrapperBudgets) {
  if (wrapperBudgets.get(Base) === budget) return Base;
  let byBudget = websocketWrappers.get(Base);
  if (!byBudget) {
    byBudget = new WeakMap();
    websocketWrappers.set(Base, byBudget);
  }
  if (byBudget.has(budget)) return byBudget.get(budget);
  const CappedWebSocket = createCappedWebSocket(Base, budget, options);
  byBudget.set(budget, CappedWebSocket);
  wrapperBudgets.set(CappedWebSocket, budget);
  return CappedWebSocket;
}
