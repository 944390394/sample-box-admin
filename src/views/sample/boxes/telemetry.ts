/** 设备状态按上报时刻判断，与浏览器到服务器的连接状态无关。 */
export function telemetryState(
  last: string | null | undefined,
  periodSec: number | undefined,
  now: number
) {
  const reportedAt = last ? Date.parse(last.replace(" ", "T")) : NaN;
  const seconds = Number(periodSec);
  const period = Number.isInteger(seconds) && seconds >= 5 ? seconds : 60;
  const hasReport = Number.isFinite(reportedAt);
  const online = hasReport && now - reportedAt < period * 3000;
  return {
    hasReport,
    reportedAt,
    online,
    // 离线后只知道上次上报时的运行情况，不能继续推算设备仍在运行。
    referenceTime: online ? now : reportedAt,
  };
}
