import { buildOverride, formatHeaders, matchesRequest, readBody } from "./request.js";

// One RequestCatcher instance runs in the background service worker and owns every
// per-tab interception session. A session moves through:
//   idle -> preparing -> armed (waiting for a trusted click) -> waiting (for a matching
//   request) -> paused (held for review/edit) -> sending -> done/error
// Only one request is ever held at a time per tab, and only the owning panel (a
// chrome.runtime.Port, checked in PanelBridge) may read or act on it.
const WORLD = "request-catcher-isolated";
const BINDING = "__requestCatcherClick";
const CLICK_SCRIPT = `(() => {
  globalThis.__requestCatcherCleanup?.();
  const handler = (event) => {
    if (event.isTrusted && typeof globalThis.${BINDING} === 'function') {
      globalThis.${BINDING}(JSON.stringify({ type: 'click' }));
    }
  };
  window.addEventListener('click', handler, { capture: true, passive: true });
  globalThis.__requestCatcherCleanup = () => {
    window.removeEventListener('click', handler, true);
    delete globalThis.__requestCatcherCleanup;
  };
})();`;

export class RequestCatcher {
  constructor(api, onChange = () => {}) {
    this.api = api;
    this.onChange = onChange;
    this.sessions = new Map();
  }

  state(tabId) {
    const session = this.sessions.get(tabId);
    if (!session) return { tabId, phase: "idle", message: "Готов к перехвату", request: null };
    return {
      tabId, phase: session.phase, message: session.message, request: session.request,
      options: session.options, clickedAt: session.clickedAt,
    };
  }

  publish(session) {
    if (this.sessions.get(session.tabId) === session) this.onChange(this.state(session.tabId), session.owner);
  }
  command(source, method, params = {}) { return this.api.debugger.sendCommand(source, method, params); }

  async arm(tabId, options, owner) {
    const previous = this.sessions.get(tabId);
    if (previous && (previous.attached || ["preparing", "stopping"].includes(previous.phase))) {
      throw new Error("Сначала завершите текущий перехват.");
    }
    if (!["click", "next"].includes(options?.trigger) || !["api", "all"].includes(options?.types) ||
        typeof options.urlFilter !== "string" || ![3, 10, 30].includes(options.waitSeconds)) {
      throw new Error("Некорректные настройки перехвата.");
    }
    const tab = await this.api.tabs.get(tabId);
    if (tab.url && !/^https?:\/\//i.test(tab.url)) {
      throw new Error("Откройте обычный HTTP(S) сайт. На служебных страницах Chrome перехват недоступен.");
    }
    // Check again after tabs.get: two panel messages must not attach twice.
    if (this.sessions.get(tabId) !== previous) throw new Error("Перехват уже запускается.");
    const session = {
      id: crypto.randomUUID(),
      tabId, owner, options: { ...options, urlFilter: options.urlFilter.trim() },
      phase: "preparing", message: "Подключение к вкладке…", attached: false,
      targets: new Map(), setupTasks: new Set(), request: null, pending: null, timer: null,
      pageOrigin: tab.url ? new URL(tab.url).origin : null,
    };
    this.sessions.set(tabId, session);
    this.publish(session);
    try {
      session.attachPromise = this.api.debugger.attach({ tabId }, "1.3").then(() => { session.attached = true; });
      await session.attachPromise;
      if (session.phase !== "preparing") throw new Error("Запуск перехвата отменён.");
      await this.setupTarget(session, { tabId }, true);
      if (session.phase !== "preparing") throw new Error("Запуск перехвата отменён.");
      if (options.trigger === "next") this.startWaiting(session);
      else {
        session.phase = "armed";
        session.message = "Нажмите нужную кнопку на странице в течение 60 секунд";
        session.timer = setTimeout(() => {
          void this.stop(tabId, "done", "Время ожидания клика истекло. Перехват выключен.", session).catch(() => {});
        }, 60_000);
        this.publish(session);
      }
    } catch (error) {
      await this.stop(tabId, "error", "Не удалось начать перехват. Проверьте страницу и другие подключения отладчика.", session);
      throw error;
    }
  }

  async setupTarget(session, source, isPage) {
    const task = this.initializeTarget(session, source, isPage);
    session.setupTasks.add(task);
    try { await task; } finally { session.setupTasks.delete(task); }
  }

