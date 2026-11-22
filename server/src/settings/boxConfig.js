import { badRequest } from "../domain/AppError.js";
import { buildDeptTree } from "../../../shared/org.js";
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
  /** 划拨/送检功能常开（组织简化后合并采样单/划拨是主流程，无开关）。键保留兼容旧客户端：写入一律忽略、读取恒 true。 */
  enableTransferInspect: true,
  /** 建单后未上线的离线宽限，秒（B3/#18）。默认 1 小时；设置页以分钟展示（1–1440）。 */
  taskOfflineGraceSec: 3600,
  /**
   * 唯一检测站部门 id（组织简化 P5）。合并采样单的接收方固定为它；未配置（空串）时建单友好报错。
   * 存在性/唯一性/属总公司子树的校验在 saveBox（B1b）做，这里只负责存取字符串。
   */
  stationDeptId: "",
};

// applied 只放运行参数（进策略版本哈希的那几项）；功能开关不在其中。
const applied = {
  reportPeriodSec: DEFAULTS.reportPeriodSec,
  reportOnlyWhenCharging: DEFAULTS.reportOnlyWhenCharging,
  batteryReserve: DEFAULTS.batteryReserve,
  arriveRadiusM: DEFAULTS.arriveRadiusM,
};
// 划拨/送检常开、无开关：不再存开关状态（旧配置里的 enableTransferInspect 写入被忽略、读取恒 true）。
// 宽限不进 applied：它只影响离线判定，不参与上报策略版本哈希。
let offlineGrace = DEFAULTS.taskOfflineGraceSec;
// 唯一检测站 id 也不进 applied：它是组织配置，不参与上报策略版本哈希。
let station = DEFAULTS.stationDeptId;

function stationOf(value) {
  if (value == null) return "";
  return String(value).trim().slice(0, 32);
}

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

function graceOf(value, fallback) {
  const sec = Number(value);
  if (!Number.isInteger(sec) || sec < 60 || sec > 86400) return fallback;
  return sec;
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
    // 功能常开：键保留兼容旧客户端，值恒 true（存量 off 配置读取时也按 true）。
    enableTransferInspect: true,
    taskOfflineGraceSec: graceOf(box.taskOfflineGraceSec, DEFAULTS.taskOfflineGraceSec),
    stationDeptId: stationOf(box.stationDeptId),
  };
}

export function applyBoxSettings(config) {
  const next = publicBox(config);
  applied.reportPeriodSec = next.reportPeriodSec;
  applied.reportOnlyWhenCharging = next.reportOnlyWhenCharging;
  applied.batteryReserve = next.batteryReserve;
  applied.arriveRadiusM = next.arriveRadiusM;
  offlineGrace = next.taskOfflineGraceSec;
  station = next.stationDeptId;
  return { ...applied };
}

export function currentBoxSettings() {
  return { ...applied };
}

/** 划拨/送检功能常开（组织简化后无开关）。保留导出供调用方；旧 off 配置写入被忽略、读取恒 true。 */
export function transferInspectEnabled() {
  return true;
}

/** 建单后未上线的离线宽限（秒，B3/#18）。offlineSql / flagMatch 唯一读取点。 */
export function offlineGraceSec() {
  return offlineGrace;
}

/** 唯一检测站部门 id（组织简化 P5）。空串＝未配置，合并采样单建单时友好报错。 */
export function stationDeptId() {
  return station;
}

/* ---------------- 唯一检测站解析与校验（组织简化 B1b/P5） ---------------- */

/** 部门行统一形状（id/parent_id 字符串化），供树计算用。 */
function deptRowsOf(rows) {
  return rows.map((row) => ({
    id: String(row.id),
    parentId: String(row.parent_id ?? "0"),
    sort: Number(row.sort) || 0,
  }));
}

/**
 * 总公司＝组织树第一个根（按 sort、id 排序，与 OverviewController.#units / deptUnder 同约定）。
 * 没有部门时返回空串。
 */
export function hqIdOf(rows) {
  const tree = buildDeptTree(deptRowsOf(rows));
  return String(tree[0]?.id ?? "");
}

/**
 * id 是否属总公司子树（不含总公司自身——总部只查看，不能作检测站）。
 * parentIdOverride：部门还没写库（新建）或正要改挂（编辑）时，用「新上级」沿 parent 链判定。
 */
export function isUnderHq(rows, id, parentIdOverride) {
  const hq = hqIdOf(rows);
  if (!hq || String(id ?? "") === hq) return false;
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  let cur =
    parentIdOverride !== undefined
      ? String(parentIdOverride ?? "")
      : String(byId.get(String(id ?? ""))?.parent_id ?? "");
  const seen = new Set();
  while (cur && cur !== "0" && !seen.has(cur)) {
    if (cur === hq) return true;
    seen.add(cur);
    cur = String(byId.get(cur)?.parent_id ?? "");
  }
  return false;
}

/** 除 excludeId 外还有没有别的检测站（全局唯一校验用；停用行也算占位）。 */
export async function otherStation(db, excludeId = "") {
  const rows = await db.all("SELECT id, name FROM sys_dept WHERE type = '检测站'");
  return rows.find((row) => String(row.id) !== String(excludeId ?? "")) || null;
}

/**
 * 解析当前生效的唯一检测站（P5）：
 * 1. 配置 box.stationDeptId 优先——配置了就必须合法（存在/启用/类型检测站/属总公司子树），否则 null；
 * 2. 未配置时回退 DB：type=检测站 且启用且属总公司子树恰好一个 → 自动认定；
 * 3. 零个或多个 → null（建单侧友好报错「请先在系统设置指定唯一检测站」）。
 * 返回部门原始行（snake_case）或 null。
 */
