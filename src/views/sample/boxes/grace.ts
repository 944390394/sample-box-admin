import { clock, fullTime, shortTime, toDate } from "@/utils/time";

/**
 * 建单后未上线的离线宽限徽标（B3/#18，文案基准 reports/plan-transfer-inspect.md §7.2）。
 *
 * 适用对象：被未结束任务占用（boundTaskAt 非空）且从未上报（last 为空）的箱子，含仍显示「待激活」的。
 * 判定与服务端 flagMatch / onlineSql 同口径：now − 建单时间 > graceSec 才计离线（严格大于），
 * 宽限内是中性「待上线」，不算离线。一旦有过上报就回落既有「超过 3 个上报周期」口径（这里返回 null）。
 * 划拨占用不适用：服务端不给划拨箱写 bound_task，boundTaskAt 为空 → 返回 null。
 *
 * 宽限阈值 graceSec 由服务端设置下发（useBoxFeatures），不在前端写死「1 小时」。
 */

/** 时长文案：<60 分钟按分钟、<1440 分钟按小时、否则按天（与预览 graceDur 同口径）。 */
export function graceDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时`;
  return `${Math.round(minutes / 1440)} 天`;
}

export interface GraceState {
  /** 超宽限 → 计离线（warn）；宽限内 → 中性待上线（neutral）。 */
  over: boolean;
  minutes: number;
  /** 状态格文案：宽限内「建单后 X，尚未上线」/ 超宽限「建单后 X未上线」。 */
  text: string;
  /** 绝对时间 MM-DD HH:mm。 */
  abs: string;
  /** 完整时间，给 title。 */
  full: string;
}

export function graceState(
  boundTaskAt: string | null | undefined,
  last: string | null | undefined,
  graceSec: number,
  now: number = clock.value
): GraceState | null {
  if (last) return null;
  const at = toDate(boundTaskAt);
  if (!at) return null;
  const elapsedMs = Math.max(0, now - at.getTime());
  const minutes = elapsedMs / 60000;
  const over = elapsedMs > graceSec * 1000;
  const dur = graceDuration(minutes);
  return {
    over,
    minutes,
    text: over ? `建单后 ${dur}未上线` : `建单后 ${dur}，尚未上线`,
    abs: shortTime(boundTaskAt),
    full: fullTime(boundTaskAt),
  };
}

/** 离线卡 hint 的第二情形：「或建单后 {宽限时长}未上线」。 */
export function graceHint(graceSec: number): string {
  return `或建单后 ${graceDuration(graceSec / 60)}未上线`;
}
