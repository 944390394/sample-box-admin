import { boxNameCell, identityGranted, maskImei, resolveAccess } from "../auth/boxAccess.js";
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
  // #94：additive 带出箱子/任务可见性口径（orgIds 含祖先、ownerIds 保管人），
  // 供对象名解析的范围判定用；列表/导出的行过滤仍只用 ids/actorId，口径零改动。
  const orgIds = (sc.orgIds || []).map(String);
  const ownerIds = (sc.ownerIds || []).map(String);
  if (!ids.length) {
    if (ownerIds.length) return { kind: "actor", actorId: String(user.id), orgIds, ownerIds };
    // 无生效角色（停用/未分配）且无部门范围：空范围显式 none，不能落到 depts[] 被误当全量
    return { kind: "none" };
  }
  return { kind: "depts", ids, orgIds, ownerIds };
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

/**
 * #94 对象可读化：类型中文文案（与网页 TARGET_TYPES 同词汇）。
 * 回退态「类型 #id」与设置类对象（无实体可查）都用这份文案。
 */
const TARGET_LABELS = {
  user: "人员",
  dept: "部门",
  role: "角色",
  box: "采样箱",
  task: "任务单",
  branding: "系统名称和图标",
  map: "地图设置",
  labels: "字段名称",
  database: "数据库",
  "report-policy": "上报策略",
  "company-policy": "公司策略",
  oplog: "操作日志",
  overview: "总览",
};

/**
 * #94：对象解析分类。report-policy 是历史重载类型——TK-/AL- 单号其实是 sample_task
 * （任务单/划拨单），按单号解析；单箱策略的 15 位 IMEI 与其余类型不参与四类解析，走回退。
 * 编号与类型同串（旧数据把类型当编号写）视同无编号，与网页 targetText 同口径。
 */
function targetOf(row) {
  const type = String(row.target_type ?? "");
  const raw = String(row.target_id ?? "");
  const id = raw && raw !== type ? raw : "";
  if (type === "task" || id.startsWith("TK-")) return { kind: "task", label: "任务单", id };
  if (id.startsWith("AL-")) return { kind: "task", label: "划拨单", id };
  if (type === "user" || type === "dept" || type === "box")
    return { kind: type, label: TARGET_LABELS[type], id };
  return { kind: "", label: TARGET_LABELS[type] || type, id };
}

/**
 * #94：对象名解析的范围判定（fail-closed，与各对象自己的可见性口径一致）：
 * - 人员/部门＝管人范围 manageOrgIds（scope.ids，下级管不了上级）；
 * - 箱子＝canSee 口径 org_id∈orgIds（含祖先）或保管人∈ownerIds；
 * - 任务＝参与方 from/to_org_id∈orgIds 或 body.orgId∈orgIds（箱快照分支不认，宁回退不泄露）；
 * - 仅本人范围：人员只认自己、箱子只认自己保管的，其余回退。
 * 范围外/已删除一律回退「类型 #id」，不报错也不泄露存在性。
 */
function targetInScope(kind, hit, scope) {
  if (scope.kind === "all") return true;
  if (scope.kind === "actor") {
    if (kind === "user") return String(hit.id) === String(scope.actorId);
    if (kind === "box")
      return Boolean(hit.owner_id) && (scope.ownerIds || []).includes(String(hit.owner_id));
    return false;
  }
  if (scope.kind !== "depts") return false;
  const manage = scope.ids || [];
  const orgs = scope.orgIds || [];
  if (kind === "user") return manage.includes(String(hit.dept_id ?? ""));
  if (kind === "dept") return manage.includes(String(hit.id));
  if (kind === "box")
    return (
      orgs.includes(String(hit.org_id ?? "")) ||
      (Boolean(hit.owner_id) && (scope.ownerIds || []).includes(String(hit.owner_id)))
    );
  if (kind === "task") {
    if (hit.from_org_id && orgs.includes(String(hit.from_org_id))) return true;
    if (hit.to_org_id && orgs.includes(String(hit.to_org_id))) return true;
    let bodyOrg;
    try {
      bodyOrg = String(JSON.parse(hit.body || "{}").orgId ?? "");
    } catch {
      bodyOrg = "";
    }
    return Boolean(bodyOrg) && orgs.includes(bodyOrg);
  }
  return false;
}