export async function resolveStation(db) {
  const rows = await db.all(
    "SELECT id, parent_id, name, code, type, sort, status, leader_user_id FROM sys_dept"
  );
  const valid = (row) =>
    row && Number(row.status) === 1 && row.type === "检测站" && isUnderHq(rows, row.id);
  const configured = stationDeptId();
  if (configured) {
    const row = rows.find((item) => String(item.id) === configured);
    return valid(row) ? row : null;
  }
  const candidates = rows.filter(valid);
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * saveBox 配置唯一检测站时的合法性校验（B1b）：存在/启用/类型检测站/属总公司子树/全局唯一。
 * 不合法抛 badRequest（友好报错，不是 500）。清空配置（空串）不走这里。
 */
export async function assertStationSavable(db, id) {
  const stationId = String(id ?? "").trim();
  if (!stationId) return;
  const rows = await db.all("SELECT id, parent_id, name, type, sort, status FROM sys_dept");
  const row = rows.find((item) => String(item.id) === stationId);
  if (!row) throw badRequest(`检测站部门不存在：${stationId}`);
  if (Number(row.status) !== 1)
    throw badRequest(`检测站「${row.name}」已停用，请先启用或另选检测站`);
  if (row.type !== "检测站")
    throw badRequest(`「${row.name}」不是检测站类型，请先在部门页把类型改为检测站`);
  if (!isUnderHq(rows, row.id))
    throw badRequest(`检测站必须属总公司子树：「${row.name}」不在总公司下`);
  const other = await otherStation(db, stationId);
  if (other) throw badRequest(`检测站全局唯一：「${other.name}」已是检测站，请先把它改回公司`);
}

export function mergeBoxSettings(current, input) {
  const base = current && typeof current === "object" ? current : {};
  const period = Number(input?.reportPeriodSec);
  if (!Number.isInteger(period) || period < 5 || period > 3600) {
    throw badRequest("上报周期要在 5 到 3600 秒之间");
  }
  const reserve = Number(input?.batteryReserve);
  if (!Number.isInteger(reserve) || reserve < 0 || reserve > 80) {
    throw badRequest("电量预留要在 0 到 80 之间");
  }
  // 旧页面不带这个字段时保留原值
  const radius =
    input?.arriveRadiusM == null
      ? radiusOf(base.box?.arriveRadiusM, DEFAULTS.arriveRadiusM)
      : Number(input.arriveRadiusM);
  if (!Number.isInteger(radius) || radius < 100 || radius > 50000) {
    throw badRequest("到达半径要在 100 到 50000 米之间");
  }
  // 功能常开：键保留兼容旧客户端，写入一律忽略（恒 true）；两边都没设过仍不写键（读取恒 true）。
  const flagPresent =
    input?.enableTransferInspect != null || base.box?.enableTransferInspect != null;
  // 离线宽限：旧页面不带时保留原值；两边都没设过不写键（读取按默认 3600）。带值时校验 1–1440 分钟。
  const grace =
    input?.taskOfflineGraceSec != null
      ? Number(input.taskOfflineGraceSec)
      : base.box?.taskOfflineGraceSec != null
        ? Number(base.box.taskOfflineGraceSec)
        : null;
  if (grace != null && (!Number.isInteger(grace) || grace < 60 || grace > 86400))
    throw badRequest("离线宽限要在 1 到 1440 分钟之间");
  // 唯一检测站：旧页面不带时保留原值；两边都没设过不写键（读取按默认空串＝未配置）。
  // 传空串＝清空配置。存在性/类型/唯一性校验在 saveBox（B1b）做。
  const stationId =
    input?.stationDeptId != null
      ? stationOf(input.stationDeptId)
      : base.box?.stationDeptId != null
        ? stationOf(base.box.stationDeptId)
        : null;
  return {
    ...base,
    box: {
      reportPeriodSec: period,
      reportOnlyWhenCharging: Boolean(input?.reportOnlyWhenCharging),
      batteryReserve: reserve,
      arriveRadiusM: radius,
      ...(flagPresent ? { enableTransferInspect: true } : {}),
      ...(grace == null ? {} : { taskOfflineGraceSec: grace }),
      ...(stationId == null ? {} : { stationDeptId: stationId }),
    },
  };
}

/**
 * saveBox 字段级授权（R21/062：唯一检测站从 policyDefault 拆出 sys:settings:station）：
 * 改了哪一块就查哪一项码，未变更的回显值不查；缺码返回友好报错文案，全过返回 null。
 * before/after 都是 publicBox 形状；perms＝当前账号权限集（auth 路由恒有 access，
 * 缺失时按无权限拒，与原 saveBox 内联口径一致）。抽成纯函数供 saveBox 调用与单测行为断言。
 */
export function boxSettingsDenied(before, after, perms) {
  const has = (code) => Boolean(perms?.has(code));
  if (
    (before.reportPeriodSec !== after.reportPeriodSec ||
      Boolean(before.reportOnlyWhenCharging) !== after.reportOnlyWhenCharging) &&
    !has("device:box:policyDefault")
  )
    return "没有「修改默认上报策略」权限";
  if (
    Number(before.batteryReserve) !== after.batteryReserve &&
    !has("sys:settings:battery-reserve")
  )
    return "没有「修改电量预留比例」权限";
  if (Number(before.arriveRadiusM) !== after.arriveRadiusM && !has("sys:settings:arrive-radius"))
    return "没有「修改到达判定半径」权限";
  if (
    String(before.stationDeptId ?? "") !== String(after.stationDeptId ?? "") &&
    !has("sys:settings:station")
  )
    return "没有修改唯一检测站配置的权限";
  return null;
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
