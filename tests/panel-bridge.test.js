import test from "node:test";
import assert from "node:assert/strict";
import { PanelBridge } from "../src/panel-bridge.js";

function fixture() {
  const calls = [];
  const api = { runtime: { id: "trusted-extension", getURL: (file) => `chrome-extension://trusted-extension/${file}` } };
  const catcher = {
    sessions: new Map(),
    state(tabId) { return { tabId, request: this.sessions.get(tabId)?.request || null }; },
    async send(...args) { calls.push(["send", ...args]); },
    async stop(...args) { calls.push(["stop", ...args]); },
    async releaseOwner(...args) { calls.push(["releaseOwner", ...args]); },
  };
  const bridge = new PanelBridge(api, catcher);
  const port = (extra = {}) => ({
    name: "request-catcher-panel",
    sender: { id: api.runtime.id, url: api.runtime.getURL("panel.html"), frameId: 0 },
    messages: [],
    disconnected: false,
    onMessage: { listeners: [], addListener(listener) { this.listeners.push(listener); } },
    onDisconnect: { listeners: [], addListener(listener) { this.listeners.push(listener); } },
    postMessage(message) { this.messages.push(message); },
    disconnect() { this.disconnected = true; },
    ...extra,
  });
  return { api, catcher, bridge, port, calls };
}

test("website, other extension, non-panel and subframe ports are disconnected before any handler", () => {
  const { bridge, port } = fixture();
  for (const sender of [
    { id: "evil-extension", url: "chrome-extension://trusted-extension/panel.html", frameId: 0 },
    { id: "trusted-extension", url: "https://evil.test/panel.html", frameId: 0 },
    { id: "trusted-extension", url: "chrome-extension://trusted-extension/other.html", frameId: 0 },
    { id: "trusted-extension", url: "chrome-extension://trusted-extension/panel.html", frameId: 2 },
    undefined,
  ]) {
    const untrusted = port({ sender });
    bridge.connect(untrusted);
    assert.equal(untrusted.disconnected, true);
    assert.equal(untrusted.onMessage.listeners.length, 0);
    assert.equal(bridge.ports.has(untrusted), false);
  }
});

test("another panel cannot read, send, stop or replace an owned interception", async () => {
  const { bridge, catcher, port, calls } = fixture();
  const owner = port(), other = port();
  bridge.connect(owner);
  bridge.connect(other);
  catcher.sessions.set(1, { owner, attached: true, request: { body: "private", headers: "Authorization: secret" } });
  for (const type of ["state", "send", "stop", "arm"]) {
    await assert.rejects(bridge.route(other, { type, tabId: 1 }), /другая панель/);
  }
  assert.equal(calls.length, 0);
  assert.equal((await bridge.route(owner, { type: "state", tabId: 1 })).request.body, "private");
  bridge.publish(catcher.state(1), owner);
  assert.equal(owner.messages.length, 1);
  assert.equal(other.messages.length, 0);
});

test("malformed commands cannot invoke capture operations", async () => {
  const { bridge, port, calls } = fixture();
  const panel = port();
  bridge.connect(panel);
  const listener = panel.onMessage.listeners[0];
  for (const value of [null, undefined, [], "send", { id: -1 }, { id: "1" }]) assert.doesNotThrow(() => listener(value));
  for (const message of [{ type: "send", tabId: -1 }, { type: "send", tabId: 1.1 }, { type: "send", tabId: "1" }, { type: "eval", tabId: 1 }]) {
    await assert.rejects(bridge.route(panel, message), /команда/);
  }
  assert.equal(calls.length, 0);
});

test("a reopened trusted panel can recover an interception orphaned by cancellation failure", async () => {
  const { bridge, catcher, port } = fixture();
  const panel = port();
  bridge.connect(panel);
  const session = { attached: true, owner: null, request: { body: "recoverable" } };
  catcher.sessions.set(1, session);
  const state = await bridge.route(panel, { type: "state", tabId: 1 });
  assert.equal(state.request.body, "recoverable");
  assert.equal(session.owner, panel);
});

test("disconnected ports cannot issue commands or receive later state events", async () => {
  const { bridge, port, calls } = fixture();
  const panel = port();
  bridge.connect(panel);
  panel.onDisconnect.listeners[0]();
  await assert.rejects(bridge.route(panel, { type: "send", tabId: 1 }), /команда/);
  bridge.publish({ tabId: 1, request: { body: "secret" } }, panel);
  assert.equal(panel.messages.length, 0);
  assert.deepEqual(calls, [["releaseOwner", panel]]);
});
