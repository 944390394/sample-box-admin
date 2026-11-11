import { buildDeptTree, collectDeptIds } from "../../../shared/org.js";
import { formatTimestamp } from "../domain/Clock.js";
import { pageLimit, resolveTimeRange } from "./timeRange.js";

const COLUMNS = `id, org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, created_at, ip`;

function clip(value, length) {
  return String(value ?? "").slice(0, length);
}

export async function insertOperationLog(db, entry) {
  const createdAt = entry.createdAt || formatTimestamp(new Date());
  await db.run(
    `INSERT INTO sys_operation_log
      (org_id, org_name, actor_id, actor_name, action, target_type, target_id, result, created_at, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      clip(entry.orgId, 32),
      clip(entry.orgName, 64),
      clip(entry.actorId, 32),
      clip(entry.actorName, 64),
      clip(entry.action, 32),
      clip(entry.targetType, 32),
      clip(entry.targetId, 64),
      entry.result === "失败" ? "失败" : "成功",
      createdAt,
      clip(entry.ip, 64),
    ]
  );
}

export async function operationScope(db, user) {
  const roles = await db.all(
    `SELECT r.data_scope FROM sys_role r
     INNER JOIN sys_user_role ur ON ur.role_id = r.id
     WHERE ur.user_id = ?`,
    [String(user.id)]
  );
  const scope = roles.reduce((min, row) => Math.min(min, Number(row.data_scope) || 4), 4);
  if (scope <= 1) return { kind: "all" };
  if (scope === 2) return { kind: "depts", ids: await deptTreeIds(db, user.dept_id) };
  if (scope === 3 || scope === 5) return { kind: "depts", ids: [String(user.dept_id || "")] };
  return { kind: "actor", actorId: String(user.id) };
}

async function deptTreeIds(db, deptId) {
  const rows = await db.all(
    "SELECT id, parent_id AS parentId, name, code, sort, status FROM sys_dept"
  );
  const tree = buildDeptTree(
    rows.map((row) => ({
      ...row,
      sort: Number(row.sort) || 0,
      status: Number(row.status) || 0,
    }))
  );
  return collectDeptIds(tree, deptId) || [String(deptId || "")];
}

/** 只生成带时间条件的一页查询。不统计总行数。 */
export function operationLogQuery(scope, query = {}) {
  const range = resolveTimeRange(query);
  if (range.error) return { error: range.error };
  const limit = pageLimit(query.limit);
  const where = ["created_at >= ?", "created_at <= ?"];
  const params = [range.from, range.to];

  if (scope.kind === "actor") {
    where.push("actor_id = ?");
    params.push(String(scope.actorId || ""));
  } else if (scope.kind === "depts") {
    const ids = (scope.ids || []).map(String).filter(Boolean);
    if (!ids.length) return { empty: true, limit };
    if (query.orgId && !ids.includes(String(query.orgId))) return { empty: true, limit };
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

function toItem(row) {
  return {
    id: String(row.id),
    orgId: row.org_id,
    orgName: row.org_name,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    result: row.result,
    createdAt:
      row.created_at instanceof Date ? formatTimestamp(row.created_at) : String(row.created_at),
    ip: row.ip,
  };
}

export async function queryOperationLogs(db, user, query = {}) {
  const scope = await operationScope(db, user);
  const built = operationLogQuery(scope, query);
  if (built.error) return { error: built.error };
  if (built.empty) return { list: [], nextCursor: null };
  const rows = await db.all(built.sql, built.params);
  const hasMore = rows.length > built.limit;
  const list = rows.slice(0, built.limit).map(toItem);
  const last = list[list.length - 1];
  return {
    list,
    nextCursor: hasMore && last ? { time: last.createdAt, id: last.id } : null,
  };
}
