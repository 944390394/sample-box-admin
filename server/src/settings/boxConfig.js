/**
 * 采样箱的默认运行参数。周期和「只在充电时定时上报」要等固件 1.0.2 在确认包里收下。
 * 电量预留只影响网页上的可用电量，保存后立刻生效。
 */

const DEFAULTS = {
  reportPeriodSec: 5,
  reportOnlyWhenCharging: false,
  batteryReserve: 20,
  /** 箱子离任务目的地多近算「到达附近」，米。基站定位误差常有一两公里，所以默认 2 公里。 */
  arriveRadiusM: 2000,
};

const applied = { ...DEFAULTS };

function radiusOf(value, fallback) {
  const radius = Number(value);
  if (!Number.isInteger(radius) || radius < 100 || radius > 50000) return fallback;
  return radius;
}

function periodOf(value, fallback) {
  const period = Number(value);
  if (!Number.isInteger(period) || period < 5 || period > 3600) return fallback;
  return period;
}

function reserveOf(value, fallback) {
  const reserve = Number(value);
  if (!Number.isInteger(reserve) || reserve < 0 || reserve > 80) return fallback;
  return reserve;
}

export function publicBox(config) {
  const box = config?.box && typeof config.box === "object" ? config.box : {};
  return {
    reportPeriodSec: periodOf(box.reportPeriodSec, DEFAULTS.reportPeriodSec),
    reportOnlyWhenCharging: Boolean(box.reportOnlyWhenCharging),
    batteryReserve: reserveOf(box.batteryReserve, DEFAULTS.batteryReserve),
    arriveRadiusM: radiusOf(box.arriveRadiusM, DEFAULTS.arriveRadiusM),
  };
}

export function applyBoxSettings(config) {
  const next = publicBox(config);
  applied.reportPeriodSec = next.reportPeriodSec;
  applied.reportOnlyWhenCharging = next.reportOnlyWhenCharging;
  applied.batteryReserve = next.batteryReserve;
  applied.arriveRadiusM = next.arriveRadiusM;
  return { ...applied };
}

export function currentBoxSettings() {
  return { ...applied };
}

export function mergeBoxSettings(current, input) {
  const base = current && typeof current === "object" ? current : {};
  const period = Number(input?.reportPeriodSec);
  if (!Number.isInteger(period) || period < 5 || period > 3600) {
    throw new Error("上报周期要在 5 到 3600 秒之间");
  }
  const reserve = Number(input?.batteryReserve);
  if (!Number.isInteger(reserve) || reserve < 0 || reserve > 80) {
    throw new Error("电量预留要在 0 到 80 之间");
  }
  // 旧页面不带这个字段时保留原值
  const radius =
    input?.arriveRadiusM == null
      ? radiusOf(base.box?.arriveRadiusM, DEFAULTS.arriveRadiusM)
      : Number(input.arriveRadiusM);
  if (!Number.isInteger(radius) || radius < 100 || radius > 50000) {
    throw new Error("到达半径要在 100 到 50000 米之间");
  }
  return {
    ...base,
    box: {
      reportPeriodSec: period,
      reportOnlyWhenCharging: Boolean(input?.reportOnlyWhenCharging),
      batteryReserve: reserve,
      arriveRadiusM: radius,
    },
  };
}

/** 1.0.2 起，确认行可以在 ok 后面带 p= 和 c=。更早的固件只认单独的 ok。 */
export function firmwareAcceptsConfig(firmware) {
  const parts = String(firmware || "")
    .split(".")
    .map((item) => Number(item));
  if (parts.length < 3 || parts.some((item) => !Number.isInteger(item) || item < 0)) return false;
  const [major, minor, patch] = parts;
  if (major !== 1 || minor !== 0) return major > 1 || (major === 1 && minor > 0);
  return patch >= 2;
}

/** 1.0.6 起固件认 wipe 和 dump 下行指令。 */
export function firmwareSupportsRemote(firmware) {
  const parts = String(firmware || "")
    .split(".")
    .map((item) => Number(item));
  if (parts.length < 3 || parts.some((item) => !Number.isInteger(item) || item < 0)) return false;
  const [major, minor, patch] = parts;
  if (major !== 1) return major > 1;
  return minor > 0 || patch >= 6;
}

/** 1.0.7 起确认行可以带 l=0|1，控制 STM 三个指示灯日常亮不亮。 */
export function firmwareSupportsIndicators(firmware) {
  const parts = String(firmware || "")
    .split(".")
    .map((item) => Number(item));
  if (parts.length < 3 || parts.some((item) => !Number.isInteger(item) || item < 0)) return false;
  const [major, minor, patch] = parts;
  if (major !== 1) return major > 1;
  return minor > 0 || patch >= 7;
}

/** 1.0.9 起确认行可以带 a=<n>：离线队列里序号不大于 n 的记录一次全部确认。 */
export function firmwareSupportsQueueAck(firmware) {
  const parts = String(firmware || "")
    .split(".")
    .map((item) => Number(item));
  if (parts.length < 3 || parts.some((item) => !Number.isInteger(item) || item < 0)) return false;
  const [major, minor, patch] = parts;
  if (major !== 1) return major > 1;
  return minor > 0 || patch >= 9;
}

/** 1.0.8 起固件用模块发来的 net= 判断联网（上报里 rn=1），不再只看 RDY 引脚。 */
export function firmwareSupportsLink(firmware) {
  const parts = String(firmware || "")
    .split(".")
    .map((item) => Number(item));
  if (parts.length < 3 || parts.some((item) => !Number.isInteger(item) || item < 0)) return false;
  const [major, minor, patch] = parts;
  if (major !== 1) return major > 1;
  return minor > 0 || patch >= 8;
}

export function ackForBox(box) {
  if (!firmwareAcceptsConfig(box?.firmware)) return "ok\n";
  const settings = currentBoxSettings();
  const charging = settings.reportOnlyWhenCharging ? 1 : 0;
  return `ok p=${settings.reportPeriodSec} c=${charging}\n`;
}
