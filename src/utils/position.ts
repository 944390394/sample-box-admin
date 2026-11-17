import { clock, toDate } from "./time";

/**
 * 位置和数据新鲜度，全站一套规则（见 docs/ui-redesign.md「数据新鲜度」）。
 *
 * 当前位置：GPS 是新的就用 GPS；基站位置比最后一次 GPS 定位新 10 分钟以上，就用基站，
 * 同时保留「最后一次 GPS」给页面提示。和服务端 server/src/geo/place.js 的 boxPosition 一致，
 * 到达判断用的也是同一个位置。
 */

/** 基站比 GPS 新这么多以上，就认为 GPS 过时了。和服务端 GPS_STALE_MS 一样。 */
export const GPS_STALE_MS = 10 * 60 * 1000;

export type Freshness = "fresh" | "aging" | "stale" | "unknown";
export type PositionSource = "GPS" | "基站";

export interface PositionFix {
  source: PositionSource;
  lng: number;
  lat: number;
  /** 这个位置是什么时候的。老数据可能没有。 */
  at: string;
  address: string;
}

export interface BoxPositions {
  /** 现在该信的位置，没有定位过为空。 */
  current: PositionFix | null;
  gps: PositionFix | null;
  lbs: PositionFix | null;
  /** 当前用的是基站、而且 GPS 已经过时（比基站旧 10 分钟以上）。 */
  gpsStale: boolean;
}

/** 箱子上和位置有关的字段，列表、详情、地图的箱子对象都有。 */
export interface PositionFields {
  gpsLng?: number | null;
  gpsLat?: number | null;
  gpsAddress?: string;
  gpsInfo?: { at?: string } | null;
  lbsLng?: number | null;
  lbsLat?: number | null;
  lbsAddress?: string;
  lbsAt?: string;
}

const ms = (time?: string | null) => toDate(time)?.getTime() ?? NaN;

export function boxPositions(box: PositionFields): BoxPositions {
  const gps =
    box.gpsLng != null && box.gpsLat != null
      ? {
          source: "GPS" as const,
          lng: box.gpsLng,
          lat: box.gpsLat,
          at: box.gpsInfo?.at || "",
          address: box.gpsAddress || "",
        }
      : null;
  const lbs =
    box.lbsLng != null && box.lbsLat != null
      ? {
          source: "基站" as const,
          lng: box.lbsLng,
          lat: box.lbsLat,
          at: box.lbsAt || "",
          address: box.lbsAddress || "",
        }
      : null;
  const gpsStale = Boolean(gps && lbs && ms(lbs.at) - ms(gps.at) > GPS_STALE_MS);
  return { current: gpsStale ? lbs : gps || lbs, gps, lbs, gpsStale };
}

/**
 * 一个时间点有多新：上报周期 3 倍内（至少 10 分钟）算新，1 小时内有点旧，再久算过时。
 * 时间不知道的给 unknown。
 */
export function freshness(
  time?: string | null,
  periodSec?: number | null,
  now = clock.value
): Freshness {
  const t = ms(time);
  if (!Number.isFinite(t)) return "unknown";
  const age = now - t;
  const period = Number(periodSec) >= 5 ? Number(periodSec) : 60;
  if (age <= Math.max(GPS_STALE_MS, period * 3000)) return "fresh";
  if (age <= 3600000) return "aging";
  return "stale";
}

/**
 * 多久以前：刚刚 / 40 秒前 / 3 分钟前 / 2 小时前 / 3 天前 / 11-02（一个月以上）。
 * 一分钟内也写秒数：上报周期短的箱子 15 秒没报就算离线，不能出现「刚刚 · 离线」。
 */
export function ageText(time?: string | null, now = clock.value) {
  const t = ms(time);
  if (!Number.isFinite(t)) return "";
  const age = Math.max(0, now - t);
  if (age < 10000) return "刚刚";
  if (age < 60000) return `${Math.floor(age / 1000)} 秒前`;
  if (age < 3600000) return `${Math.floor(age / 60000)} 分钟前`;
  if (age < 86400000) return `${Math.floor(age / 3600000)} 小时前`;
  if (age < 30 * 86400000) return `${Math.floor(age / 86400000)} 天前`;
  const d = new Date(t);
  return `${d.getFullYear() === new Date(now).getFullYear() ? "" : `${d.getFullYear()}-`}${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 坐标统一 6 位小数。 */
export const coordText = (lng: number, lat: number) => `${lng.toFixed(6)}, ${lat.toFixed(6)}`;

/** 数字按位数取整，去掉 4.6999998 这种尾巴；空值给空串。 */
export function round(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(Number(value))) return "";
  return String(Number(Number(value).toFixed(digits)));
}
