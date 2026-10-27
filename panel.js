// UI for a single RequestCatcher session (the active tab's), driven entirely by `state`
// pushed from the background service worker over `port`. No element here ever receives
// attacker-controlled data through innerHTML — only .value/.textContent, so hostile
// request bodies/headers/URLs shown in the editor cannot execute as markup.
const $ = (id) => document.getElementById(id);
const setDisabled = (ids, disabled) => { for (const id of ids) $(id).disabled = disabled; };
const ACTIVE = ["preparing", "armed", "waiting", "paused", "sending", "stopping", "attached-error"];
const LABELS = { idle: "ГОТОВ К ПЕРЕХВАТУ", preparing: "ПОДКЛЮЧЕНИЕ", armed: "ОЖИДАЮ КЛИК", waiting: "ОЖИДАЮ ЗАПРОС", paused: "ЗАПРОС НА ПАУЗЕ", sending: "ОТПРАВКА", stopping: "ЗАВЕРШЕНИЕ", "attached-error": "ОТЛАДЧИК ЕЩЁ ПОДКЛЮЧЁН", done: "ПЕРЕХВАТ ЗАВЕРШЁН", error: "ПЕРЕХВАТ ОСТАНОВЛЕН" };
const port = chrome.runtime.connect({ name: "request-catcher-panel" });
const replies = new Map();
const drafts = new Map();
let counter = 0;
let currentTabId;
let currentWindowId;
let state;
let displayedRequestId;
let connected = true;
let bodyWasLoading = false;
let refreshVersion = 0;

function rpc(type, extra = {}) {
  if (!connected) return Promise.reject(new Error("Связь с расширением прервана. Переоткройте панель."));
  return new Promise((resolve, reject) => {
    const id = ++counter;
    replies.set(id, { resolve, reject });
    port.postMessage({ id, type, tabId: currentTabId, ...extra });
  });
}

function showError(error) {
  $("error").textContent = error?.message || String(error);
  $("error").hidden = false;
}
function clearError() { $("error").hidden = true; }

function readDraft() {
  return {
    method: $("method").value, url: $("url").value, headers: $("headers").value,
    body: $("body").value, replaceBody: $("replace-body").checked, encoding: $("encoding").value,
  };
}
function saveDraft() {
  if (displayedRequestId && !state?.request?.loading) drafts.set(displayedRequestId, readDraft());
}
function showDraft(draft) {
  $("method").value = draft.method;
  $("url").value = draft.url;
  $("headers").value = draft.headers;
  $("body").value = draft.body;
  $("replace-body").checked = !!draft.replaceBody;
  $("encoding").value = draft.encoding;
  updateBodyControls();
}
function updateBodyControls() {
  const replace = $("replace-body").checked;
  $("body").readOnly = !replace;
  $("encoding").disabled = !replace;
  $("format-json").disabled = !replace || $("encoding").value !== "utf8";
  $("body-size").textContent = `${new TextEncoder().encode($("body").value).length.toLocaleString("ru-RU")} байт в редакторе`;
  $("header-count").textContent = $("headers").value.split("\n").filter((line) => line.trim()).length;
}

function render(next) {
  if (!next.request && !["preparing", "armed", "waiting"].includes(next.phase)) {
    for (const key of drafts.keys()) if (key.startsWith(`${next.tabId}/`)) drafts.delete(key);
  }
  if (next.tabId !== currentTabId) return;
  state = next;
  const active = ACTIVE.includes(state.phase);
  const editing = ["paused", "sending"].includes(state.phase) && !!state.request;
  const busy = state.phase === "sending" || state.request?.loading;
  $("status-label").textContent = LABELS[state.phase] || state.phase;
  $("status-message").textContent = state.message;
  $("status-dot").className = `status-dot ${["armed", "waiting", "preparing"].includes(state.phase) ? "active" : ""} ${editing ? "paused" : ""}`;
  $("request-kind").hidden = !editing;
  $("request-kind").textContent = state.request?.resourceType || "";
  $("setup").hidden = editing;
  $("editor").hidden = !editing;
  $("arm").hidden = active;
  $("stop").hidden = !active;
  $("stop").disabled = ["preparing", "sending", "stopping"].includes(state.phase);
  setDisabled(["trigger", "types", "wait", "url-filter"], active);
  setDisabled(["send", "send-original", "reset", "cancel", "replace-body", "method", "url", "headers"], !!busy);
  $("body").readOnly = !!busy || !$("replace-body").checked;
  if (editing) {
    if (displayedRequestId !== state.request.id) {
      displayedRequestId = state.request.id;
      showDraft(drafts.get(displayedRequestId) || state.request);
      selectEditorTab("headers");
    } else if (bodyWasLoading && !state.request.loading) {
      const draft = drafts.get(displayedRequestId);
      showDraft(draft ? { ...draft, body: state.request.body, encoding: state.request.encoding } : state.request);
    }
    bodyWasLoading = !!state.request.loading;
    $("request-help").textContent = !state.request.loading && !state.request.body && !state.request.bodyWarning && ["GET", "HEAD"].includes(state.request.method)
      ? `У этого ${state.request.method}-запроса нет тела — правьте URL и заголовки.`
      : "Правьте заголовки и тело во вкладках ниже; замена тела включается отдельно.";
    $("body-warning").hidden = !state.request.bodyWarning;
    $("body-warning").textContent = state.request.bodyWarning;
  } else {
    displayedRequestId = null;
    bodyWasLoading = false;
    // Clear sensitive drafts and DOM values as soon as a request is finished.
    for (const key of drafts.keys()) if (key.startsWith(`${currentTabId}/`)) drafts.delete(key);
    for (const id of ["method", "url", "headers", "body"]) $(id).value = "";
  }
}

