/**
 * 跨域白名单（体检编号 L-P1-7）。
 *
 * 修复前每个响应都带 `Access-Control-Allow-Origin: *`，还声明允许 `Authorization` 头：
 * 任何网页都能拿这套接口发跨域请求。实际上开发用不到通配——vite 走 `/dev-api` 代理，
 * 浏览器看是同源；生产由反代同源提供；小程序的 wx.request 不受 CORS 约束；
 * 验收脚本是 Node 直连。所以这里只放行：同源之外带 Origin 的请求中，
 * 本机来源（localhost / 127.0.0.1 / ::1，可用 SAMPLE_CORS_LOOPBACK=0 关掉）
 * 和 SAMPLE_CORS_ORIGINS 明确列出的来源。放行时才回 CORS 头，并带 Vary: Origin。
 */

/** 本机来源：开发时页面和接口端口不同，允许；公网来源必须显式列出来。 */
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** SAMPLE_CORS_ORIGINS=https://a.example,https://b.example */
export function parseCorsOrigins(raw) {
  return String(raw || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 命中白名单就回这个 Origin，没命中回 null（不回 CORS 头，让浏览器拦掉）。 */
export function corsOrigin(origin, { allow = [], allowLoopback = true } = {}) {
  const value = String(origin || "");
  if (!value) return null;
  if (allow.includes(value)) return value;
  if (allowLoopback && LOOPBACK.test(value)) return value;
  return null;
}

/**
 * 请求的跨域响应头。preflight 和实际请求用同一份，暴露文件名（下载）也要放行后才给。
 * @param {string} origin 请求头里的 Origin
 * @param {{allow?: string[], allowLoopback?: boolean, expose?: string[]}} options
 */
export function corsHeaders(origin, { allow, allowLoopback, expose = [] } = {}) {
  const value = corsOrigin(origin, { allow, allowLoopback });
  if (!value) return {};
  const headers = {
    "Access-Control-Allow-Origin": value,
    // 同一个 URL 的响应随 Origin 变，缓存必须分开
    Vary: "Origin",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  };
  if (expose.length) headers["Access-Control-Expose-Headers"] = expose.join(", ");
  return headers;
}
