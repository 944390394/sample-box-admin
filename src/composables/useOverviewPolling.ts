import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from "vue";

/**
 * 总览页轮询：固定间隔刷新，页面在后台时暂停、回到前台立即补一次；
 * 被 keep-alive 缓存（切去别的页签）时同样暂停、重新激活时恢复，
 * 避免后台页签继续轮询、甚至触发单单位自动跳转把用户从当前页面拽回去；
 * 失败按指数退避（最长 30 秒），成功回到正常间隔。数据过期由页面用 updatedAt + error 展示。
 * load 返回 false 表示这次结果被丢弃（比如切换单位后旧请求才回来），不更新时间戳。
 */
export function useOverviewPolling(load: () => Promise<boolean | void>, interval = 5000) {
  const updatedAt = ref<Date | null>(null);
  const error = ref("");
  /** 失败的业务码（如 A0404 单位不存在/不在范围），页面按码渲染友好错态而不是只留重试。 */
  const errorCode = ref("");
  const loading = ref(false);

  let timer = 0;
  let delay = interval;
  let inflight = false;
  let stopped = false;
  /** keep-alive 缓存中（不是当前页签）：暂停轮询，重新激活时恢复。 */
  let deactivated = false;

  function schedule() {
    window.clearTimeout(timer);
    if (stopped || deactivated) return;
    timer = window.setTimeout(() => {
      if (document.hidden) schedule();
      else void run();
    }, delay);
  }

  async function run(manual = false) {
    if (stopped || deactivated || (inflight && !manual)) return;
    inflight = true;
    if (manual || !updatedAt.value) loading.value = true;
    try {
      const applied = await load();
      if (applied !== false) {
        updatedAt.value = new Date();
        error.value = "";
        errorCode.value = "";
        delay = interval;
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      errorCode.value = (e as { code?: string } | null)?.code ?? "";
      delay = Math.min(delay * 2, 30000);
    } finally {
      inflight = false;
      loading.value = false;
      schedule();
    }
  }

  function onVisible() {
    if (!document.hidden && !stopped && !deactivated) void run();
  }

  onMounted(() => {
    document.addEventListener("visibilitychange", onVisible);
    void run(true);
  });
  onActivated(() => {
    deactivated = false;
    if (updatedAt.value) void run();
  });
  // 多页签 keep-alive：切走的页签只是失活不是卸载，必须停表，
  // 否则缓存页每 5s 继续 load()，单单位自动 replace 会把人拽回总览（P2 延迟回环）。
  onDeactivated(() => {
    deactivated = true;
    window.clearTimeout(timer);
  });
  onBeforeUnmount(() => {
    stopped = true;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  });

  return { updatedAt, error, errorCode, loading, refresh: () => run(true) };
}
