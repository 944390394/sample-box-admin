import { identityGranted, maskImei, resolveAccess } from "../auth/boxAccess.js";
import { formatTimestamp } from "../domain/Clock.js";
import { pageLimit, resolveTimeRange } from "./timeRange.js";

const COLUMNS = `id, org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, detail, created_at, ip`;

/**
 * #26 B-01：箱子类审计的 target_id 就是 15 位 IMEI（box.id），与 boxAccess 同口径：
 * 凡是这个形态的串都按设备标识处理，读时按查看者权限打码，不原样下发。
 */
const IMEI_LIKE = /^\d{15}$/;
/** detail 文本里嵌的 15 位数字串（前后不能再是数字，避免截到 ICCID/时间戳的一部分）。 */
const IMEI_IN_TEXT = /(?<!\d)\d{15}(?!\d)/g;

/** #26 B2（D4）：单次导出上限。超出截断，响应头与 CSV 注释行都会标明。 */
export const OPERATION_LOG_EXPORT_MAX = 50000;

function clip(value, length) {
  return String(value ?? "").slice(0, length);
}

/** detail 是 TEXT（grant diff/scope 前后等 JSON）；对象序列化后落库，截断防体积失控（D6）。 */
function detailText(value) {
  if (value == null) return "";
  return clip(typeof value === "string" ? value : JSON.stringify(value), 8000);
}

