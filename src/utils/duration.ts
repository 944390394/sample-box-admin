/**
 * 上报周期时长换算（R14 时分秒联动）。
 *
 * 存储口径不变：总秒数整数（服务端校验 5–3600 秒），这里只负责显示与输入换算。
 * 零依赖纯函数：DurationInput.vue 与 server/test/duration-input.test.js 共用
 * （node type-stripping 直导 .ts，无需解析 hooks）。
 */

/** 归一后的时/分/秒分量（秒/分恒 0–59，时不限但受总量 max 约束）。 */
export interface DurationParts {
  hours: number;
  minutes: number;
  seconds: number;
}

export type DurationPartKey = keyof DurationParts;

/** 快捷 chips（按调用点 min/max 过滤；默认 5–3600 时 8 枚全在）。 */
export const DURATION_CHIPS: readonly { value: number; label: string }[] = [
  { value: 5, label: "5 秒" },
  { value: 30, label: "30 秒" },
  { value: 60, label: "1 分钟" },
  { value: 300, label: "5 分钟" },
  { value: 600, label: "10 分钟" },
  { value: 900, label: "15 分钟" },
  { value: 1800, label: "30 分钟" },
  { value: 3600, label: "1 小时" },
];

/** 取非负整秒：非法/负数/小数一律落到 0（分量输入兜底）。 */
function wholeSeconds(value: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 总秒数 → 时/分/秒（自动进位归一）。
 * 90 秒 → 0时1分30秒；3661 秒 → 1时1分1秒。
 */
export function splitDuration(totalSeconds: number): DurationParts {
  const t = wholeSeconds(totalSeconds);
  return {
    hours: Math.floor(t / 3600),
    minutes: Math.floor((t % 3600) / 60),
    seconds: t % 60,
  };
}

/**
 * 时/分/秒 → 总秒数。分量允许超 59（如输入 90 秒、90 分），
 * 进位不在这里做——总量再经 splitDuration 归一显示。
 */
export function joinDuration(parts: DurationParts): number {
  return (
    wholeSeconds(parts.hours) * 3600 +
    wholeSeconds(parts.minutes) * 60 +
    wholeSeconds(parts.seconds)
  );
}

/** 总秒数 clamp 到 [min, max] 整数；非法值回落 min。 */
export function clampDuration(totalSeconds: number, min: number, max: number): number {
  const n = Math.round(Number(totalSeconds));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * 显示自适应归一：<60 秒写秒、<3600 写分秒、≥3600 写时分。
 * 30 → 「30 秒」；90 → 「1 分 30 秒」；3600 → 「1 时 0 分」。
 */
export function formatDuration(totalSeconds: number): string {
  const t = wholeSeconds(totalSeconds);
  if (t < 60) return `${t} 秒`;
  const { hours, minutes, seconds } = splitDuration(t);
  if (t < 3600) return `${minutes} 分 ${seconds} 秒`;
  return `${hours} 时 ${minutes} 分`;
}

/**
 * 灰字等值（编辑态）：恒含「＝ X 秒」（存储口径，验收锚点），
 * ≥60 秒附自适应归一括号：「＝ 90 秒（1 分 30 秒）」「＝ 3600 秒（1 时 0 分）」。
 */
export function durationEquals(totalSeconds: number): string {
  const t = wholeSeconds(totalSeconds);
  return t < 60 ? `＝ ${t} 秒` : `＝ ${t} 秒（${formatDuration(t)}）`;
}

/** 快捷 chips 过滤：min ≤ value ≤ max（范围外的快捷值不出现）。 */
export function durationChips(min: number, max: number): { value: number; label: string }[] {
  return DURATION_CHIPS.filter((chip) => chip.value >= min && chip.value <= max);
}

/**
 * 单个分量变更 → 应 emit 的新总秒数（先合量、再 clamp）。
 * clamped=true 表示输入超出 [min, max] 被自动调整（组件据此弹范围 tooltip）。
 * 分量清空（null/NaN）由组件侧忽略，不进这里。
 */
export function applyDurationPart(
  parts: DurationParts,
  key: DurationPartKey,
  value: number,
  min: number,
  max: number
): { total: number; clamped: boolean } {
  const raw = joinDuration({ ...parts, [key]: value });
  const total = clampDuration(raw, min, max);
  return { total, clamped: total !== raw };
}
