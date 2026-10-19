import { appendFileSync } from "node:fs";

export function createFakeWebSocket(logPath) {
  return class OfflineWebSocket {
    constructor(url) {
      if (process.env.PI_API_SEND_CAP_FAKE_WS_MODE === "constructor-throw") {
        throw Object.assign(new Error("synthetic constructor failure"), { code: "EFAKECONSTRUCTOR" });
      }
      this.url = String(url);
      this.readyState = 0;
      this.listeners = new Map();
      appendFileSync(logPath, `${JSON.stringify({ event: "constructed", url: new URL(this.url).origin })}\n`);
      queueMicrotask(() => {
        if (process.env.PI_API_SEND_CAP_FAKE_WS_MODE === "error") {
          this.readyState = 3;
          this.dispatch("error", { error: Object.assign(new Error("synthetic websocket failure"), { code: "EFAKEWS" }) });
          this.dispatch("close", { code: 1006, wasClean: false });
          return;
        }
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
      if (process.env.PI_API_SEND_CAP_FAKE_WS_MODE === "open-complete") {
        queueMicrotask(() => this.dispatch("message", { data: JSON.stringify({
          type: "response.completed",
          response: { id: "offline-response", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0 } },
        }) }));
      }
    }

    close(code = 1000, reason = "done") {
      this.readyState = 3;
      this.dispatch("close", { code, reason, wasClean: true });
    }
  };
}