function selectEditorTab(name) {
  for (const tab of ["headers", "body"]) {
    $("tab-" + tab).classList.toggle("selected", tab === name);
    $("tab-" + tab).setAttribute("aria-pressed", String(tab === name));
    $(tab + "-pane").hidden = tab !== name;
  }
}

async function refreshTab() {
  const version = ++refreshVersion;
  const [tab] = await chrome.tabs.query({ active: true, windowId: currentWindowId });
  if (!tab || version !== refreshVersion) return;
  saveDraft();
  currentTabId = tab.id;
  displayedRequestId = null;
  clearError();
  $("tab-title").textContent = tab.title || "Текущая вкладка";
  try { $("tab-host").textContent = new URL(tab.url).host; } catch { $("tab-host").textContent = ""; }
  const result = await rpc("state");
  render(result);
}

port.onMessage.addListener((message) => {
  if (message.type === "state") {
    // Prefix IDs with tabId because CDP request IDs can be reused across tabs.
    if (message.state.request) message.state.request.id = `${message.state.tabId}/${message.state.request.id}`;
    render(message.state);
  } else if (message.type === "reply") {
    const pending = replies.get(message.id);
    if (!pending) return;
    replies.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else {
      if (message.state?.request) message.state.request.id = `${message.state.tabId}/${message.state.request.id}`;
      pending.resolve(message.state);
    }
  }
});
port.onDisconnect.addListener(() => {
  connected = false;
  for (const pending of replies.values()) pending.reject(new Error("Связь с расширением прервана."));
  replies.clear();
  drafts.clear();
  for (const id of ["method", "url", "headers", "body"]) $(id).value = "";
  displayedRequestId = null;
  state = null;
  $("editor").hidden = true;
  $("setup").hidden = false;
  document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  showError(new Error("Расширение перезагружено или отключено. Закройте и снова откройте панель."));
});

$("arm").addEventListener("click", async () => {
  clearError();
  $("arm").disabled = true;
  try {
    render(await rpc("arm", { options: { trigger: $("trigger").value, types: $("types").value, waitSeconds: Number($("wait").value), urlFilter: $("url-filter").value } }));
  } catch (error) { showError(error); }
  finally { $("arm").disabled = false; }
});
$("trigger").addEventListener("change", () => {
  const clickMode = $("trigger").value === "click";
  $("arm").textContent = clickMode ? "⌖ Перехватить следующий клик" : "⌖ Включить перехват";
  $("capture-hint").textContent = clickMode
    ? "Дождитесь статуса «ОЖИДАЮ КЛИК» и нажмите нужную кнопку на сайте."
    : "Включите перехват и выполните действие на сайте — запрос остановится перед отправкой.";
});
for (const id of ["stop", "cancel"]) $(id).addEventListener("click", async () => {
  clearError();
  try { render(await rpc("stop")); } catch (error) { showError(error); }
});
for (const [id, original] of [["send", false], ["send-original", true]]) {
  $(id).addEventListener("click", async () => {
    clearError();
    saveDraft();
    try {
      const requestId = state.request.id.slice(String(currentTabId).length + 1);
      render(await rpc("send", { requestId, original, draft: readDraft() }));
    } catch (error) { showError(error); }
  });
}
$("reset").addEventListener("click", () => {
  clearError();
  drafts.delete(displayedRequestId);
  showDraft(state.request);
});
for (const id of ["method", "url", "headers", "body", "replace-body", "encoding"]) {
  $(id).addEventListener("input", () => { updateBodyControls(); saveDraft(); });
}
$("format-json").addEventListener("click", () => {
  clearError();
  try {
    $("body").value = JSON.stringify(JSON.parse($("body").value), null, 2);
    updateBodyControls();
    saveDraft();
  } catch { showError(new Error("Тело не является корректным JSON.")); }
});
for (const tab of ["headers", "body"]) $("tab-" + tab).addEventListener("click", () => selectEditorTab(tab));
chrome.tabs.onActivated.addListener(({ windowId }) => { if (windowId === currentWindowId) void refreshTab().catch(showError); });
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === currentTabId && (info.title || info.url)) void refreshTab().catch(showError);
});
try {
  currentWindowId = (await chrome.windows.getCurrent()).id;
  await refreshTab();
} catch (error) { showError(error); }
