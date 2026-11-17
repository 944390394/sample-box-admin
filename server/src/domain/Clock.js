/**
 * 服务器时钟。日志时间用它，不用设备报文里的 time。
 * 设备时钟可以不准，验收和告警都以服务器收到的时刻为准。
 */
export class Clock {
  now() {
    return new Date();
  }
}

/** 测试里把时间固定住，避免断言依赖当前时钟。 */
export class FixedClock extends Clock {
  constructor(date) {
    super();
    this.date = date;
  }

  now() {
    return this.date;
  }
}

/**
 * 设备时钟是没有时区的墙钟，按字段减秒。
 * 用 UTC 运算只是为了不让本机时区把时刻挪走。
 */
export function shiftDeviceTime(deviceTime, seconds) {
  const match = String(deviceTime ?? "").match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/
  );
  if (!match) return "";
  const utc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  );
  const next = new Date(utc - Number(seconds) * 1000);
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return [
    `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`,
    `${pad(next.getUTCHours())}:${pad(next.getUTCMinutes())}:${pad(next.getUTCSeconds())}`,
  ].join(" ");
}

/** 模块和 STM 的墙钟是东八区。用 UTC 字段写出，避免跟着服务器时区走。 */
export function formatUnixMs(ms) {
  const date = new Date(Number(ms) + 8 * 60 * 60 * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return [
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`,
  ].join(" ");
}

/** 格式化为 YYYY-MM-DD HH:mm:ss.SSS，精确到毫秒。 */
export function formatTimestamp(date) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`,
  ].join(" ");
}
