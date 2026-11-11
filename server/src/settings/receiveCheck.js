import { BOX } from "../auth/boxAccess.js";
import { boxDistances, openCounts, radiusOf, sealOpenCounts, targetOf } from "./taskPlaces.js";

/**
 * 签收核验：收货方扫码签收前，看每台箱子的状态、本次开了几次箱、在不在收货点附近。
 * 有问题（开箱超上限、离收货点太远、箱盖开着、设备告警）时不能直接签收，只能拒收或强制签收。
 * 位置不明（没定位、没有收货地址坐标）只提示，不算问题。
 *
 * 判断用真实数据，给页面的数值按看的人的字段权限遮挡：没有「查看箱盖状态」时只说「箱盖状态异常」，
 * 不给具体值；没有「查看当前位置」时不给距离。perms 为空（内部调用）时不遮。
 *
 * status 是现在的状态：调拨运送中、待签收看收货地址；退回中看寄出地址；双向采样单寄回看寄回地址。
 */
export async function receiveCheck(db, boxes, task, taskId, status, { perms = null } = {}) {
  const can = (perm) => !perms || perms.has(perm);
  const ids = task.boxIds || [];
  const at = task.kind === "调拨" ? (status === "退回中" ? "退回中" : "待签收") : status;
  const target = targetOf(task, at);
  const counts = await openCounts(db, taskId);
  const afterSeal = await sealOpenCounts(db, taskId);
  const places = await boxDistances(db, ids, target, { withPosition: true });
  const list = [];
  const problems = [];
  const seeOpens = can(BOX.opens);
  const seeLid = can(BOX.lid);
  const seePlace = can(BOX.location);
  const seePower = can(BOX.power);
  const seeCharge = can(BOX.charging);
  for (const place of places) {
    const state = place.missing ? null : (await boxes.findById(place.id))?.toJSON();
    const opens = counts.get(place.id) ?? null;
    const over = Number.isInteger(task.maxOpens) && opens != null && opens > task.maxOpens;
    const lid = state?.lid ?? null;
    const alert = state?.alert || "";
    const name = place.name || place.id;
    const issues = [];
    if (over)
      issues.push(seeOpens ? `开箱 ${opens} 次，超过上限 ${task.maxOpens} 次` : "开箱次数超过上限");
    // 封箱后不该再开箱：开过就算异常，不管有没有设上限
    const sealed = afterSeal.get(place.id) ?? null;
    if (sealed) issues.push(seeOpens ? `封箱后又开箱 ${sealed} 次` : "封箱后又开过箱");
    if (place.near === false)
      issues.push(
        seePlace
          ? `离${target?.role || "收货点"} ${Math.round(place.distanceM)} 米，不在附近`
          : `不在${target?.role || "收货点"}附近`
      );
    if (lid === 1) issues.push(seeLid ? "箱盖开着" : "箱盖状态异常");
    if (alert) issues.push(`告警：${alert}`);
    for (const text of issues) problems.push({ boxId: place.id, name, text });
    list.push({
      id: place.id,
      name,
      missing: place.missing,
      opensDuring: seeOpens ? opens : null,
      opensAfterSeal: seeOpens ? sealed : null,
      over,
      near: place.near,
      distanceM: seePlace ? place.distanceM : null,
      positionSource: seePlace ? place.position?.source || "" : "",
      positionAt: seePlace ? place.position?.at || "" : "",
      lid: seeLid ? lid : null,
      alert,
      battery: seePower ? state?.battery || "" : "",
      batteryUsable: seePower ? (state?.batteryUsable ?? null) : null,
      charge: seeCharge ? (state?.charge ?? null) : null,
      last: place.last || "",
      issues,
    });
  }
  return {
    target: target
      ? {
          role: target.role,
          address: target.address || "",
          hasCoords: target.lng != null && target.lat != null,
        }
      : null,
    radiusM: radiusOf(target),
    maxOpens: Number.isInteger(task.maxOpens) ? task.maxOpens : null,
    boxes: list,
    problems,
  };
}
