import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoServer } from "../demo/server.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const chromePath = process.env.CHROME_PATH || (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 15000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeout) {
    try { const result = await check(); if (result) return result; } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error(`Timeout: ${label}${lastError ? ` (${lastError.message})` : ""}`);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("CDP closed")); }
      this.pending.clear();
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

const profile = await mkdtemp(path.join(tmpdir(), "request-catcher-chrome-"));
const { server, received, navigations } = createDemoServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const base = `http://127.0.0.1:${server.address().port}`;
let chromeProcess;
let cdp;
let panelSession;
let stderr = "";
let passed = false;
try {
  chromeProcess = spawn(chromePath, [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--enable-unsafe-extension-debugging",
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-default-apps",
    "--disable-background-networking", "--disable-component-update", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  chromeProcess.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-6000); });
  chromeProcess.on("error", (error) => { stderr += error.message; });
  const endpoint = await until(async () => {
    if (chromeProcess.exitCode !== null) throw new Error(`Chrome exited: ${stderr}`);
    const lines = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
    return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
  }, "Chrome launch");
  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  cdp = new CDP(ws);
  const extension = await cdp.send("Extensions.loadUnpacked", { path: root });
  console.log(`Loaded extension: ${extension.id}`);
  const panel = await cdp.send("Target.createTarget", { url: `chrome-extension://${extension.id}/panel.html` });
  panelSession = (await cdp.send("Target.attachToTarget", { targetId: panel.targetId, flatten: true })).sessionId;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 1100, deviceScaleFactor: 1, mobile: false }, panelSession);
  async function evaluate(expression) {
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, panelSession);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  await until(() => evaluate("!!document.getElementById('arm')"), "panel ready");
  const demoTab = await evaluate(`chrome.tabs.create({ url: ${JSON.stringify(base)}, active: true })`);
  const tabId = demoTab.id;
  // Loading the panel as a tab does not grant activeTab, so Chrome hides its title.
  await until(() => evaluate(`chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => tabs[0]?.id === ${tabId})`), "demo tab selected");
  await until(() => evaluate("document.getElementById('status-label').textContent === 'ГОТОВ К ПЕРЕХВАТУ'"), "panel initialized");
  const blockedByCSP = await evaluate(`(async () => {
    globalThis.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => globalThis.__cspViolations.push(event.effectiveDirective));
    try { await fetch(${JSON.stringify(base + "/should-never-leak")}); return false; }
    catch { return true; }
  })()`);
  assert.equal(blockedByCSP, true);
  await until(() => evaluate("globalThis.__cspViolations.includes('connect-src')"), "CSP connect-src enforced");
  assert.equal(received.length, 0, "extension page contacted the network");
  console.log("PASS: CSP blocks network connections from extension pages");

  const label = () => evaluate("document.getElementById('status-label').textContent");
  const error = () => evaluate("document.getElementById('error').hidden ? '' : document.getElementById('error').textContent");
  async function arm(trigger = "click", types = "api") {
    await evaluate(`(() => {
      document.getElementById('trigger').value = ${JSON.stringify(trigger)};
      document.getElementById('types').value = ${JSON.stringify(types)};
      document.getElementById('url-filter').value = '/echo';
      document.getElementById('arm').click();
    })()`);
    const expected = trigger === "click" ? "ОЖИДАЮ КЛИК" : "ОЖИДАЮ ЗАПРОС";
    await until(async () => { const message = await error(); if (message) throw new Error(message); return await label() === expected; }, `arm (${trigger})`);
  }
  async function debug(method, params) {
    return evaluate(`chrome.debugger.sendCommand({ tabId: ${tabId} }, ${JSON.stringify(method)}, ${JSON.stringify(params)})`);
  }
  async function pageEval(expression) { return (await debug("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value; }
  async function clickDemo(id, navigationOnPointerDown = false) {
    const rect = await pageEval(`(() => {
      const element = document.getElementById(${JSON.stringify(id)});
      element.scrollIntoView({ block: 'center' });
      return element.getBoundingClientRect().toJSON();
    })()`);
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    if (navigationOnPointerDown) {
      // Input's acknowledgement may wait for a navigation that we deliberately paused.
      // Send both physical events without waiting for that acknowledgement.
      await evaluate(`(() => {
        for (const type of ['mousePressed', 'mouseReleased']) {
          void chrome.debugger.sendCommand({ tabId: ${tabId} }, 'Input.dispatchMouseEvent',
            { type, x: ${x}, y: ${y}, button: 'left', clickCount: 1 }).catch(() => {});
        }
      })()`);
    } else {
      await debug("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await debug("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    }
    await until(async () => await label() === "ЗАПРОС НА ПАУЗЕ" && await evaluate("!document.getElementById('send').disabled"), `capture ${id}`);
  }
  async function send(button = "send") {
    await evaluate(`document.getElementById(${JSON.stringify(button)}).click()`);
    await until(async () => { const message = await error(); if (message) throw new Error(message); return await label() === "ПЕРЕХВАТ ЗАВЕРШЁН"; }, `send ${button}`);
  }

  // Exercise the actual fresh-install defaults, without selecting a working mode in the test.
  assert.equal(await evaluate("document.getElementById('trigger').value"), "next");
  assert.equal(await evaluate("document.getElementById('types').value"), "all");
  await evaluate("document.getElementById('arm').click()");
  await until(async () => { const message = await error(); if (message) throw new Error(message); return await label() === 'ОЖИДАЮ ЗАПРОС'; }, "default interception ready");
  await clickDemo("redirect", true);
  assert.equal(navigations.length, 0, "navigation escaped before review");
  assert.equal(await evaluate("document.getElementById('editor').hidden"), false);
  assert.equal(await evaluate("document.getElementById('request-kind').textContent"), "Document");
  assert.ok((await evaluate("document.getElementById('headers').value")).length > 0);
  assert.equal(await evaluate("document.getElementById('body').value"), "");
  assert.match(await evaluate("document.getElementById('request-help').textContent"), /GET.*нет тела/);
  await evaluate(`(() => {
    document.getElementById('url').value = ${JSON.stringify(base + "/redirect?source=edited")};
    document.getElementById('headers').value += ${JSON.stringify("\nX-Redirect-Test: reviewed")};
  })()`);
  await send();
  await until(() => navigations.length === 2, "redirect followed only after confirmation");
  assert.equal(navigations[0].url, "/redirect?source=edited");
  assert.equal(navigations[0].headers["x-redirect-test"], "reviewed");
  assert.equal(navigations[1].url, "/redirect-destination?from=302");
  console.log("PASS: default mode pauses pointerdown navigation, exposes editor, and follows 302 only after sending");
  await evaluate(`chrome.tabs.update(${tabId}, { url: ${JSON.stringify(base)} })`);
  await until(() => evaluate(`chrome.tabs.get(${tabId}).then(tab => tab.status === 'complete')`), "demo restored after redirect");

  await arm();
  // Requests before the selected click must pass straight through.
  await pageEval("fetch('/background').then(r => r.text())");
  assert.equal(received.length, 1);
  assert.equal(await label(), "ОЖИДАЮ КЛИК");
  await clickDemo("json");
  assert.equal(received.length, 1, "selected request leaked before confirmation");
  assert.equal(await evaluate("document.getElementById('body').value"), '{"name":"Tim","quantity":1}');
  const otherOrigin = base.replace("127.0.0.1", "localhost");
  await evaluate(`document.getElementById('url').value = ${JSON.stringify(otherOrigin + "/echo?leak")}`);
  await evaluate("document.getElementById('send').click()");
  await until(async () => (await error()).includes("origin"), "cross-origin override rejected");
  assert.equal(await label(), "ЗАПРОС НА ПАУЗЕ");
  assert.equal(received.length, 1, "cross-origin attempt sent the request");
  console.log("PASS: cross-origin request edits are blocked before sending");
  await evaluate(`(() => {
    document.getElementById('method').value = 'PATCH';
    document.getElementById('url').value = ${JSON.stringify(base + "/echo?source=edited")};
    document.getElementById('headers').value += ${JSON.stringify("\nX-Test: hello")};
    document.getElementById('replace-body').click();
    document.getElementById('body').value = JSON.stringify({ name: 'Тим 🚀', quantity: 42 });
    document.getElementById('body').dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  await evaluate("document.getElementById('tab-body').click()");
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, panelSession);
  await writeFile(path.join(root, "artifacts/editor.png"), Buffer.from(shot.data, "base64"));
  await send();
  await until(() => received.length === 2, "edited request received");
  assert.equal(received[1].method, "PATCH");
  assert.equal(received[1].url, "/echo?source=edited");
  assert.equal(received[1].headers["x-test"], "hello");
  assert.deepEqual(JSON.parse(received[1].body), { name: "Тим 🚀", quantity: 42 });
  assert.equal(Number(received[1].headers["content-length"]), Buffer.byteLength(received[1].body));
  console.log("PASS: real trusted click, no early send, edited URL/method/headers/Unicode body");

  await arm();
  await clickDemo("xhr");
  assert.equal(received.length, 2);
  await send("send-original");
  await until(() => received.length === 3, "original XHR received");
  assert.equal(received[2].url, "/echo?source=xhr");
  assert.deepEqual(JSON.parse(received[2].body), { name: "Tim", quantity: 1 });
  console.log("PASS: original XHR continued");

  await arm();
  await clickDemo("json");
  await send("cancel");
  await sleep(200);
  assert.equal(received.length, 3, "cancelled request reached the server");
  console.log("PASS: cancel aborts the request");

  await arm("next");
  const maliciousBody = '</textarea><img id="attacker" src="https://evil.invalid/steal" onerror="globalThis.__rcXss = true">';
  await pageEval(`void fetch('/echo?source=untrusted', { method: 'POST', headers: { 'X-Untrusted': '<svg onload=alert(1)>' }, body: ${JSON.stringify(maliciousBody)} }).catch(() => {})`);
  await until(() => evaluate("document.getElementById('status-label').textContent === 'ЗАПРОС НА ПАУЗЕ' && !document.getElementById('send').disabled"), "untrusted body captured");
  assert.equal(await evaluate("document.getElementById('body').value"), maliciousBody);
  assert.equal(await evaluate("document.getElementById('attacker') === null && globalThis.__rcXss === undefined"), true);
  await send("cancel");
  assert.equal(received.length, 3);
  console.log("PASS: hostile HTML in request data stays inert in the editor");

  await arm("next");
  // In next-request mode a programmatic click is sufficient.
  await pageEval("document.getElementById('upload').click()");
  await until(() => evaluate("document.getElementById('status-label').textContent === 'ЗАПРОС НА ПАУЗЕ' && !document.getElementById('send').disabled"), "multipart captured");
  await evaluate(`document.getElementById('headers').value += ${JSON.stringify("\nX-Test: upload-preserved")}`);
  await send();
  await until(() => received.length === 4, "multipart received");
  assert.equal(received[3].headers["x-test"], "upload-preserved");
  assert.match(received[3].body, /filename="sample.bin"/);
  assert.match(received[3].body, /name="name"\r\n\r\nTim/);
  assert.ok(received[3].rawBody.includes(Buffer.from([0, 1, 2, 255, 128])), "binary file bytes changed");
  console.log("PASS: header-only override preserves multipart upload");

  await arm("click", "all");
  await clickDemo("navigation");
  assert.equal(received.length, 4);
  await evaluate(`document.getElementById('url').value = ${JSON.stringify(base + "/echo?navigation=edited")}`);
  await send();
  await until(() => received.length === 5, "navigation received");
  assert.equal(received[4].url, "/echo?navigation=edited");
  console.log("PASS: document navigation URL edited");

  await evaluate(`chrome.tabs.update(${tabId}, { url: ${JSON.stringify(base)} })`);
  await until(() => evaluate(`chrome.tabs.get(${tabId}).then(tab => tab.status === 'complete')`), "demo reloaded");
  await arm();
  await clickDemo("json");
  assert.equal(received.length, 5);
  await cdp.send("Target.closeTarget", { targetId: panel.targetId });
  await until(async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    return targetInfos.some((target) => target.type === "page" && target.url === base + "/" && !target.attached);
  }, "panel closure detaches debugger");
  await sleep(200);
  assert.equal(received.length, 5, "closing panel sent the pending request");
  console.log("PASS: closing the panel aborts the pending request and detaches debugger");

  passed = true;
  console.log("All Chrome integration checks passed. Screenshot: artifacts/editor.png");
} catch (error) {
  if (cdp && panelSession) {
    try {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, panelSession);
      await mkdir(path.join(root, "artifacts"), { recursive: true });
      await writeFile(path.join(root, "artifacts/failure.png"), Buffer.from(shot.data, "base64"));
    } catch { /* browser may already be gone */ }
  }
  console.error(error);
  if (stderr) console.error(stderr);
  process.exitCode = 1;
} finally {
  if (cdp) {
    await cdp.send("Browser.close").catch(() => {});
    cdp.ws.close();
  }
  if (chromeProcess && chromeProcess.exitCode === null) {
    chromeProcess.kill("SIGTERM");
    await until(() => chromeProcess.exitCode !== null || chromeProcess.signalCode !== null, "Chrome shutdown", 5000).catch(() => chromeProcess.kill("SIGKILL"));
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
if (!passed) process.exitCode = 1;
