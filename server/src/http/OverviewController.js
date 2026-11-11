import { BOX } from "../auth/boxAccess.js";
import { buildDeptTree } from "../../../shared/org.js";
import { ENDED, ENDED_SQL } from "../settings/taskFlow.js";
import { limits } from "./SampleController.js";

/**
 * 总览（补充协议 1.2.8–1.2.10）。
 * - 集团总览：所有项目分公司（顶级单位）和检测站（采样机构），各有多少箱子、什么状态；检测站另算在途来站、已到待检测、当天已检测。
 * - 单位总览：一个分公司或检测站自己的箱子统计，日历选一天看当天的任务；检测站列出待检测和当天已检测的箱子。
 *
 * 单位的箱子按部门子树算（总公司还包括没分配单位的箱子），子树里另有检测站的，那部分算在检测站名下，不重复算。
 * 只列在自己数据范围内的单位；统计也只算范围内的部门。
 */

/** 运到检测站途中的状态：调拨寄出后、双向采样单寄回后。 */
const INBOUND = { 调拨: ["运送中", "待签收"], 采样: ["在途", "待核验"] };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

function pad(n) {
  return String(n).padStart(2, "0");
}
function localDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
/** 本地日期的起止时刻。 */
function dayRange(day) {
  const from = new Date(`${day}T00:00:00.000`);
  const to = new Date(`${day}T23:59:59.999`);
  return { from, to };
}

export class OverviewController {
  constructor(boxes, db) {
    this.boxes = boxes;
    this.db = db;
  }

  require(ctx) {
    if (!ctx.access?.perms?.has("monitor:overview"))
      throw Object.assign(new Error("没有「查看总览」权限"), {
        httpStatus: 403,
        publicCode: "A0301",
      });
  }

