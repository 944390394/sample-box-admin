import { buildDeptTree, collectDeptIds } from "../../../shared/org.js";
import { formatTimestamp } from "../domain/Clock.js";
import { parseTimestamp } from "./timeRange.js";

const MAX_DAYS = 31;

/**
 * 只按天汇总 sys_operation_log。
 * 浏览量是操作条数，访客量是不重复的操作者。
 * 累计访客按整个范围去重，不是把每天的访客量相加。
 * 不读上报流水。
 */

function dayExpression(dialect) {
  if (dialect === "mysql") return "DATE_FORMAT(created_at, '%Y-%m-%d')";
  return "substr(created_at, 1, 10)";
}

function formatDay(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function toCount(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function growthRate(today, yesterday) {
  if (!yesterday) return 0;
  return (today - yesterday) / yesterday;
}

function dayKey(value) {
  if (value instanceof Date) return formatDay(value);
  return String(value ?? "").slice(0, 10);
}

function orgClause(scope) {
  if (!scope || scope.kind === "none") return { empty: true, where: [], params: [] };
  if (scope.kind === "depts") {
    const ids = (scope.ids || []).map(String).filter(Boolean);
    if (!ids.length) return { empty: true, where: [], params: [] };
    return {
      empty: false,
      where: [`org_id IN (${ids.map(() => "?").join(", ")})`],
      params: ids,
    };
  }
  return { empty: false, where: [], params: [] };
}

export function dailyStatsSql(dialect, scope) {
  const org = orgClause(scope);
  if (org.empty) return { empty: true, sql: "", params: [] };
  const day = dayExpression(dialect);
  const where = ["created_at >= ?", "created_at <= ?", ...org.where];
  return {
    empty: false,
    params: org.params,
    sql: `SELECT ${day} AS day, COUNT(*) AS pv, COUNT(DISTINCT actor_id) AS uv
      FROM sys_operation_log
      WHERE ${where.join(" AND ")}
      GROUP BY ${day}`,
  };
}

export function totalStatsSql(scope) {
  const org = orgClause(scope);
  if (org.empty) return { empty: true, sql: "", params: [] };
  const where = org.where.length ? ` WHERE ${org.where.join(" AND ")}` : "";
  return {
    empty: false,
    params: org.params,
    sql: `SELECT COUNT(*) AS pv, COUNT(DISTINCT actor_id) AS uv FROM sys_operation_log${where}`,
  };
}

function mapDept(row) {
  return {
    id: String(row.id),
    parentId: String(row.parentId ?? ""),
    name: row.name,
    code: row.code,
    sort: Number(row.sort) || 0,
    status: Number(row.status) || 0,
  };
}

function rootDept(rows, deptId) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  let current = byId.get(String(deptId));
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const parentId = current.parentId;
    if (!parentId || parentId === "0" || !byId.has(parentId)) return current;
    current = byId.get(parentId);
  }
  return current;
}

function isHeadquarters(dept) {
  return dept?.code === "HQ" || dept?.name === "总公司";
}

export async function analyticsScope(db, user) {
  const deptId = String(user?.dept_id || "");
  if (!deptId) return { kind: "none" };
  const rows = (
    await db.all("SELECT id, parent_id AS parentId, name, code, sort, status FROM sys_dept")
  ).map(mapDept);
  const root = rootDept(rows, deptId);
  if (!root) return { kind: "none" };
  if (isHeadquarters(root)) return { kind: "all" };
  const ids = collectDeptIds(buildDeptTree(rows), root.id) || [];
  if (!ids.length) return { kind: "none" };
  return { kind: "depts", ids };
}

export function resolveTrendDates(query = {}) {
  const startText = String(query.startDate ?? "").trim();
  const endText = String(query.endDate ?? "").trim();
  if (!startText || !endText) return { error: "请填写开始和结束日期" };
  const start = parseTimestamp(startText, false);
  const end = parseTimestamp(endText, false);
  if (!start || !end) return { error: "时间格式不正确" };
  const first = startOfDay(start);
  const last = startOfDay(end);
  if (first.getTime() > last.getTime()) return { error: "开始时间不能晚于结束时间" };
  const dates = [];
  const cursor = new Date(first);
  while (cursor.getTime() <= last.getTime()) {
    dates.push(formatDay(cursor));
    if (dates.length > MAX_DAYS) return { error: "一次最长查询 31 天" };
    cursor.setDate(cursor.getDate() + 1);
  }
  return { dates, from: formatTimestamp(first), to: formatTimestamp(endOfDay(last)) };
}

async function loadDaily(db, scope, from, to) {
  const built = dailyStatsSql(db.dialect, scope);
  if (built.empty) return [];
  return db.all(built.sql, [from, to, ...built.params]);
}

async function loadTotal(db, scope) {
  const built = totalStatsSql(scope);
  if (built.empty) return { pv: 0, uv: 0 };
  return (await db.get(built.sql, built.params)) || { pv: 0, uv: 0 };
}

function emptyOverview() {
  return {
    todayUvCount: 0,
    totalUvCount: 0,
    uvGrowthRate: 0,
    todayPvCount: 0,
    totalPvCount: 0,
    pvGrowthRate: 0,
  };
}

export async function queryVisitOverview(db, user, now = new Date()) {
  const scope = await analyticsScope(db, user);
  if (scope.kind === "none") return emptyOverview();
  const today = startOfDay(now);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const [daily, total] = await Promise.all([
    loadDaily(db, scope, formatTimestamp(yesterday), formatTimestamp(endOfDay(today))),
    loadTotal(db, scope),
  ]);
  const byDay = new Map(daily.map((row) => [dayKey(row.day), row]));
  const todayRow = byDay.get(formatDay(today));
  const yesterdayRow = byDay.get(formatDay(yesterday));
  const todayPvCount = toCount(todayRow?.pv);
  const yesterdayPv = toCount(yesterdayRow?.pv);
  const todayUvCount = toCount(todayRow?.uv);
  const yesterdayUv = toCount(yesterdayRow?.uv);
  return {
    todayUvCount,
    totalUvCount: toCount(total.uv),
    uvGrowthRate: growthRate(todayUvCount, yesterdayUv),
    todayPvCount,
    totalPvCount: toCount(total.pv),
    pvGrowthRate: growthRate(todayPvCount, yesterdayPv),
  };
}

export async function queryVisitTrend(db, user, query = {}) {
  const range = resolveTrendDates(query);
  if (range.error) return { error: range.error };
  const pvList = range.dates.map(() => 0);
  const uvList = range.dates.map(() => 0);
  const scope = await analyticsScope(db, user);
  if (scope.kind !== "none") {
    const rows = await loadDaily(db, scope, range.from, range.to);
    const index = new Map(range.dates.map((day, at) => [day, at]));
    for (const row of rows) {
      const at = index.get(dayKey(row.day));
      if (at === undefined) continue;
      pvList[at] = toCount(row.pv);
      uvList[at] = toCount(row.uv);
    }
  }
  return { dates: range.dates, pvList, uvList };
}
