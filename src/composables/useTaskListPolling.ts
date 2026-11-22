import { useOverviewPolling } from "./useOverviewPolling";

/**
 * 任务单列表轮询（D8/批6）：不写第二套退避/页签/横幅逻辑，直接包 useOverviewPolling——
 * 15s 间隔、document.hidden 暂停、keep-alive 失活停表、失败指数退避（上限 30s）、
 * 静默刷新不置 loading（不抢骨架）、updatedAt/error 给页头 FreshnessMeta 与失败横幅。
 *
 * 比总览多一个「按页签条件轮询」：enabled() 为假（已结束/全部页签）时静默轮跳过——
 * 不发请求、不更新时间戳（load 返回 false 即丢弃口径），定时器空转无网络开销。
 * 手动 refresh()（切页签/改筛选/重试/推进后）不受 enabled 限制：任何页签都要立即取数。
 */
export function useTaskListPolling(
  load: () => Promise<boolean | void>,
  options: { interval?: number; enabled?: () => boolean } = {}
) {
  const { interval = 15000, enabled = () => true } = options;
  let manual = false;
  const polling = useOverviewPolling(async () => {
    const skip = !manual && !enabled();
    manual = false;
    if (skip) return false;
    return load();
  }, interval);
  return {
    ...polling,
    refresh: () => {
      manual = true;
      return polling.refresh();
    },
  };
}
