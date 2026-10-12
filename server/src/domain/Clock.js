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

/** 格式化为 YYYY-MM-DD HH:mm:ss.SSS，精确到毫秒。 */
export function formatTimestamp(date) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`,
  ].join(" ");
}