  /** 部门树、能看到的单位（顶级单位 + 检测站），每个单位的部门编号（扣掉嵌在里面的检测站）。 */
  async #units(ctx) {
    const rows = (
      await this.db.all("SELECT id, parent_id, name, type, sort, status FROM sys_dept")
    ).map((row) => ({
      id: String(row.id),
      parentId: String(row.parent_id),
      name: row.name,
      type: row.type || "公司",
      sort: Number(row.sort) || 0,
      status: Number(row.status ?? 1),
    }));
    const tree = buildDeptTree(rows);
    const hq = tree[0]?.id || "";
    const byId = new Map(rows.map((row) => [row.id, row]));
    const pathOf = (id) => {
      const names = [];
      const seen = new Set();
      for (
        let cursor = byId.get(id);
        cursor && !seen.has(cursor.id);
        cursor = byId.get(cursor.parentId)
      ) {
        seen.add(cursor.id);
        names.unshift(cursor.name);
      }
      return names.join(" / ");
    };
    const chosen = [];
    const walk = (node, depth) => {
      // 采样机构就是检测站：不管在哪一级都单列
      if (node.status !== 0 && (depth === 0 || node.type === "采样机构")) chosen.push(node);
      (node.children || []).forEach((child) => walk(child, depth + 1));
    };
    tree.forEach((node) => walk(node, 0));
    const unitIds = new Set(chosen.map((node) => node.id));
    // 子树：碰到别的检测站就停，它自己是一个单位
    const subtree = (node) => {
      const ids = [node.id];
      const go = (current) =>
        (current.children || []).forEach((child) => {
          if (unitIds.has(child.id)) return;
          ids.push(child.id);
          go(child);
        });
      go(node);
      if (node.id === hq) ids.push("");
      return ids;
    };
    const scope = ctx.access.scope;
    const units = [];
    for (const node of chosen) {
      let ids = subtree(node);
      if (scope && !scope.all) {
        if (!scope.orgIds.includes(node.id)) continue;
        ids = ids.filter((id) => scope.orgIds.includes(id));
      }
      units.push({
        id: node.id,
        name: node.name,
        type: node.type,
        hq: node.id === hq,
        path: pathOf(node.id),
        orgIds: ids,
      });
    }
    return units;
  }

  async #stats(orgIds) {
    if (typeof this.boxes.stats !== "function") return null;
    return this.boxes.stats({ scope: { all: false, orgIds, ownerIds: [] }, limits: limits() });
  }

  /** 送检测站的单：签收方（调拨的接收单位、双向采样单的寄出单位）落在 orgIds 里。 */
  #toStation(row, orgIds) {
    const body = JSON.parse(row.body);
    if (!body.inspect) return null;
    const receiver = row.kind === "调拨" ? row.to_org_id : row.from_org_id;
    return orgIds.includes(String(receiver ?? "")) ? body : null;
  }

  /** 检测站的三个数：在途来站、已到待检测、这一天已检测；带明细时给列表。 */
  async #station(orgIds, day, withList) {
    const active = await this.db.all(
      `SELECT t.id, t.name, t.kind, t.status, t.body, t.from_org_id, t.to_org_id, t.created_at FROM sample_task t
        WHERE t.status NOT IN (${ENDED_SQL}) AND t.body LIKE ? ORDER BY t.created_at DESC LIMIT 2000`,
      ['%"inspect":true%']
    );
    const inbound = [];
    const waitingTasks = [];
    for (const row of active) {
      const body = this.#toStation(row, orgIds);
      if (!body) continue;
      if ((INBOUND[row.kind] || []).includes(row.status)) {
        inbound.push({
          id: row.id,
          name: body.name,
          kind: row.kind,
          status: row.status,
          from: body.fromOrg || "",
          boxes: (body.boxIds || []).length,
          createdAt: row.created_at,
        });
      } else if (row.status === "待检测") {
        waitingTasks.push({ row, body });
      }
    }
    const waiting = [];
    for (const { row, body } of waitingTasks) {
      const links = await this.db.all(
        `SELECT m.box_id, m.opens_start, m.opens_end, b.name, b.opens FROM sample_task_box m LEFT JOIN sample_box b ON b.id=m.box_id
          WHERE m.task_id=? AND m.inspected_at IS NULL`,
        [row.id]
      );
      const signed = await this.db.get(
        "SELECT created_at FROM sample_task_log WHERE task_id=? AND status='待检测' ORDER BY created_at LIMIT 1",
        [row.id]
      );
      for (const link of links) {
        const opens =
          link.opens_start == null
            ? null
            : Math.max(
                0,
                Number(link.opens_end ?? link.opens ?? link.opens_start) - Number(link.opens_start)
              );
        waiting.push({
          boxId: link.box_id,
          boxName: link.name || link.box_id,
          taskId: row.id,
          taskName: body.name,
          from: body.fromOrg || "",
          signedAt: signed?.created_at || "",
          opensDuring: opens,
          maxOpens: Number.isInteger(body.maxOpens) ? body.maxOpens : null,
        });
      }
    }
    const { from, to } = dayRange(day);
    const doneRows = await this.db.all(
      `SELECT m.box_id, m.inspected_at, m.inspected_by, m.opens_start, m.opens_end, b.name, t.id AS task_id, t.kind, t.body, t.from_org_id, t.to_org_id
         FROM sample_task_box m JOIN sample_task t ON t.id=m.task_id LEFT JOIN sample_box b ON b.id=m.box_id
        WHERE m.inspected_at >= ? AND m.inspected_at <= ? ORDER BY m.inspected_at DESC LIMIT 2000`,
      [from.toISOString(), to.toISOString()]
    );
    const done = [];
    for (const row of doneRows) {
      const body = this.#toStation(row, orgIds);
      if (!body) continue;
      const opens =
        row.opens_start == null
          ? null
          : Math.max(0, Number(row.opens_end ?? row.opens_start) - Number(row.opens_start));
      done.push({
        boxId: row.box_id,
        boxName: row.name || row.box_id,
        taskId: row.task_id,
        taskName: body.name,
        from: body.fromOrg || "",
        inspectedAt: row.inspected_at,
        inspectedBy: row.inspected_by || "",
        opensDuring: opens,
      });
    }
    const counts = {
      moving: inbound.reduce((n, task) => n + task.boxes, 0),
      arrived: waiting.length,
      inspected: done.length,
    };
    return withList ? { ...counts, inbound, waiting, done } : counts;
  }

  /**
   * 和单位有关的任务（寄出、接收或采样单位在单位子树里），算出每张单从哪天到哪天：
   * 创建那天开始，结束的到最后一条结束流转为止，没结束的到今天。
   */
  async #tasks(orgIds, monthStart, monthEnd) {
    if (!orgIds.length) return [];
    const marks = orgIds.map(() => "?").join(",");
    const likes = orgIds
      .filter(Boolean)
      .map(() => "t.body LIKE ?")
      .join(" OR ");
    const rows = await this.db.all(
      `SELECT t.id, t.name, t.kind, t.status, t.body, t.created_at FROM sample_task t
        WHERE t.created_at <= ? AND (t.from_org_id IN (${marks}) OR t.to_org_id IN (${marks})${likes ? ` OR ${likes}` : ""})
        ORDER BY t.created_at DESC LIMIT 2000`,
      [
        monthEnd.toISOString(),
        ...orgIds,
        ...orgIds,
        ...orgIds.filter(Boolean).map((id) => `%"orgId":"${id.replace(/[%_"]/g, "")}"%`),
      ]
    );
    const ended = rows.filter((row) => ENDED.includes(row.status));
    const endAt = new Map();
    for (let i = 0; i < ended.length; i += 200) {
      const part = ended.slice(i, i + 200);
      const logs = await this.db.all(
        `SELECT task_id, MAX(created_at) AS at FROM sample_task_log WHERE task_id IN (${part.map(() => "?").join(",")}) GROUP BY task_id`,
        part.map((row) => row.id)
      );
      for (const log of logs) endAt.set(log.task_id, log.at);
    }
    const list = [];
    for (const row of rows) {
      const body = JSON.parse(row.body);
      const start = new Date(row.created_at);
      const end = ENDED.includes(row.status) ? new Date(endAt.get(row.id) || row.created_at) : null;
      if (end && end < monthStart) continue;
      list.push({
        id: row.id,
        name: body.name,
        kind: row.kind,
        status: row.status,
        createdAt: row.created_at,
        endedAt: end ? end.toISOString() : "",
        from: body.fromOrg || "",
        to: row.kind === "调拨" ? body.toOrg || "" : body.org || "",
        boxes: (body.boxIds || []).length,
        inspect: Boolean(body.inspect),
        start,
        end,
      });
    }
    return list;
  }

  /** GET /api/v1/sample/overview：集团总览。 */
  async group(ctx) {
    this.require(ctx);
    const today = localDay(new Date());
    const units = await this.#units(ctx);
    const list = [];
    for (const unit of units) {
      const stats = await this.#stats(unit.orgIds);
      const station =
        unit.type === "采样机构" ? await this.#station(unit.orgIds, today, false) : null;
      list.push({
        id: unit.id,
        name: unit.name,
        type: unit.type,
        hq: unit.hq,
        path: unit.path,
        stats,
        station,
      });
    }
    const all = units.flatMap((unit) => unit.orgIds);
    ctx.ok({
      day: today,
      total: all.length ? await this.#stats([...new Set(all)]) : null,
      units: list,
    });
  }

  /** GET /api/v1/sample/overview/:orgId?day=&month=：单位总览。 */
  async unit(ctx) {
    this.require(ctx);
    const units = await this.#units(ctx);
    const unit = units.find((item) => item.id === String(ctx.params.orgId || ""));
    if (!unit)
      throw Object.assign(new Error("这个单位不存在或不在你的数据范围内"), {
        httpStatus: 404,
        publicCode: "A0404",
      });
    const now = new Date();
    const day = DAY.test(String(ctx.query.day || "")) ? String(ctx.query.day) : localDay(now);
    const month = MONTH.test(String(ctx.query.month || ""))
      ? String(ctx.query.month)
      : day.slice(0, 7);
    const [year, mon] = month.split("-").map(Number);
    const monthStart = new Date(year, mon - 1, 1, 0, 0, 0, 0);
    const monthEnd = new Date(year, mon, 0, 23, 59, 59, 999);
    const result = {
      unit: { id: unit.id, name: unit.name, type: unit.type, hq: unit.hq, path: unit.path },
      day,
      month,
      stats: await this.#stats(unit.orgIds),
      station: unit.type === "采样机构" ? await this.#station(unit.orgIds, day, true) : null,
      tasks: null,
      calendar: null,
    };
    if (ctx.access.perms.has(BOX.task)) {
      // 选中那天和那个月都要：取两者的并集范围
      const { from: dayFrom, to: dayTo } = dayRange(day);
      const lo = dayFrom < monthStart ? dayFrom : monthStart;
      const hi = dayTo > monthEnd ? dayTo : monthEnd;
      const tasks = await this.#tasks(unit.orgIds, lo, hi);
      const upTo = (end) => end || now;
      result.tasks = tasks
        .filter((task) => task.start <= dayTo && upTo(task.end) >= dayFrom)
        .map((task) => {
          const rest = { ...task };
          delete rest.start;
          delete rest.end;
          return rest;
        });
      // 日历：这个月每天有几张进行中的单
      const calendar = {};
      const last = new Date(year, mon, 0).getDate();
      for (let d = 1; d <= last; d++) {
        const from = new Date(year, mon - 1, d, 0, 0, 0, 0);
        if (from > now) break;
        const to = new Date(year, mon - 1, d, 23, 59, 59, 999);
        const n = tasks.filter((task) => task.start <= to && upTo(task.end) >= from).length;
        if (n) calendar[localDay(from)] = n;
      }
      result.calendar = calendar;
    }
    ctx.ok(result);
  }
}
