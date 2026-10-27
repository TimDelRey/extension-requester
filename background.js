import { RequestCatcher } from "./src/catcher.js";
import { PanelBridge } from "./src/panel-bridge.js";

const catcher = new RequestCatcher(chrome);
const bridge = new PanelBridge(chrome, catcher);
catcher.onChange = (state, owner) => {
  bridge.publish(state, owner);
  const text = { preparing: "…", armed: "CLK", waiting: "…", paused: "1", sending: "…" }[state.phase] || "";
  void chrome.action.setBadgeText({ tabId: state.tabId, text }).catch(() => {});
  void chrome.action.setBadgeBackgroundColor({ tabId: state.tabId, color: state.phase === "paused" ? "#ffbd69" : "#86e8c7" }).catch(() => {});
};

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onConnect.addListener((port) => bridge.connect(port));

chrome.debugger.onEvent.addListener((source, method, params) => {
  const session = catcher.sessions.get(source.tabId);
  void catcher.onEvent(source, method, params).catch((error) => {
    // CDP errors can contain request data; never write their payloads to logs.
    console.error("Request Catcher: protocol operation failed.");
    if (session) void catcher.stop(source.tabId, "error", "Ошибка протокола. Перехват остановлен.", session).catch(() => {});
  });
});
chrome.debugger.onDetach.addListener((source, reason) => catcher.onDetach(source, reason));
chrome.tabs.onRemoved.addListener((tabId) => {
  const session = catcher.sessions.get(tabId);
  if (!session) return;
  // Route through the normal teardown (fails the paused request, detaches cleanly)
  // instead of dropping the session map entry directly; the tab is gone either way,
  // so the entry is removed once teardown settles, whatever the outcome.
  void catcher.stop(tabId, undefined, undefined, session).catch(() => {}).finally(() => {
    if (catcher.sessions.get(tabId) === session) catcher.sessions.delete(tabId);
  });
});
