/**
 * 估算总电量图的纯逻辑：范围换算、充电时段区间、按范围 LRU 缓存。
 * 与 BatteryCurve.vue 共用（node type-stripping 可直接单测，R14 duration.ts 先例）。
 * 充电绿段用区间数组渲染 markArea，不逐点画；缓存让范围切换即时回显上一次结果，
 * 后台再刷新（stale-while-revalidate），避免每次切换都等全量请求。
 */
import type { BatteryPoint } from "@/api/sample/box";

export type PresetKey = "1h" | "6h" | "24h" | "7d";

function pad(value: number, width = 2) {
  return String(value).padStart(width, "0");
}

export function stamp(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 预设范围：以 now 为终点往回 1/6/24/168 小时，秒级时间戳（服务端契约格式）。 */
export function presetRange(key: string, endMs = Date.now()): [string, string] {
  const end = new Date(endMs);
  const start = new Date(endMs);
  const hours = key === "1h" ? 1 : key === "6h" ? 6 : key === "24h" ? 24 : 24 * 7;
  start.setTime(end.getTime() - hours * 60 * 60 * 1000);
  return [stamp(start), stamp(end)];
}

export function onCharge(item: BatteryPoint | undefined) {
  return item?.charge === 1 || item?.charge === 2;
}

const toMs = (time: string) => Date.parse(time.replace(" ", "T"));

/**
 * 充电时段 → markArea 区间数组。边界保留：从段内第一个充电点画到最后一个充电点；
 * 空点（gap）截断区间，区间终点落在空点前一个真实点上，不把断线空档涂绿。
 */
export function chargeBands(points: BatteryPoint[]): Array<[{ xAxis: number }, { xAxis: number }]> {
  const bands: Array<[{ xAxis: number }, { xAxis: number }]> = [];
  let start: number | null = null;
  points.forEach((item, index) => {
    if (onCharge(item) && start == null) start = toMs(item.time);
    const ends = !onCharge(item) || item.gap || index === points.length - 1;
    if (start != null && ends) {
      const end = item.gap && index > 0 ? toMs(points[index - 1].time) : toMs(item.time);
      bands.push([{ xAxis: start }, { xAxis: end }]);
      start = null;
    }
  });
  return bands;
}

export interface SeriesCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(): void;
  readonly size: number;
}

/** 按范围键的 LRU 缓存：get 命中即提升热度，超出上限淘汰最久未用。 */
export function createSeriesCache<T>(max = 6): SeriesCache<T> {
  const map = new Map<string, T>();
  return {
    get(key) {
      const value = map.get(key);
      if (value !== undefined) {
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value as string);
    },
    clear() {
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}
