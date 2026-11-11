import { boxPosition, distanceM } from "../geo/place.js";
import { currentBoxSettings } from "./boxConfig.js";
import { ENDED } from "./taskFlow.js";

/** 这些状态下箱子正朝某个地点去，列表要算「到达附近」。 */
export const MOVING = [
  "待寄出",
  "运送中",
  "待签收",
  "待采样",
  "采样中",
  "已封箱",
  "在途",
  "待核验",
  "退回中",
];

/**
 * 这一步该和哪个地址比：调拨寄出前看寄出地址，之后看收货地址；采样封箱前看计划地点。
 * 旧采样单寄回核验没有登记地址，返回 null；带寄送的寄回寄出地址。
 */
export function targetOf(body, status) {
  if (body.kind === "调拨") {
    // 寄出前、拒收退回时看寄出地址
    if (status === "待寄出" || status === "退回中")
      return body.fromPlace ? { ...body.fromPlace, role: "寄出地址" } : null;
    return body.toPlace ? { ...body.toPlace, role: "收货地址" } : null;
  }
  const plan = body.placeAt ? { ...body.placeAt, role: "计划地点" } : null;
  if (body.trip) {
    // 带寄送的采样单：寄出前看寄出地址，寄去和采样看计划地点，寄回看寄出地址
    const home = (role) => (body.fromPlace ? { ...body.fromPlace, role } : null);
    // 结束了、或已在检测站等检测：不再朝哪里去
    if (ENDED.includes(status) || status === "待检测") return null;
    if (status === "待寄出") return home("寄出地址");
    if (["在途", "待核验"].includes(status)) return home("寄回地址");
    return plan;
  }
  if (["待采样", "采样中", "已封箱"].includes(status)) return plan;
  return null;
}

/**
 * 各箱当前位置和到目标的距离。withPosition 为假（没有位置权限）时不给坐标也不给距离。
 * near：距离不超过到达范围（地址自己设的误差范围，没设用系统设置）。
 */
export async function boxDistances(
  db,
  boxIds,
  target,
  { withPosition = true, radius = radiusOf(target) } = {}
) {
  if (!boxIds.length) return [];
  const rows = await db.all(
    `SELECT id,name,org,life,last_report_at,gps_lng,gps_lat,lbs_lng,lbs_lat,gps_info,lbs_at FROM sample_box WHERE id IN (${boxIds.map(() => "?").join(",")})`,
    boxIds
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return boxIds.map((id) => {
    const row = byId.get(id);
    if (!row)
      return {
        id,
        name: id,
        missing: true,
        org: "",
        life: "",
        last: "",
        position: null,
        distanceM: null,
        near: null,
      };
    const position = withPosition ? boxPosition(row) : null;
    const distance = target && position ? distanceM(position, target) : null;
    return {
      id,
      name: row.name || id,
      missing: false,
      org: row.org,
      life: row.life,
      last: row.last_report_at,
      position,
      distanceM: distance,
      near: distance == null ? null : distance <= radius,
    };
  });
}

/**
 * 任务期间各箱开了几次箱：结束了用结束时的次数，没结束用当前次数，减去开始时的次数。
 * 还没开始的任务返回 null。设备抹除后次数会归零，算出负数时按 0。
 */
export async function openCounts(db, taskId) {
  const rows = await db.all(
    "SELECT m.box_id, m.opens_start, m.opens_end, b.opens FROM sample_task_box m LEFT JOIN sample_box b ON b.id=m.box_id WHERE m.task_id=?",
    [taskId]
  );
  return new Map(
    rows.map((row) => {
      if (row.opens_start == null) return [row.box_id, null];
      const until = row.opens_end ?? row.opens ?? row.opens_start;
      return [row.box_id, Math.max(0, Number(until) - Number(row.opens_start))];
    })
  );
}

/** 开箱次数超过任务上限的箱号。 */
export function overOpenLimit(task, counts) {
  if (!Number.isInteger(task.maxOpens)) return [];
  return [...counts.entries()].filter(([, n]) => n != null && n > task.maxOpens).map(([id]) => id);
}

/** 目标地址自己设了误差范围就用它，否则用系统设置的到达半径。 */
export function radiusOf(target) {
  return Number.isInteger(target?.radiusM) ? target.radiusM : currentBoxSettings().arriveRadiusM;
}

/** 流转记录里只留距离，不留坐标。 */
export function distanceSnapshot(target, boxes) {
  if (!target) return null;
  return {
    target: { role: target.role, address: target.address },
    boxes: boxes.map((b) => ({
      id: b.id,
      distanceM: b.distanceM,
      source: b.position?.source || "",
    })),
  };
}
