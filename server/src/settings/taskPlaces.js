import { boxPosition, distanceM } from "../geo/place.js";
import { currentBoxSettings } from "./boxConfig.js";
import { companyJudgmentFor, companyOrgOfTask } from "./companyPolicy.js";
import { ENDED, isLegacySample } from "./taskFlow.js";

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
  // 合并采样单（组织简化 P6）：采样段看计划地点；在途/待签收/待检测看检测站收货地址；退回看寄出地址。
  // R22 双向首腿：待寄出看寄出地址（检测站），运送中朝采样分公司的计划地点去。
  if (body.kind === "采样" && !isLegacySample({ ...body, status })) {
    if (["待采样", "采样中", "已封箱", "运送中"].includes(status)) return plan;
    if (status === "待寄出") return body.fromPlace ? { ...body.fromPlace, role: "寄出地址" } : null;
    if (["在途", "待签收", "待检测"].includes(status))
      return body.toPlace ? { ...body.toPlace, role: "收货地址" } : null;
    if (status === "退回中") return body.fromPlace ? { ...body.fromPlace, role: "寄出地址" } : null;
    return null;
  }
  if (body.trip) {
    // 带寄送的旧采样单：寄出前看寄出地址，寄去和采样看计划地点，寄回看寄出地址
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
 * 用任务开始后的上报，倒推建单那一刻服务器上的累计开箱次数。
 * before 是建单前最后一包里的芯片次数；during 是建单之后按时间排列的芯片次数。
 * 芯片复位后次数变小，只把变大的差值算进去，和入库时的累计方式一致。
 */
export function opensAtTaskStart(currentOpens, beforeReported, duringReported) {
  let device = beforeReported == null ? null : Number(beforeReported);
  let added = 0;
  for (const value of duringReported || []) {
    const reported = Number(value);
    if (!Number.isFinite(reported)) continue;
    if (device == null) {
      device = reported;
      added += reported;
      continue;
    }
    if (reported >= device) added += reported - device;
    device = reported;
  }
  const start = Number(currentOpens) - added;
  return start > 0 ? start : 0;
}

/**
 * 任务期间各箱开了几次箱。建单时记下当时的次数，结束前用当前次数，结束后用结束时的次数。
 * 寄出前、封箱后都算在里面，直到任务结束才停。没记下开始次数的旧数据返回 null。
 * 设备抹除后次数会归零，算出负数时按 0。
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

/**
 * 封箱以后各箱又开了几次箱：没封过箱（调拨、还没到封箱）返回 null。
 * 结束了用结束时的次数，没结束用当前次数；设备抹除后算出负数时按 0。
 */
export async function sealOpenCounts(db, taskId) {
  const rows = await db.all(
    "SELECT m.box_id, m.opens_seal, m.opens_end, b.opens FROM sample_task_box m LEFT JOIN sample_box b ON b.id=m.box_id WHERE m.task_id=?",
    [taskId]
  );
  return new Map(
    rows.map((row) => {
      if (row.opens_seal == null) return [row.box_id, null];
      const until = row.opens_end ?? row.opens ?? row.opens_seal;
      return [row.box_id, Math.max(0, Number(until) - Number(row.opens_seal))];
    })
  );
}

/** 开箱次数超过任务上设置的上限的箱号。没设上限的任务不判断。 */
export function overOpenLimit(task, counts) {
  if (!Number.isInteger(task?.maxOpens)) return [];
  return [...counts.entries()].filter(([, n]) => n != null && n > task.maxOpens).map(([id]) => id);
}

/**
 * 样品作废的箱子：任务期间开箱次数超过上限。次数只会变多，超了就一直算作废，
 * 强制签收也不改变——作废的箱子不能「开始检测」。没设上限的任务没有作废。
 */
export async function voidBoxIds(db, taskId, task) {
  if (!Number.isInteger(task?.maxOpens)) return new Set();
  return new Set(overOpenLimit(task, await openCounts(db, taskId)));
}

/** 目标地址自己设了误差范围就用它，否则用系统设置的到达半径。 */
export function radiusOf(target) {
  return Number.isInteger(target?.radiusM) ? target.radiusM : currentBoxSettings().arriveRadiusM;
}

/**
 * 任务到达半径（R13 P1 公司化）：地址显式 radiusM 优先；否则按任务归属公司的公司级到达半径——
 * 箱子在检测站期间判定也按寄出公司（拍板④），公司未覆盖时回落系统默认。
 * R22：派生方向合并单按采样单位（双向 fromOrg＝检测站无公司层）；旧单 fromOrgId→orgId→总公司（""）。
 */
export async function taskRadiusOf(db, task, target) {
  if (Number.isInteger(target?.radiusM)) return target.radiusM;
  const { arriveRadiusM } = await companyJudgmentFor(db, companyOrgOfTask(task));
  return arriveRadiusM;
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
