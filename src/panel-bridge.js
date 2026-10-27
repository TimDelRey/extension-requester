// Authenticates and multiplexes chrome.runtime.Port connections from panel.html,
// and is the only way the UI can reach RequestCatcher. `connect()` rejects anything
// that isn't this exact extension's top-frame panel page, so neither a web page nor
// another extension can ever reach `route()` — Chrome only delivers onConnect for
// same-extension senders in the first place; the checks here are defense in depth.
// `route()` then enforces that a session can only be read or driven by the port that
// owns it, so one open panel cannot see or touch another panel's captured request.
const COMMANDS = new Set(["state", "arm", "send", "stop"]);

export class PanelBridge {
  constructor(api, catcher) {
    this.api = api;
    this.catcher = catcher;
    this.ports = new Set();
  }

  connect(port) {
    const sender = port.sender;
    if (port.name !== "request-catcher-panel" || sender?.id !== this.api.runtime.id ||
        sender?.url !== this.api.runtime.getURL("panel.html") ||
        (sender.frameId !== undefined && sender.frameId !== 0)) {
      port.disconnect();
      return;
    }
    this.ports.add(port);
    port.onMessage.addListener((message) => {
      if (!message || typeof message !== "object" || !Number.isSafeInteger(message.id) || message.id < 1) return;
      const reply = (value) => {
        if (this.ports.has(port)) port.postMessage({ type: "reply", id: message.id, ...value });
      };
      void this.route(port, message).then(
        (state) => reply({ state }),
        (error) => reply({ error: error.message }),
      ).catch(() => {}); // The panel may close between the membership check and postMessage.
    });
    port.onDisconnect.addListener(() => {
      this.ports.delete(port);
      void this.catcher.releaseOwner(port);
    });
  }

  async route(port, message) {
    if (!this.ports.has(port) || !Number.isSafeInteger(message.tabId) || message.tabId < 0 || !COMMANDS.has(message.type)) {
      throw new Error("Некорректная команда панели.");
    }
    const session = this.catcher.sessions.get(message.tabId);
    if (session?.owner && session.owner !== port) {
      throw new Error("Перехватом управляет другая панель. Завершите его там.");
    }
    if (session?.attached && !session.owner) session.owner = port;
    switch (message.type) {
      case "state": break;
      case "arm":
        await this.catcher.arm(message.tabId, message.options, port);
        if (!this.ports.has(port)) await this.catcher.releaseOwner(port);
        break;
      case "send":
        await this.catcher.send(message.tabId, message.requestId, message.draft, message.original === true);
        break;
      case "stop": await this.catcher.stop(message.tabId); break;
    }
    return this.catcher.state(message.tabId);
  }

  publish(state, owner) {
    if (this.ports.has(owner)) {
      try { owner.postMessage({ type: "state", state }); } catch { /* panel closed */ }
    }
  }
}