/** #94：解析名。箱子沿 boxNameCell 脱敏口径（未起名回显编号时按设备标识权限打码）；任务＝单号＋名称。 */
function targetDisplayName(kind, hit, perms) {
  if (kind === "user") return String(hit.nickname || hit.username || "");
  if (kind === "dept") return String(hit.name || "");
  if (kind === "box")
    return boxNameCell(
      { id: String(hit.id), name: String(hit.name || "") || String(hit.id) },
      perms
    );
  if (kind === "task") return `${hit.id} ${hit.name || ""}`.trim();
  return "";
}

/** IN 查询分批上限：老 SQLite 变量上限 999，MySQL 65535，取 800 两边都安全。 */
const LOOKUP_CHUNK = 800;

/**
 * #94：对象可读化批量 lookup——每类型一条 IN 查询映射（本页 ≤4 条、与行数无关，无 N+1；
 * 导出大表按 800/批切分仍是批量）。list/detail/export 同口径（都过 toItem 后的这一层）。
 * 响应 additive 增 targetName（最终展示串：解析名或回退「类型 #id」）与 targetResolved
 * （回退态标记，网页据此灰字＋tooltip 原编号）；旧客户端忽略新字段不受影响。
 * 回退里的编号用 toItem 已打码的 targetId——无设备标识权限者连回退串也见不到整串 IMEI。
 */
async function attachTargetNames(db, items, rawRows, scope, perms) {
  const meta = rawRows.map((row) => targetOf(row));
  const want = { user: new Set(), dept: new Set(), box: new Set(), task: new Set() };
  for (const t of meta) if (t.kind && t.id) want[t.kind].add(t.id);
  const maps = {};
  const lookup = async (kind, table, cols) => {
    const ids = [...want[kind]];
    if (!ids.length) return;
    const found = new Map();
    for (let start = 0; start < ids.length; start += LOOKUP_CHUNK) {
      const part = ids.slice(start, start + LOOKUP_CHUNK);
      const rows = await db.all(
        `SELECT ${cols} FROM ${table} WHERE id IN (${part.map(() => "?").join(", ")})`,
        part
      );
      for (const row of rows) found.set(String(row.id), row);
    }
    maps[kind] = found;
  };
  await lookup("user", "sys_user", "id, nickname, username, dept_id");
  await lookup("dept", "sys_dept", "id, name");
  await lookup("box", "sample_box", "id, name, org_id, owner_id");
  await lookup("task", "sample_task", "id, name, from_org_id, to_org_id, body");
  items.forEach((item, i) => {
    const t = meta[i];
    const hit = t.kind && t.id ? maps[t.kind]?.get(t.id) : null;
    const name =
      hit && targetInScope(t.kind, hit, scope) ? targetDisplayName(t.kind, hit, perms) : "";
    if (name) {
      item.targetName = name;
      item.targetResolved = true;
    } else if (!t.id) {
      // 设置类/空编号：对象就是类型本身，无实体可查，不算回退
      item.targetName = t.label;
      item.targetResolved = true;
    } else {
      item.targetName = `${t.label} #${item.targetId}`;
      item.targetResolved = false;
    }
  });
}

export async function queryOperationLogs(db, user, query = {}, perms = null) {
  const scope = await operationScope(db, user);
  const built = operationLogQuery(scope, query);
  if (built.error) return { error: built.error };
  if (built.empty) return { list: [], nextCursor: null };
  const rows = await db.all(built.sql, built.params);
  const hasMore = rows.length > built.limit;
  const pageRows = rows.slice(0, built.limit);
  const list = pageRows.map((row) => toItem(row, perms));
  await attachTargetNames(db, list, pageRows, scope, perms);
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
  const pageRows = rows.slice(0, built.max);
  const items = pageRows.map((row) => toItem(row, perms));
  await attachTargetNames(db, items, pageRows, scope, perms);
  return {
    rows: items,
    truncated,
    max: built.max,
  };
}
