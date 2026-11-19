import { ref } from "vue";
import SettingsAPI from "@/api/system/settings";

/**
 * 划拨/送检功能开关 + 建单后未上线离线宽限（秒），全站共享一份。
 *
 * 这两项由服务端 GET /system/settings 的 box 块下发（publicBox 对所有登录用户恒返回，
 * 不需要设置页权限）。以前预览页把宽限写死成「1 小时」/ OV.grace.min=60，这里改成服务端驱动：
 * 设置页改分钟 → 存秒 → 这里读秒，boxes/首页的待上线徽标与离线判定随之变。
 *
 * 模块级缓存：一个会话只取一次；设置页保存后调 loadBoxFeatures(true) 强制刷新。
 */
const enableTransferInspect = ref(false);
const taskOfflineGraceSec = ref(3600);
const loaded = ref(false);
let pending: Promise<void> | null = null;

export async function loadBoxFeatures(force = false): Promise<void> {
  if (loaded.value && !force) return;
  if (pending) return pending;
  pending = (async () => {
    try {
      const settings = await SettingsAPI.get();
      enableTransferInspect.value = Boolean(settings.box?.enableTransferInspect);
      const grace = Number(settings.box?.taskOfflineGraceSec);
      taskOfflineGraceSec.value = Number.isFinite(grace) && grace > 0 ? grace : 3600;
      loaded.value = true;
    } catch {
      /* 取不到就按默认（关 / 3600s），不阻塞页面 */
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** 设置页保存成功后调用，让全站徽标/菜单立刻按新值走。 */
export function refreshBoxFeatures(): Promise<void> {
  return loadBoxFeatures(true);
}

export function useBoxFeatures() {
  return { enableTransferInspect, taskOfflineGraceSec, loaded, loadBoxFeatures };
}
