import { formatTimestamp } from "../domain/Clock.js";

const DAY = 24 * 60 * 60 * 1000;
const MAX_SPAN = 31 * DAY;
const DEFAULT_SPAN = 7 * DAY;

/** 接受日期或到毫秒的时间。只有日期时，结束一侧算到当天最后一毫秒。 */
export function parseTimestamp(value, endOfDay = false) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/
  );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hasTime = match[4] != null;
  const hour = hasTime ? Number(match[4]) : endOfDay ? 23 : 0;
  const minute = hasTime ? Number(match[5]) : endOfDay ? 59 : 0;
  const second = hasTime ? Number(match[6] || 0) : endOfDay ? 59 : 0;
  const fraction = hasTime ? Number(String(match[7] || "0").padEnd(3, "0")) : endOfDay ? 999 : 0;
  const date = new Date(year, month - 1, day, hour, minute, second, fraction);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

/**
 * 查询必须落在一段时间内。缺省最近 7 天，一次最长 31 天。
 * 不带时间就按缺省补上，避免调用方扫完整张表。
 */
export function resolveTimeRange(query = {}, now = new Date()) {
  const to = query.to ? parseTimestamp(query.to, true) : now;
  const from = query.from
    ? parseTimestamp(query.from, false)
    : new Date((to || now).getTime() - DEFAULT_SPAN);
  if (!from || !to) return { error: "时间格式不正确" };
  if (from.getTime() > to.getTime()) return { error: "开始时间不能晚于结束时间" };
  if (to.getTime() - from.getTime() > MAX_SPAN) return { error: "一次最长查询 31 天" };
  return { from: formatTimestamp(from), to: formatTimestamp(to) };
}

export function pageLimit(value, fallback = 20) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(100, Math.max(1, number));
}
