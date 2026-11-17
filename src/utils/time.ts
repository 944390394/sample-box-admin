import { ref } from "vue";

/**
 * 全站共用的「现在」，每秒走一格，整个页面只有这一个定时器。
 * 「x 秒前 / x 分钟前」这类文字读它，就会跟着每秒自动刷新，不用各页自己设定时器；
 * 在 computed 里读时，文字没变就不会触发重新渲染，开销很小。
 */
export const clock = ref(Date.now());
if (typeof window !== "undefined") {
  window.setInterval(() => {
    clock.value = Date.now();
  }, 1000);
  // 标签页切回来时后台节流过的定时器可能慢了，马上校正一次
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) clock.value = Date.now();
  });
}

/**
 * 任务里有两种时间：任务和流转记录是 ISO（UTC，带 T/Z），上报是服务器本地时间「YYYY-MM-DD HH:mm:ss.SSS」。
 * 统一转成 Date 再按浏览器本地时间显示，不要直接截字符串，否则 ISO 会差 8 小时。
 */
export function toDate(time?: string | null) {
  if (!time) return null;
  const date = new Date(/[TZ]/.test(time) ? time : time.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 10-29 21:23 */
export function shortTime(time?: string | null) {
  const d = toDate(time);
  return d
    ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    : "—";
}

/** 2026-10-29 21:23:21 */
export function fullTime(time?: string | null) {
  const d = toDate(time);
  return d
    ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    : "—";
}

/** 刚刚 / 40 秒前 / 5 分钟前 / 3 小时前 / 10-27 08:00。读全站时钟，每秒自动刷新。 */
export function ago(time?: string | null) {
  const d = toDate(time);
  if (!d) return "—";
  const ms = Math.max(0, clock.value - d.getTime());
  if (ms < 10000) return "刚刚";
  if (ms < 60000) return `${Math.floor(ms / 1000)} 秒前`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)} 分钟前`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)} 小时前`;
  return shortTime(time);
}

/** 两个时间之间多久：2 小时 15 分 */
export function span(from?: string | null, to?: string | null) {
  const a = toDate(from),
    b = toDate(to);
  if (!a || !b) return "";
  const minutes = Math.max(0, Math.round((b.getTime() - a.getTime()) / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}`;
  return `${Math.floor(hours / 24)} 天${hours % 24 ? ` ${hours % 24} 小时` : ""}`;
}

/** 每台箱子在地图和表格里用同一种颜色。 */
export const TRACK_COLORS = [
  "#2563eb",
  "#db2777",
  "#0891b2",
  "#ca8a04",
  "#7c3aed",
  "#059669",
  "#ea580c",
  "#4f46e5",
];
export const trackColor = (index: number) => TRACK_COLORS[index % TRACK_COLORS.length];

/** 给服务器查询用的本地时间：2026-10-29 21:23:21。 */
export function localStamp(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 最近 days 天的查询区间。 */
export function lastDays(days: number) {
  const to = new Date();
  return { from: localStamp(new Date(to.getTime() - days * 86400000)), to: localStamp(to) };
}
