import { BOX } from "../auth/boxAccess.js";
import { buildDeptTree } from "../../../shared/org.js";
import { ENDED, ENDED_SQL } from "../settings/taskFlow.js";
import { limits } from "./SampleController.js";

/**
 * 总览（补充协议 1.2.8–1.2.10）。
 * - 集团总览：所有项目分公司（顶级单位）和检测站（采样机构），各有多少箱子、什么状态；检测站另算在途来站、已到待检测、当天已检测。
 *   单位列表在服务端搜索、筛选、排序、分页，几千家公司也只传一页；全局汇总和 Top 分布单独给，供指标卡和图表用。
 * - 单位总览：一个分公司或检测站自己的箱子统计，日历选一天看当天的任务；检测站列出待检测和当天已检测的箱子。
 *   检测站三类明细（在途单、待检测、已检测）永远分页并带总数，不再因为超出上限整表清空。
 *
 * 单位的箱子按部门子树算（总公司还包括没分配单位的箱子），子树里另有检测站的，那部分算在检测站名下，不重复算。
 * 只列在自己数据范围内的单位；统计也只算范围内的部门。
 */

/** 运到检测站途中的状态：调拨寄出后、双向采样单寄回后。 */
const INBOUND = { 调拨: ["运送中", "待签收"], 采样: ["在途", "待核验"] };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const BOX_PAGE_SIZE = 20;
const COMPANY_PAGE_SIZE = 50;

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
function pageNum(value) {
  return Math.max(1, Number(value) || 1);
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

  /** 送检测站的单才有的 body；不是送检单返回 null。 */
  #inspectBody(row) {
    const body = JSON.parse(row.body);
    return body.inspect ? body : null;
  }

  /** 签收方：调拨看接收单位，双向采样单看寄出单位。 */
  #receiver(row) {
    return String((row.kind === "调拨" ? row.to_org_id : row.from_org_id) ?? "");
  }

  /** 送检测站的单：签收方落在 orgIds 里。 */
  #toStation(row, orgIds) {
    const body = this.#inspectBody(row);
    if (!body) return null;
    return orgIds.includes(this.#receiver(row)) ? body : null;
  }

  /** 箱子是哪家公司送来的。上千家公司靠这个键汇总，不把箱子混成一张表。 */
  #source(row, body) {
    const id = String(row.kind === "调拨" ? row.from_org_id || "" : body.orgId || "");
    const name =
      String((row.kind === "调拨" ? body.fromOrg : body.org || body.fromOrg) || "").trim() ||
      "未填单位";
    return { key: id || `name:${name}`, name };
  }

  /**
   * 集团页用：所有检测站的三个数一次算完。
   * 任务、待检测箱链接、当日检测各查一遍，按签收方归到检测站，不按站逐遍扫任务。
   */
  async #stationCounts(units, day) {
    const stations = units.filter((unit) => unit.type === "采样机构");
    const out = new Map(stations.map((unit) => [unit.id, { moving: 0, arrived: 0, inspected: 0 }]));
    if (!stations.length) return out;
    const orgToUnit = new Map();
    for (const unit of stations) for (const id of unit.orgIds) orgToUnit.set(id, unit.id);

    const active = await this.db.all(
      `SELECT t.id, t.kind, t.status, t.body, t.from_org_id, t.to_org_id FROM sample_task t
        WHERE t.status NOT IN (${ENDED_SQL}) AND t.body LIKE ? ORDER BY t.created_at DESC`,
      ['%"inspect":true%']
    );
    const waitingTasks = [];
    for (const row of active) {
      const body = this.#inspectBody(row);
      if (!body) continue;
      const unitId = orgToUnit.get(this.#receiver(row));
      if (!unitId) continue;
      const counts = out.get(unitId);
      if ((INBOUND[row.kind] || []).includes(row.status))
        counts.moving += (body.boxIds || []).length;
      else if (row.status === "待检测") waitingTasks.push({ id: row.id, unitId });
    }
    for (let i = 0; i < waitingTasks.length; i += 200) {
      const part = waitingTasks.slice(i, i + 200);
      const marks = part.map(() => "?").join(",");
      const links = await this.db.all(
        `SELECT task_id, COUNT(*) AS n FROM sample_task_box WHERE inspected_at IS NULL AND task_id IN (${marks}) GROUP BY task_id`,
        part.map((item) => item.id)
      );
      const unitOf = new Map(part.map((item) => [item.id, item.unitId]));
      for (const link of links) {
        const unitId = unitOf.get(link.task_id);
        if (unitId) out.get(unitId).arrived += Number(link.n) || 0;
      }
    }
    const { from, to } = dayRange(day);
    const doneRows = await this.db.all(
      `SELECT t.id, t.kind, t.body, t.from_org_id, t.to_org_id, COUNT(*) AS n
         FROM sample_task_box m JOIN sample_task t ON t.id=m.task_id
        WHERE m.inspected_at >= ? AND m.inspected_at <= ?
        GROUP BY t.id, t.kind, t.body, t.from_org_id, t.to_org_id`,
      [from.toISOString(), to.toISOString()]
    );
    for (const row of doneRows) {
      if (!this.#inspectBody(row)) continue;
      const unitId = orgToUnit.get(this.#receiver(row));
      if (unitId) out.get(unitId).inspected += Number(row.n) || 0;
    }
    return out;
  }

  /**
   * 单位页用：检测站的三个数，按来源公司汇总，三类明细各自分页。
   * 不选公司时给全部公司的第一页；选了公司只给那一家。总数随筛选口径，翻页不丢数据。
   */
  async #station(orgIds, day, withList, query = {}) {
    const companyFilter = String(query.company || "");
    const pages = {
      waiting: pageNum(query.waitingPage ?? query.boxPage),
      done: pageNum(query.donePage),
      inbound: pageNum(query.inboundPage),
    };
    const active = await this.db.all(
      `SELECT t.id, t.name, t.kind, t.status, t.body, t.from_org_id, t.to_org_id, t.created_at FROM sample_task t
        WHERE t.status NOT IN (${ENDED_SQL}) AND t.body LIKE ? ORDER BY t.created_at DESC`,
      ['%"inspect":true%']
    );
    const inbound = [];
    const waitingTasks = [];
    const companies = new Map();
    const seen = { inbound: 0, waiting: 0, done: 0 };
    const companyOf = (source) => {
      let row = companies.get(source.key);
      if (!row) {
        row = { key: source.key, name: source.name, moving: 0, arrived: 0, inspected: 0 };
        companies.set(source.key, row);
      }
      return row;
    };
    const keep = (kind, source, list, item) => {
      if (!withList) return;
      if (companyFilter && source.key !== companyFilter) return;
      const index = seen[kind]++;
      const start = (pages[kind] - 1) * BOX_PAGE_SIZE;
      if (index >= start && index < start + BOX_PAGE_SIZE) list.push(item);
    };
    for (const row of active) {
      const body = this.#toStation(row, orgIds);
      if (!body) continue;
      const source = this.#source(row, body);
      if ((INBOUND[row.kind] || []).includes(row.status)) {
        const boxes = (body.boxIds || []).length;
        companyOf(source).moving += boxes;
        keep("inbound", source, inbound, {
          id: row.id,
          name: body.name,
          kind: row.kind,
          status: row.status,
          from: source.name,
          fromKey: source.key,
          boxes,
          createdAt: row.created_at,
        });
      } else if (row.status === "待检测") {
        waitingTasks.push({ row, body, source });
      }
    }
    const waiting = [];
    for (let i = 0; i < waitingTasks.length; i += 200) {
      const part = waitingTasks.slice(i, i + 200);
      const ids = part.map((item) => item.row.id);
      const marks = ids.map(() => "?").join(",");
      const links = await this.db.all(
        `SELECT m.task_id, m.box_id, m.opens_start, m.opens_end, b.name, b.opens FROM sample_task_box m LEFT JOIN sample_box b ON b.id=m.box_id
          WHERE m.inspected_at IS NULL AND m.task_id IN (${marks})`,
        ids
      );
      const signedRows = await this.db.all(
        `SELECT task_id, MIN(created_at) AS created_at FROM sample_task_log WHERE status='待检测' AND task_id IN (${marks}) GROUP BY task_id`,
        ids
      );
      const signedAt = new Map(signedRows.map((item) => [item.task_id, item.created_at]));
      const byTask = new Map(part.map((item) => [item.row.id, item]));
      for (const link of links) {
        const item = byTask.get(link.task_id);
        if (!item) continue;
        companyOf(item.source).arrived += 1;
        const opens =
          link.opens_start == null
            ? null
            : Math.max(
                0,
                Number(link.opens_end ?? link.opens ?? link.opens_start) - Number(link.opens_start)
              );
        keep("waiting", item.source, waiting, {
          boxId: link.box_id,
          boxName: link.name || link.box_id,
          taskId: item.row.id,
          taskName: item.body.name,
          from: item.source.name,
          fromKey: item.source.key,
          signedAt: signedAt.get(link.task_id) || "",
          opensDuring: opens,
          maxOpens: Number.isInteger(item.body.maxOpens) ? item.body.maxOpens : null,
        });
      }
    }
    const { from, to } = dayRange(day);
    const doneRows = await this.db.all(
      `SELECT m.box_id, m.inspected_at, m.inspected_by, m.opens_start, m.opens_end, b.name, t.id AS task_id, t.kind, t.body, t.from_org_id, t.to_org_id
         FROM sample_task_box m JOIN sample_task t ON t.id=m.task_id LEFT JOIN sample_box b ON b.id=m.box_id
        WHERE m.inspected_at >= ? AND m.inspected_at <= ? ORDER BY m.inspected_at DESC`,
      [from.toISOString(), to.toISOString()]
    );
    const done = [];
    for (const row of doneRows) {
      const body = this.#toStation(row, orgIds);
      if (!body) continue;
      const source = this.#source(row, body);
      companyOf(source).inspected += 1;
      const opens =
        row.opens_start == null
          ? null
          : Math.max(0, Number(row.opens_end ?? row.opens_start) - Number(row.opens_start));
      keep("done", source, done, {
        boxId: row.box_id,
        boxName: row.name || row.box_id,
        taskId: row.task_id,
        taskName: body.name,
        from: source.name,
        fromKey: source.key,
        inspectedAt: row.inspected_at,
        inspectedBy: row.inspected_by || "",
        opensDuring: opens,
      });
    }
    const companyList = [...companies.values()]
      .filter((item) => item.moving || item.arrived || item.inspected)
      .sort(
        (a, b) =>
          b.moving + b.arrived + b.inspected - (a.moving + a.arrived + a.inspected) ||
          a.name.localeCompare(b.name, "zh")
      );
    const counts = {
      moving: companyList.reduce((n, item) => n + item.moving, 0),
      arrived: companyList.reduce((n, item) => n + item.arrived, 0),
      inspected: companyList.reduce((n, item) => n + item.inspected, 0),
    };
    if (!withList) return counts;
    // 来源公司也可能上千：搜索 + 分页只传一页
    const companyQ = String(query.companyQ || "")
      .trim()
      .toLowerCase();
    const matchedCompanies = companyQ
      ? companyList.filter((item) => item.name.toLowerCase().includes(companyQ))
      : companyList;
    const companyPage = pageNum(query.companyPage);
    const companiesOut = matchedCompanies.slice(
      (companyPage - 1) * COMPANY_PAGE_SIZE,
      companyPage * COMPANY_PAGE_SIZE
    );
    const boxes = {
      pageSize: BOX_PAGE_SIZE,
      waiting: seen.waiting,
      done: seen.done,
      inbound: seen.inbound,
      waitingPage: pages.waiting,
      donePage: pages.done,
      inboundPage: pages.inbound,
    };
    return {
      ...counts,
      companies: companiesOut,
      companyTotal: matchedCompanies.length,
      companyPage,
      companyPageSize: COMPANY_PAGE_SIZE,
      boxes,
      inbound,
      waiting,
      done,
    };
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
        task: {
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
        },
        start,
        end,
      });
    }
    return list;
  }

  /** GET /api/v1/sample/overview?q=&type=&sort=&page=&pageSize=：集团总览。 */
  async group(ctx) {
    this.require(ctx);
    const today = localDay(new Date());
    const units = await this.#units(ctx);
    const byOrg =
      typeof this.boxes.statsByOrg === "function" ? await this.boxes.statsByOrg(limits()) : null;
    const roll = (orgIds) => {
      if (!byOrg) return this.#stats(orgIds);
      const out = {
        total: 0,
        counts: { 在途: 0, 未使用: 0, 停用: 0, 待激活: 0 },
        flags: { alert: 0, offline: 0, low: 0, lid: 0, ready: 0 },
      };
      for (const id of orgIds) {
        const part = byOrg.get(String(id));
        if (!part) continue;
        out.total += part.total;
        for (const key of Object.keys(out.counts)) out.counts[key] += part.counts[key] || 0;
        for (const key of Object.keys(out.flags)) out.flags[key] += part.flags[key] || 0;
      }
      return out;
    };
    const stationCounts = await this.#stationCounts(units, today);
    const list = [];
    for (const unit of units) {
      const stats = await roll(unit.orgIds);
      const station =
        unit.type === "采样机构"
          ? stationCounts.get(unit.id) || { moving: 0, arrived: 0, inspected: 0 }
          : null;
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
    const all = [...new Set(units.flatMap((unit) => unit.orgIds))];
    const total = all.length ? await roll(all) : null;
    const stationUnits = list.filter((unit) => unit.station);
    const stationTotal = stationUnits.length
      ? stationUnits.reduce(
          (sum, unit) => ({
            moving: sum.moving + unit.station.moving,
            arrived: sum.arrived + unit.station.arrived,
            inspected: sum.inspected + unit.station.inspected,
          }),
          { moving: 0, arrived: 0, inspected: 0 }
        )
      : null;
    const byBoxes = (a, b) =>
      (b.stats?.total || 0) - (a.stats?.total || 0) || a.name.localeCompare(b.name, "zh");
    const top = list
      .filter((unit) => !unit.station && unit.stats?.total)
      .sort(byBoxes)
      .slice(0, 8)
      .map((unit) => ({
        id: unit.id,
        name: unit.name,
        total: unit.stats.total,
        moving: unit.stats.counts["在途"] || 0,
        idle: unit.stats.counts["未使用"] || 0,
        pending: unit.stats.counts["待激活"] || 0,
      }));

    // 搜索、类型筛选、排序、分页都在服务端做，页面只拿一页
    const q = String(ctx.query.q || "")
      .trim()
      .toLowerCase();
    const type = String(ctx.query.type || "");
    const sort = String(ctx.query.sort || "");
    const pageSize = Math.min(100, Math.max(5, Number(ctx.query.pageSize) || 20));
    const page = pageNum(ctx.query.page);
    let matched = list;
    if (type === "branch") matched = matched.filter((unit) => !unit.station);
    else if (type === "station") matched = matched.filter((unit) => unit.station);
    if (q)
      matched = matched.filter(
        (unit) => unit.name.toLowerCase().includes(q) || unit.path.toLowerCase().includes(q)
      );
    // 不传 sort 保持组织树顺序；传了才按指标排
    if (sort) {
      const metric = (unit) => {
        if (sort === "moving") return unit.stats?.counts["在途"] || 0;
        if (sort === "alert")
          return (
            (unit.stats?.flags.alert || 0) +
            (unit.stats?.flags.offline || 0) +
            (unit.stats?.flags.low || 0)
          );
        return unit.stats?.total || 0;
      };
      matched = [...matched].sort(
        (a, b) =>
          (sort === "name" ? 0 : metric(b) - metric(a)) || a.name.localeCompare(b.name, "zh")
      );
    }
    ctx.ok({
      day: today,
      total,
      stationTotal,
      branchTotal: list.filter((unit) => !unit.station).length,
      stationCount: stationUnits.length,
      unitTotal: matched.length,
      page,
      pageSize,
      top,
      units: matched.slice((page - 1) * pageSize, page * pageSize),
    });
  }

  /** GET /api/v1/sample/overview/:orgId?day=&month=&company=&waitingPage=&donePage=&inboundPage=：单位总览。 */
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
      station:
        unit.type === "采样机构"
          ? await this.#station(unit.orgIds, day, true, {
              company: String(ctx.query.company || ""),
              companyQ: ctx.query.companyQ,
              companyPage: ctx.query.companyPage,
              waitingPage: ctx.query.waitingPage ?? ctx.query.boxPage,
              donePage: ctx.query.donePage,
              inboundPage: ctx.query.inboundPage,
            })
          : null,
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
        .filter((item) => item.start <= dayTo && upTo(item.end) >= dayFrom)
        .map((item) => item.task);
      // 日历：这个月每天有几张进行中的单
      const calendar = {};
      const last = new Date(year, mon, 0).getDate();
      for (let d = 1; d <= last; d++) {
        const from = new Date(year, mon - 1, d, 0, 0, 0, 0);
        if (from > now) break;
        const to = new Date(year, mon - 1, d, 23, 59, 59, 999);
        const n = tasks.filter((item) => item.start <= to && upTo(item.end) >= from).length;
        if (n) calendar[localDay(from)] = n;
      }
      result.calendar = calendar;
    }
    ctx.ok(result);
  }
}