export async function insertOperationLog(db, entry) {
  const createdAt = entry.createdAt || formatTimestamp(new Date());
  await db.run(
    `INSERT INTO sys_operation_log
      (org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, detail, created_at, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      clip(entry.orgId, 32),
      clip(entry.orgName, 64),
      clip(entry.actorId, 32),
      clip(entry.actorName, 64),
      clip(entry.action, 32),
      clip(entry.targetType, 32),
      clip(entry.targetId, 64),
      entry.result === "失败" ? "失败" : "成功",
      detailText(entry.detail),
      createdAt,
      clip(entry.ip, 64),
    ]
  );
}

export async function operationScope(db, user) {
  // #26 B1：收敛到 resolveAccess 单一权威（含角色 status/部门上限/ADMIN/自定义5）
  const access = await resolveAccess(db, user);
  const sc = access.scope;
  if (sc.all) return { kind: "all" };
  const ids = (sc.manageOrgIds || []).map(String).filter(Boolean);
  if (!ids.length) {
    if ((sc.ownerIds || []).length) return { kind: "actor", actorId: String(user.id) };
    // 无生效角色（停用/未分配）且无部门范围：空范围显式 none，不能落到 depts[] 被误当全量
    return { kind: "none" };
  }
  return { kind: "depts", ids };
}

/**
 * 列表与导出共用的范围+过滤条件：时间范围必填（缺省最近 7 天、最长 31 天），
 * 空范围（none）与未知口径一律返空，越权 orgId 收敛为空而不是报错泄露（fail-closed）；
 * 只有 all 才不带组织条件。
 */
function scopeFilter(scope, query) {
  const range = resolveTimeRange(query);
  if (range.error) return { error: range.error };
  if (scope.kind !== "all" && scope.kind !== "actor" && scope.kind !== "depts")
    return { empty: true };
  const where = ["created_at >= ?", "created_at <= ?"];
  const params = [range.from, range.to];

  if (scope.kind === "actor") {
    where.push("actor_id = ?");
    params.push(String(scope.actorId || ""));
  } else if (scope.kind === "depts") {
    const ids = (scope.ids || []).map(String).filter(Boolean);
    if (!ids.length) return { empty: true };
    if (query.orgId && !ids.includes(String(query.orgId))) return { empty: true };
    const chosen = query.orgId ? [String(query.orgId)] : ids;
    where.push(`org_id IN (${chosen.map(() => "?").join(", ")})`);
    params.push(...chosen);
  } else if (query.orgId) {
    where.push("org_id = ?");
    params.push(String(query.orgId));
  }

  if (query.actor) {
    where.push("(actor_id = ? OR actor_name = ?)");
    params.push(String(query.actor), String(query.actor));
  }
  if (query.targetId) {
    where.push("target_id = ?");
    params.push(String(query.targetId));
  }
  return { where, params };
}

/** 只生成带时间条件的一页查询。不统计总行数。 */
export function operationLogQuery(scope, query = {}) {
  const limit = pageLimit(query.limit);
  const built = scopeFilter(scope, query);
  if (built.error) return { error: built.error };
  if (built.empty) return { empty: true, limit };
  const { where, params } = built;
  if (query.cursorTime && query.cursorId) {
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    const cursorId = Number(query.cursorId);
    params.push(
      String(query.cursorTime),
      String(query.cursorTime),
      Number.isSafeInteger(cursorId) ? cursorId : String(query.cursorId)
    );
  }

  return {
    limit,
    params,
    sql: `SELECT ${COLUMNS}
      FROM sys_operation_log
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}`,
  };
}

/**
 * #26 B2：导出查询——与列表同一套范围/过滤（不带翻页游标），
 * 上限 max 行（默认 D4 的 5 万，硬顶也是 5 万），多取一行用来判断是否截断。
 */
export function operationLogExportQuery(scope, query = {}, max = OPERATION_LOG_EXPORT_MAX) {
  const built = scopeFilter(scope, query);
  if (built.error) return { error: built.error };
  const cap =
    Number.isSafeInteger(max) && max > 0
      ? Math.min(max, OPERATION_LOG_EXPORT_MAX)
      : OPERATION_LOG_EXPORT_MAX;
  if (built.empty) return { empty: true, max: cap };
  return {
    max: cap,
    params: built.params,
    sql: `SELECT ${COLUMNS}
      FROM sys_operation_log
      WHERE ${built.where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ${cap + 1}`,
  };
}

/**
 * #26 B-01：perms 是查看者的权限集（ctx.access.perms）。无「设备标识」权限时，
 * targetId 里的整串 IMEI 与 detail 里嵌的 15 位数字串都换成 maskImei（留前 3 后 4）。
 * perms=null 为内部调用（无查看者上下文），不打码；identityGranted(null) 亦为 true。
 * user/dept/role 等短编号不匹配 IMEI 形态，不受影响。
 */
function toItem(row, perms = null) {
  const hideIdentity = !identityGranted(perms);
  const rawId = row.target_id;
  const rawDetail = row.detail == null ? "" : String(row.detail);
  return {
    id: String(row.id),
    orgId: row.org_id,
    orgName: row.org_name,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    targetType: row.target_type,
    targetId: hideIdentity && IMEI_LIKE.test(String(rawId ?? "")) ? maskImei(rawId) : rawId,
    result: row.result,
    detail: hideIdentity ? rawDetail.replace(IMEI_IN_TEXT, (hit) => maskImei(hit)) : rawDetail,
    createdAt:
      row.created_at instanceof Date ? formatTimestamp(row.created_at) : String(row.created_at),
    ip: row.ip,
  };
}

export async function queryOperationLogs(db, user, query = {}, perms = null) {
  const scope = await operationScope(db, user);
  const built = operationLogQuery(scope, query);
  if (built.error) return { error: built.error };
  if (built.empty) return { list: [], nextCursor: null };
  const rows = await db.all(built.sql, built.params);
  const hasMore = rows.length > built.limit;
  const list = rows.slice(0, built.limit).map((row) => toItem(row, perms));
  const last = list[list.length - 1];
  return {
    list,
    nextCursor: hasMore && last ? { time: last.createdAt, id: last.id } : null,
  };
}

/**
 * #26 B2：导出取数——与列表同一 operationScope/过滤口径，无游标，上限截断。
 * 空范围/越权 orgId 给空表（rows=[]），不报错也不泄露范围外存在性。
 * #26 B-01：perms 同 queryOperationLogs——按查看者设备标识权限读时打码。
 */
export async function queryOperationLogsForExport(
  db,
  user,
  query = {},
  max = OPERATION_LOG_EXPORT_MAX,
  perms = null
) {
  const scope = await operationScope(db, user);
  const built = operationLogExportQuery(scope, query, max);
  if (built.error) return { error: built.error };
  if (built.empty) return { rows: [], truncated: false, max: built.max };
  const rows = await db.all(built.sql, built.params);
  const truncated = rows.length > built.max;
  return {
    rows: rows.slice(0, built.max).map((row) => toItem(row, perms)),
    truncated,
    max: built.max,
  };
}
