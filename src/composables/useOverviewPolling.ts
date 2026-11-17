import { onActivated, onBeforeUnmount, onMounted, ref } from "vue";

/**
 * 总览页轮询：固定间隔刷新，页面在后台时暂停、回到前台立即补一次；
 * 失败按指数退避（最长 30 秒），成功回到正常间隔。数据过期由页面用 updatedAt + error 展示。
 * load 返回 false 表示这次结果被丢弃（比如切换单位后旧请求才回来），不更新时间戳。
 */
export function useOverviewPolling(load: () => Promise<boolean | void>, interval = 5000) {
  const updatedAt = ref<Date | null>(null);
  const error = ref("");
  const loading = ref(false);

  let timer = 0;
  let delay = interval;
  let inflight = false;
  let stopped = false;

  function schedule() {
    window.clearTimeout(timer);
    if (stopped) return;
    timer = window.setTimeout(() => {
      if (document.hidden) schedule();
      else void run();
    }, delay);
  }

  async function run(manual = false) {
    if (stopped || (inflight && !manual)) return;
    inflight = true;
    if (manual || !updatedAt.value) loading.value = true;
    try {
      const applied = await load();
      if (applied !== false) {
        updatedAt.value = new Date();
        error.value = "";
        delay = interval;
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      delay = Math.min(delay * 2, 30000);
    } finally {
      inflight = false;
      loading.value = false;
      schedule();
    }
  }

  function onVisible() {
    if (!document.hidden && !stopped) void run();
  }

  onMounted(() => {
    document.addEventListener("visibilitychange", onVisible);
    void run(true);
  });
  onActivated(() => {
    if (updatedAt.value) void run();
  });
  onBeforeUnmount(() => {
    stopped = true;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  });

  return { updatedAt, error, loading, refresh: () => run(true) };
}
