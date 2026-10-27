import test from "node:test";
import assert from "node:assert/strict";
import { RequestCatcher } from "../src/catcher.js";

function fixture() {
  const calls = [];
  const api = {
    tabs: { get: async () => ({ url: "https://example.test/" }) },
    debugger: {
      attach: async (...args) => { calls.push({ method: "attach", args }); },
      detach: async (...args) => { calls.push({ method: "detach", args }); },
      sendCommand: async (source, method, params) => {
        calls.push({ source, method, params });
        if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "script-1" };
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1", url: "https://example.test/" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 42 };
        return {};
      },
    },
  };
  const catcher = new RequestCatcher(api);
  return { api, calls, catcher, options: { trigger: "click", types: "api", waitSeconds: 10, urlFilter: "/api" } };
}
const source = { tabId: 1 };
const paused = (id = "request-1", extra = {}) => ({
  requestId: id, networkId: "network-1", resourceType: "Fetch",
  request: { url: "https://example.test/api", method: "POST", headers: { "Content-Type": "application/json" }, postData: '{"x":1}' }, ...extra,
});
const click = { name: "__requestCatcherClick", executionContextId: 42, payload: '{"type":"click"}' };

test("only the first matching request after a trusted isolated-world binding is held", async () => {
  const { catcher, calls, options } = fixture();
  await catcher.arm(1, options, "panel");
  await catcher.onEvent(source, "Fetch.requestPaused", paused("before-click"));
  assert.equal(catcher.state(1).phase, "armed");
  await catcher.onEvent(source, "Runtime.bindingCalled", { ...click, executionContextId: 99 });
  assert.equal(catcher.state(1).phase, "armed");
  await catcher.onEvent(source, "Runtime.bindingCalled", click);
  await catcher.onEvent(source, "Fetch.requestPaused", paused("preflight", { request: { url: "https://example.test/api", method: "OPTIONS" } }));
  await Promise.all([catcher.onEvent(source, "Fetch.requestPaused", paused()), catcher.onEvent(source, "Fetch.requestPaused", paused("parallel"))]);
  assert.equal(catcher.state(1).phase, "paused");
  assert.ok(catcher.state(1).request.id.endsWith("/root:request-1"));
  assert.equal(catcher.state(1).request.body, '{"x":1}');
  assert.deepEqual(calls.filter((call) => call.method === "Fetch.continueRequest").map((call) => call.params.requestId), ["before-click", "preflight", "parallel"]);
  await catcher.stop(1);
  assert.ok(calls.some((call) => call.method === "Fetch.failRequest" && call.params.requestId === "request-1"));
  assert.equal(catcher.state(1).request, null);
});
test("edited request continues exactly once, then interception is detached", async () => {
  const { catcher, calls, options } = fixture();
  await catcher.arm(1, { ...options, trigger: "next" }, "panel");
  await catcher.onEvent(source, "Fetch.requestPaused", paused());
  const original = catcher.state(1).request;
  await catcher.send(1, original.id, { ...original, replaceBody: true, body: '{"x":2}' });
  const sent = calls.filter((call) => call.method === "Fetch.continueRequest");
  assert.equal(sent.length, 1);
  assert.equal(Buffer.from(sent[0].params.postData, "base64").toString(), '{"x":2}');
  assert.ok(calls.some((call) => call.method === "detach"));
  assert.equal(catcher.state(1).request, null);
  await assert.rejects(catcher.send(1, original.id, original), /недоступен/);
});
test("sending the original includes no overrides", async () => {
  const { catcher, calls, options } = fixture();
  await catcher.arm(1, { ...options, trigger: "next" }, "panel");
  await catcher.onEvent(source, "Fetch.requestPaused", paused());
  await catcher.send(1, catcher.state(1).request.id, null, true);
  assert.deepEqual(calls.find((call) => call.method === "Fetch.continueRequest").params, { requestId: "request-1" });
});
test("closing the owning panel aborts the selected request before detaching", async () => {
  const { catcher, calls, options } = fixture();
  await catcher.arm(1, { ...options, trigger: "next" }, "owner");
  await catcher.onEvent(source, "Fetch.requestPaused", paused());
  await catcher.releaseOwner("other-panel");
  assert.equal(catcher.state(1).phase, "paused");
  await catcher.releaseOwner("owner");
  assert.ok(calls.findIndex((c) => c.method === "Fetch.failRequest") < calls.findIndex((c) => c.method === "detach"));
  assert.equal(catcher.state(1).phase, "done");
});
test("a rejected override stays paused and can be corrected", async () => {
  const { api, catcher, options } = fixture();
  await catcher.arm(1, { ...options, trigger: "next" }, "panel");
  await catcher.onEvent(source, "Fetch.requestPaused", paused());
  const original = catcher.state(1).request;
  const sendCommand = api.debugger.sendCommand;
  api.debugger.sendCommand = async (src, method, params) => {
    if (method === "Fetch.continueRequest") throw new Error("Invalid header");
    return sendCommand(src, method, params);
  };
  await assert.rejects(catcher.send(1, original.id, { ...original, replaceBody: true }), /Invalid header/);
  assert.equal(catcher.state(1).phase, "paused");
  assert.equal(catcher.state(1).request.id, original.id);
  await catcher.stop(1);
});
test("external detach clears the sensitive request and timer", async () => {
  const { catcher, options } = fixture();
  await catcher.arm(1, { ...options, trigger: "next" }, "panel");
  await catcher.onEvent(source, "Fetch.requestPaused", paused());
  catcher.onDetach(source, "canceled_by_user");
  assert.equal(catcher.state(1).phase, "error");
  assert.equal(catcher.state(1).request, null);
});
test("panel closure during attach does not leak a debugger session", async () => {
  const { api, catcher, calls, options } = fixture();
  let finishAttach;
  api.debugger.attach = () => new Promise((resolve) => { finishAttach = resolve; });
  const arming = catcher.arm(1, options, "owner");
  const rejected = assert.rejects(arming, /отменён/);
  await new Promise((resolve) => setImmediate(resolve));
  const releasing = catcher.releaseOwner("owner");
  await assert.rejects(catcher.arm(1, options, "new-owner"), /завершите/);
  finishAttach();
  await Promise.all([releasing, rejected]);
  assert.ok(calls.some((call) => call.method === "detach"));
  assert.equal(catcher.sessions.get(1).attached, false);
});
test("duplicate arms cannot attach twice", async () => {
  const { catcher, calls, options } = fixture();
  const results = await Promise.allSettled([catcher.arm(1, options, "a"), catcher.arm(1, options, "b")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(calls.filter((call) => call.method === "attach").length, 1);
  await catcher.stop(1);
});

test("failed cancellation keeps the request intercepted and can be retried", async () => {
  const { api, catcher, calls, options } = fixture();
  await catcher.arm(1, { ...options, trigger: "next" }, "panel");
  await catcher.onEvent(source, "Fetch.requestPaused", paused());
  const sendCommand = api.debugger.sendCommand;
  api.debugger.sendCommand = async (src, method, params) => {
    if (method === "Fetch.failRequest") throw new Error("CDP temporarily unavailable");
    return sendCommand(src, method, params);
  };
  await assert.rejects(catcher.stop(1), /не подтвердил отмену/);
  assert.equal(catcher.state(1).phase, "paused");
  assert.ok(catcher.state(1).request.id.endsWith("/root:request-1"));
  assert.equal(calls.filter((call) => call.method === "detach").length, 0, "detach would release the original request");
  await catcher.releaseOwner("panel");
  assert.equal(catcher.sessions.get(1).owner, null);
  assert.equal(catcher.sessions.get(1).attached, true);
  assert.equal(catcher.state(1).phase, "paused");
  api.debugger.sendCommand = sendCommand;
  await catcher.stop(1);
  assert.equal(catcher.state(1).phase, "done");
  assert.equal(catcher.state(1).request, null);
  assert.equal(catcher.state(1).options, undefined);
});

test("a failed detach stays visible and does not permit a second attachment", async () => {
  const { api, catcher, options } = fixture();
  await catcher.arm(1, options, "panel");
  const detach = api.debugger.detach;
  api.debugger.detach = async () => { throw new Error("temporary error"); };
  await assert.rejects(catcher.stop(1), /отключить отладчик/);
  assert.equal(catcher.state(1).phase, "attached-error");
  await assert.rejects(catcher.arm(1, options, "panel"), /завершите/);
  api.debugger.detach = detach;
  await catcher.stop(1);
});

test("a late send completion cannot stop a new session on the same tab", async () => {
  const { api, catcher, options } = fixture();
  await catcher.arm(1, { ...options, trigger: "next" }, "old-panel");
  await catcher.onEvent(source, "Fetch.requestPaused", paused());
  const sendCommand = api.debugger.sendCommand;
  let finishContinue;
  api.debugger.sendCommand = (src, method, params) => method === "Fetch.continueRequest"
    ? new Promise((resolve) => { finishContinue = resolve; }) : sendCommand(src, method, params);
  const sending = catcher.send(1, catcher.state(1).request.id, null, true);
  await catcher.stop(1);
  await catcher.arm(1, { ...options, trigger: "next" }, "new-panel");
  finishContinue({});
  await sending;
  assert.equal(catcher.state(1).phase, "waiting");
  assert.equal(catcher.sessions.get(1).owner, "new-panel");
  await catcher.stop(1);
});

test("main-page origin change stops capture, while same-origin navigation preserves it", async () => {
  const { catcher, options } = fixture();
  await catcher.arm(1, options, "panel");
  await catcher.onEvent(source, "Page.frameNavigated", { frame: { id: "frame-1", url: "https://example.test/next" } });
  assert.equal(catcher.state(1).phase, "armed");
  await catcher.onEvent(source, "Page.frameNavigated", { frame: { id: "frame-1", url: "https://other.test/" } });
  assert.equal(catcher.state(1).phase, "done");
  assert.equal(catcher.sessions.get(1).attached, false);
});

test("idle click interception automatically detaches after 60 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { catcher, options } = fixture();
  await catcher.arm(1, options, "panel");
  t.mock.timers.tick(60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(catcher.state(1).phase, "done");
  assert.equal(catcher.sessions.get(1).attached, false);
});

test("a stale editor command cannot modify a later request with a reused CDP id", async () => {
  const { catcher, options } = fixture();
  await catcher.arm(1, { ...options, trigger: "next" }, "panel");
  await catcher.onEvent(source, "Fetch.requestPaused", paused());
  const oldId = catcher.state(1).request.id;
  await catcher.stop(1);
  await catcher.arm(1, { ...options, trigger: "next" }, "panel");
  await catcher.onEvent(source, "Fetch.requestPaused", paused());
  assert.notEqual(catcher.state(1).request.id, oldId);
  await assert.rejects(catcher.send(1, oldId, null, true), /недоступен/);
  assert.equal(catcher.state(1).phase, "paused");
  await catcher.stop(1);
});