  async initializeTarget(session, source, isPage) {
    const command = (method, params) => {
      if (this.sessions.get(session.tabId) !== session || !session.attached ||
          !["preparing", "armed", "waiting", "paused", "sending"].includes(session.phase)) {
        throw new Error("Запуск перехвата отменён.");
      }
      return this.command(source, method, params);
    };
    const target = { source, contexts: new Set(), scriptId: null };
    session.targets.set(source.sessionId || "root", target);
    if (isPage) {
      await command("Page.enable");
      const { frameTree } = await command("Page.getFrameTree");
      if (!source.sessionId) {
        const pageURL = new URL(frameTree.frame.url);
        if (!["http:", "https:"].includes(pageURL.protocol) || (session.pageOrigin && session.pageOrigin !== pageURL.origin)) {
          throw new Error("Страница изменилась или недоступна для перехвата.");
        }
        session.pageOrigin = pageURL.origin;
      }
      await command("Runtime.addBinding", { name: BINDING, executionContextName: WORLD });
      await command("Runtime.enable");
      const script = await command("Page.addScriptToEvaluateOnNewDocument", {
        source: CLICK_SCRIPT, worldName: WORLD,
      });
      target.scriptId = script.identifier;
      const inject = async (frame) => {
        const { executionContextId } = await command("Page.createIsolatedWorld", {
          frameId: frame.frame.id, worldName: WORLD,
        });
        target.contexts.add(executionContextId);
        const result = await command("Runtime.evaluate", { expression: CLICK_SCRIPT, contextId: executionContextId });
        if (result.exceptionDetails) throw new Error("Не удалось установить обработчик клика.");
      };
      // Failure in a disappearing child frame must not break the main page.
      await inject(frameTree);
      const descendants = [];
      const walk = (frame) => { for (const child of frame.childFrames || []) { descendants.push(child); walk(child); } };
      walk(frameTree);
      await Promise.allSettled(descendants.map(inject));
    }
    await command("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    await command("Target.setAutoAttach", {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
      filter: [{ type: "iframe", exclude: false }, { type: "worker", exclude: false }],
    });
  }

  startWaiting(session) {
    session.phase = "waiting";
    session.clickedAt = Date.now();
    session.message = `Ожидаю запрос · ${session.options.waitSeconds} с`;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      void this.stop(session.tabId, "done", "Подходящий запрос не появился. Попробуйте другой фильтр или режим.", session).catch(() => {});
    }, session.options.waitSeconds * 1000);
    this.publish(session);
  }

  async onEvent(source, method, params) {
    const session = this.sessions.get(source.tabId);
    if (!session?.attached) return;
    if (method === "Page.frameNavigated" && !source.sessionId && !params.frame.parentId && session.pageOrigin) {
      let origin;
      try { origin = new URL(params.frame.url).origin; } catch { origin = null; }
      if (origin !== session.pageOrigin) {
        await this.stop(session.tabId, "done", "Страница перешла на другой origin. Перехват выключен.", session);
      }
    } else if (method === "Runtime.executionContextCreated" && params.context.name === WORLD) {
      session.targets.get(source.sessionId || "root")?.contexts.add(params.context.id);
    } else if (method === "Runtime.executionContextDestroyed") {
      session.targets.get(source.sessionId || "root")?.contexts.delete(params.executionContextId);
    } else if (method === "Runtime.executionContextsCleared") {
      session.targets.get(source.sessionId || "root")?.contexts.clear();
    } else if (method === "Runtime.bindingCalled" && params.name === BINDING && session.phase === "armed") {
      const target = session.targets.get(source.sessionId || "root");
      if (target?.contexts.has(params.executionContextId) && params.payload === '{"type":"click"}') this.startWaiting(session);
    } else if (method === "Target.attachedToTarget" && ["preparing", "armed", "waiting", "paused", "sending"].includes(session.phase)) {
      const child = { tabId: source.tabId, sessionId: params.sessionId };
      try { await this.setupTarget(session, child, params.targetInfo.type === "iframe"); }
      catch {
        // A target may disappear during initialization. A live failed target is detached.
        await this.command(source, "Target.detachFromTarget", { sessionId: params.sessionId }).catch(() => {});
        session.targets.delete(params.sessionId);
      }
    } else if (method === "Target.detachedFromTarget") {
      session.targets.delete(params.sessionId);
      if (session.pending?.source.sessionId === params.sessionId) {
        await this.stop(session.tabId, "error", "Фрейм с задержанным запросом был закрыт.", session);
      }
    } else if (method === "Fetch.requestPaused") {
      await this.onPaused(session, source, params);
    }
  }

  async onPaused(session, source, params) {
    if (session.phase !== "waiting" || !matchesRequest(params, session.options)) {
      await this.command(source, "Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
      return;
    }
    // Claim synchronously before reading the body: only one request can be captured.
    session.phase = "paused";
    clearTimeout(session.timer);
    session.pending = { source, requestId: params.requestId };
    session.request = {
      id: `${session.id}/${source.sessionId || "root"}:${params.requestId}`,
      url: params.request.url, method: params.request.method,
      headers: formatHeaders(params.request.headers), resourceType: params.resourceType,
      body: "", encoding: "utf8", bodyWarning: "", loading: true,
    };
    session.message = "Запрос остановлен до отправки. Просмотрите данные и выберите: отправить с изменениями, исходный или отменить.";
    this.publish(session);
    try {
      const body = await readBody(params.request);
      if (session.phase !== "paused" || session.pending?.requestId !== params.requestId) return;
      Object.assign(session.request, body, { loading: false });
    } catch {
      if (session.phase !== "paused") return;
      Object.assign(session.request, { loading: false, bodyWarning: "Не удалось прочитать тело. Исходные байты сохранятся без замены тела." });
    }
    this.publish(session);
  }

  async send(tabId, requestId, draft, original = false) {
    const session = this.sessions.get(tabId);
    if (session?.phase !== "paused" || session.request?.id !== requestId || session.request.loading) {
      throw new Error("Этот запрос уже недоступен для отправки.");
    }
    const override = original ? {} : buildOverride(session.request, draft);
    session.phase = "sending";
    session.message = "Продолжаю отправку…";
    this.publish(session);
    try {
      await this.command(session.pending.source, "Fetch.continueRequest", {
        requestId: session.pending.requestId, ...override,
      });
    } catch (error) {
      if (session.attached && session.phase === "sending") {
        session.phase = "paused";
        session.message = "Chrome отклонил изменение. Запрос остаётся на паузе: проверьте URL, метод и заголовки.";
        this.publish(session);
      }
      throw error;
    }
    if (session.phase !== "sending" || this.sessions.get(tabId) !== session) return;
    session.pending = null;
    await this.stop(tabId, "done", original ? "Исходный запрос передан Chrome для отправки." : "Запрос передан Chrome с вашими изменениями.", session);
  }

  async stop(tabId, phase = "done", message = "Перехват выключен. Задержанный запрос отменён.", expectedSession) {
    const session = this.sessions.get(tabId);
    if (!session || (expectedSession && session !== expectedSession)) return;
    if (session.stopPromise) return session.stopPromise;
    session.phase = "stopping";
    clearTimeout(session.timer);
    this.publish(session);
    session.stopPromise = (async () => {
      // Do not allow a new capture until a late attach/setup has actually settled.
      await session.attachPromise?.catch(() => {});
      await Promise.allSettled([...session.setupTasks]);
      if (session.attached) {
        if (session.pending) {
          try {
            await this.command(session.pending.source, "Fetch.failRequest", {
              requestId: session.pending.requestId, errorReason: "Aborted",
            });
          } catch {
            if (session.attached) {
              // Detaching now could release the original request. Keep control instead.
              session.phase = "paused";
              if (session.request?.loading) {
                session.request.loading = false;
                session.request.bodyWarning = "Чтение тела было прервано отменой. Без замены сохраняются исходные байты.";
              }
              session.message = "Chrome не подтвердил отмену. Перехват сохранён: повторите отмену или закройте вкладку.";
              this.publish(session);
              throw new Error(session.message);
            }
          }
          session.pending = null;
          session.request = null;
        }
        await Promise.allSettled([...session.targets.values()].map(async (target) => {
          if (target.scriptId) {
            await this.command(target.source, "Page.removeScriptToEvaluateOnNewDocument", { identifier: target.scriptId }).catch(() => {});
            await Promise.allSettled([...target.contexts].map((contextId) => this.command(target.source, "Runtime.evaluate", {
              contextId, expression: "globalThis.__requestCatcherCleanup?.()",
            })));
          }
        }));
        // Detach releases all non-selected traffic and removes Fetch interception.
        try { await this.api.debugger.detach({ tabId }); }
        catch {
          if (session.attached) {
            session.phase = "attached-error";
            session.message = "Не удалось отключить отладчик. Повторите выключение перехвата.";
            this.publish(session);
            throw new Error(session.message);
          }
        }
      }
      session.attached = false;
      session.pending = null;
      session.request = null;
      session.targets.clear();
      session.options = undefined;
      session.clickedAt = undefined;
      session.pageOrigin = null;
      session.phase = phase;
      session.message = message;
      this.publish(session);
      session.owner = null;
    })();
    try { await session.stopPromise; } finally { session.stopPromise = null; }
  }

  onDetach(source, reason) {
    const session = this.sessions.get(source.tabId);
    if (!session) return;
    if (session.phase === "stopping") { session.attached = false; return; }
    if (!session.attached) return;
    clearTimeout(session.timer);
    session.attached = false;
    session.pending = null;
    session.request = null;
    session.targets.clear();
    session.options = undefined;
    session.clickedAt = undefined;
    session.pageOrigin = null;
    session.phase = "error";
    session.message = reason === "target_closed" ? "Вкладка закрыта." : "Chrome отключил отладчик. Перехват завершён; проверьте состояние запроса на странице.";
    this.publish(session);
    session.owner = null;
  }

  async releaseOwner(owner) {
    await Promise.allSettled([...this.sessions.values()]
      .filter((session) => session.owner === owner && (session.attached || session.phase === "preparing"))
      .map(async (session) => {
        try { await this.stop(session.tabId, undefined, undefined, session); }
        finally {
          // A new trusted panel can adopt an orphan if Chrome rejected cancellation.
          if (session.owner === owner) session.owner = null;
        }
      }));
  }
}
