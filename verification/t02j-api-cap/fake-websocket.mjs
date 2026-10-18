import { appendFileSync } from "node:fs";

export function createFakeWebSocket(logPath) {
  return class OfflineWebSocket {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this.listeners = new Map();
      appendFileSync(logPath, `${JSON.stringify({ event: "constructed", url: new URL(this.url).origin })}\n`);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatch("open", {});
      });
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    dispatch(type, event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    send(data) {
      appendFileSync(logPath, `${JSON.stringify({ event: "underlying-send", bytes: String(data).length })}\n`);
    }

    close(code = 1000, reason = "done") {
      this.readyState = 3;
      this.dispatch("close", { code, reason, wasClean: true });
    }
  };
}
