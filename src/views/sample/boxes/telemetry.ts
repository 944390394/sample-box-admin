/** 设备状态按上报时刻判断，与浏览器到服务器的连接状态无关。
 *  charge/chargeOnly 与服务端 onlineSql 同口径：仅充电上报且当前未充电时，不据缺心跳断言掉线（R-4）。 */
export function telemetryState(
  last: string | null | undefined,
  periodSec: number | undefined,
  now: number,
  charge?: number | null,
  chargeOnly?: boolean
) {
  const reportedAt = last ? Date.parse(last.replace(" ", "T")) : NaN;
  const seconds = Number(periodSec);
  const period = Number.isInteger(seconds) && seconds >= 5 ? seconds : 60;
  const hasReport = Number.isFinite(reportedAt);
  const exempt = Boolean(chargeOnly) && Number(charge) === 0;
  const online = hasReport && (exempt || now - reportedAt < period * 3000);
  return {
    hasReport,
    reportedAt,
    online,
    /** 仅充电上报且当前未充电的豁免态（R-4）：online 为 true 时列表标「待机·仅充电」而非「在线」。 */
    exempt,
    // 离线后只知道上次上报时的运行情况，不能继续推算设备仍在运行。
    referenceTime: online ? now : reportedAt,
  };
}
