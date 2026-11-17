import type { App } from "vue";
import { AuthStorage } from "@/utils/auth";

interface Diagnostic {
  message: string;
  kind?: string;
  stack?: string;
  path?: string;
  method?: string;
  duration?: number;
  requestId?: string;
  status?: number;
  code?: string;
}
const recent = new Map<string, number>();
let minute = 0,
  sent = 0;
/** 独立 fetch，禁止经过请求拦截器，采集失败不递归上报。 */
export function reportDiagnostic(entry: Diagnostic) {
  try {
    if (
      import.meta.env.VITE_MOCK_DEV_SERVER === "true" ||
      entry.path?.includes("/system/runtime-logs")
    )
      return;
    const token = AuthStorage.getAccessToken();
    if (!token) return;
    const now = Date.now(),
      windowId = Math.floor(now / 60000);
    if (windowId !== minute) {
      minute = windowId;
      sent = 0;
      recent.clear();
    }
    if (sent >= 20) return;
    const key = `${entry.kind}|${entry.path}|${entry.message}`;
    if (now - (recent.get(key) || 0) < 10000) return;
    recent.set(key, now);
    sent++;
    // 不采集表单、请求正文、Cookie 和完整URL参数。
    const scrub = (s: string) =>
      s
        .replace(/Bearer\s+[^\s,;"']+/gi, "Bearer [已脱敏]")
        .replace(
          /((?:password|secret|token|cookie|authorization|api[_-]?key|tk|sk)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
          "$1[已脱敏]"
        )
        .replace(/(https?:\/\/[^\s?#]+)\?[^\s)]+/g, "$1?[已隐藏参数]");
    void fetch(`${import.meta.env.VITE_APP_BASE_API || ""}/api/v1/system/runtime-logs/client`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        ...entry,
        message: scrub(entry.message).slice(0, 2000),
        stack: scrub(entry.stack || "").slice(0, 8000),
        path: (entry.path || location.hash.slice(1)).split(/[?#]/)[0].slice(0, 300),
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  } catch {
    /* 诊断不得干扰业务。 */
  }
}
export function setupDiagnostics(app: App) {
  app.config.errorHandler = (error, _instance, info) => {
    const e = error instanceof Error ? error : new Error(String(error));
    reportDiagnostic({ kind: "vue", message: `${info}: ${e.message}`, stack: e.stack });
    console.error(error);
  };
  window.addEventListener(
    "error",
    (event: Event) => {
      if (event instanceof ErrorEvent)
        reportDiagnostic({ kind: "exception", message: event.message, stack: event.error?.stack });
      else if (
        event.target instanceof HTMLScriptElement ||
        event.target instanceof HTMLLinkElement
      ) {
        reportDiagnostic({
          kind: "resource",
          message: "页面脚本或样式加载失败",
          path: event.target instanceof HTMLScriptElement ? event.target.src : event.target.href,
        });
      }
    },
    true
  );
  window.addEventListener("unhandledrejection", (event) => {
    const e = event.reason;
    reportDiagnostic({ kind: "promise", message: e?.message || String(e), stack: e?.stack });
  });
}
