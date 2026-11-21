import {
  BOX,
  boxNameCell,
  resolveDeptLimit,
  resolvePerms,
  resolveScope,
} from "../auth/boxAccess.js";
import { buildDeptTree } from "../../../shared/org.js";
import { audit } from "../log/audit.js";
import { companyLimits } from "../settings/companyPolicy.js";
import { ENDED, ENDED_SQL, isLegacySample } from "../settings/taskFlow.js";
import { limits } from "./SampleController.js";
import { ESCAPE_SQL, likePattern } from "../store/sqlText.js";

/**
 * 总览（补充协议 1.2.8–1.2.10）。
 * - 集团总览：所有项目分公司（顶级单位）和唯一检测站（type=检测站，组织简化 B1b），各有多少箱子、什么状态；
 *   检测站另算四数＋今日（P13）：在途来站 moving、累计已到站 arrivedTotal、累计已开箱 openedTotal、
 *   当前未开箱 unopenedNow、今日已开箱 todayOpened。
 *   单位列表在服务端搜索、筛选、排序、分页，几千家公司也只传一页；全局汇总和 Top 分布单独给，供指标卡和图表用。
 * - 单位总览：一个分公司或检测站自己的箱子统计，日历选一天看当天的任务；检测站列出待检测和当天已检测的箱子。
 *   检测站三类明细（在途单、待检测、已检测）永远分页并带总数，不再因为超出上限整表清空。
 *
 * 单位的箱子按部门子树算（总公司还包括没分配单位的箱子），子树里另有检测站的，那部分算在检测站名下，不重复算。
 * 只列在自己数据范围内的单位；统计也只算范围内的部门。范围落在科室/机构下级时，沿 parent 链
 * 把最近的单位锚点（一级公司或检测站）纳入，保证有权角色至少落到一个匹配其范围的单位页；
 * 仅本人等没有单位范围时 units 为空，group 返回 myUnitId=null，由前端渲染带引导的空态。
 */

/**
 * 运到检测站途中的状态（P13 moving）：
 * - 采样＝合并单主口径 [在途,待签收]；待核验 是旧双向采样单寄回段（只读兼容）；
 * - 调拨/送检＝legacy 兼容分支：056 已把存量送检/旧采样映射成合并口径（B1c/P7），
 *   这两支只服务尚未跑 056 的库；全量迁移完成后退场（R9 之后决策）。
 */
const INBOUND = {
  采样: ["在途", "待签收", "待核验"],
  调拨: ["运送中", "待签收"],
  送检: ["运送中", "待签收"],
};
/** 累计已到站（P13 arrivedTotal）：单到这些状态就算箱子到过站（含已检测/退回，按箱快照计数）。 */
const ARRIVED = ["待检测", "已检测", "退回中", "已退回"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const BOX_PAGE_SIZE = 20;
const COMPANY_PAGE_SIZE = 50;

/** 检测站四数＋今日的内部累加器（别名在出口统一附）。 */
function countsZero() {
  return { moving: 0, arrivedTotal: 0, openedTotal: 0, unopenedNow: 0, todayOpened: 0 };
}
/**
 * 旧字段别名保留一版防前端瞬断（B2 切新字段后删）：
 * arrived＝当前未开箱（旧「已到·未开箱检测」）、inspected＝今日已开箱（旧「今天已开箱检测」）。
 */
function withAliases(counts) {
  return { ...counts, arrived: counts.unopenedNow, inspected: counts.todayOpened };
}

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
  /** 视角切换审计去重：每个 actor 上一次模拟的「单位|角色」，轮询同参不重复落库。 */
  #lastViewAs = new Map();

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

  /**
   * 模拟视角（仅系统管理员）：asOrgId + asRoleCode 按「该单位＋该角色」的数据范围与权限
   * 只读预览总览。与 resolveAccess 同口径——hypUser 把部门换成模拟单位、roles 只留该角色行，
   * scope 按该单位「最大数据范围」封顶、perms 取角色权限∩部门上限（系统管理员角色不受部门上限约束）。
   * 只产出本次计算用的 access，绝不改 ctx.access（真实权限、requireAccess 的 per-request 缓存不被污染）。
   * 未模拟返回 null；非 ADMIN 带参 403 A0301；单位/角色不存在或停用、只传一半参数 → 友好 400 A0400。
   */
  async #viewAs(ctx) {
    const asOrgId = String(ctx.query.asOrgId ?? "").trim();
    const asRoleCode = String(ctx.query.asRoleCode ?? "").trim();
    if (!asOrgId && !asRoleCode) return null;
    if (!ctx.access?.roles?.includes("ADMIN"))
      throw Object.assign(new Error("只有系统管理员可以切换总览视角"), {
        httpStatus: 403,
        publicCode: "A0301",
      });
    if (!asOrgId || !asRoleCode)
      throw Object.assign(new Error("模拟视角需要同时选择单位和角色"), {
        httpStatus: 400,
        publicCode: "A0400",
      });
    const dept = await this.db.get("SELECT id, name, status FROM sys_dept WHERE id = ?", [asOrgId]);
    if (!dept || Number(dept.status) === 0)
      throw Object.assign(new Error("模拟的单位不存在或已停用"), {
        httpStatus: 400,
        publicCode: "A0400",
      });
    const role = await this.db.get(
      "SELECT id, code, name, data_scope, status FROM sys_role WHERE code = ?",
      [asRoleCode]
    );
    if (!role || Number(role.status) !== 1)
      throw Object.assign(new Error("模拟的角色不存在或已停用"), {
        httpStatus: 400,
        publicCode: "A0400",
      });
    const roles = [
      { id: String(role.id), code: role.code, data_scope: role.data_scope, status: 1 },
    ];
    const limit =
      role.code === "ADMIN"
        ? { perms: null, maxScope: null }
        : await resolveDeptLimit(this.db, asOrgId);
    const hypUser = { ...ctx.user, dept_id: asOrgId };
    const rolePerms = await resolvePerms(this.db, roles);
    const perms = limit.perms
      ? new Set([...rolePerms].filter((code) => limit.perms.has(code)))
      : rolePerms;
    const scope = await resolveScope(this.db, hypUser, roles, limit.maxScope);
    return {
      access: { userId: String(ctx.user.id), roles: [role.code], perms, scope },
      viewAs: {
        orgId: String(dept.id),
        orgName: dept.name,
        roleCode: role.code,
        roleLabel: role.name,
      },
    };
  }

  /**
   * 切换视角写审计：actor 是真实管理员，detail 记模拟的单位与角色。
   * 同一 actor 连续轮询同一「单位|角色」只记一次（退出视角后清空，再进入会再记）。
   */
  async #auditViewAs(ctx, viewAs) {
    const key = String(ctx.user.id);
    const combo = `${viewAs.orgId}|${viewAs.roleCode}`;
    if (this.#lastViewAs.get(key) === combo) return;
    this.#lastViewAs.set(key, combo);
    await audit(this.db, {
      actorId: key,
      actorName: ctx.user.nickname || ctx.user.username,
      action: "切换总览视角",
      targetType: "overview",
      targetId: viewAs.orgId,
      result: "成功",
      detail: { asOrgId: viewAs.orgId, asRoleCode: viewAs.roleCode },
      ip: ctx.ip || "",
    });
  }

  /** 模拟视角的 access 与审计入口：group/unit 共用，退出时清去重键。 */
  async #resolveView(ctx) {
    const sim = await this.#viewAs(ctx);
    if (sim) await this.#auditViewAs(ctx, sim.viewAs);
    else this.#lastViewAs.delete(String(ctx.user.id));
    return sim;
  }

  /** 部门树、能看到的单位（顶级单位 + 检测站），每个单位的部门编号（扣掉嵌在里面的检测站）。 */
  async #units(access) {
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
      // 组织简化（B1b）：检测站（type=检测站，全局唯一）不管在哪一级都单列
      if (node.status !== 0 && (depth === 0 || node.type === "检测站")) chosen.push(node);
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
    const scope = access.scope;
    const scoped = Boolean(scope && !scope.all);
    const scopeIds = scoped ? new Set(scope.orgIds) : null;
    // 范围落在科室/机构下级时，沿 parent 链向上找最近的单位锚点（一级公司或检测站）。
    // resolveScope 通常会把祖先补进 orgIds，但范围只给科室、或祖先单位被停用时这里兜底：
    // 锚点单位即使自身不在 scope.orgIds 里也纳入，统计仍只算范围覆盖的部门（R4）。
    const anchors = new Set();
    if (scoped) {
      for (const id of scopeIds) {
        const seen = new Set();
        for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = byId.get(cur.parentId)) {
          seen.add(cur.id);
          if (cur.status !== 0 && (cur.type === "检测站" || !byId.has(cur.parentId))) {
            anchors.add(cur.id);
            break;
          }
        }
      }
    }
    const units = [];
    for (const node of chosen) {
      let ids = subtree(node);
      if (scoped) {
        if (!scopeIds.has(node.id) && !anchors.has(node.id)) continue;
        ids = ids.filter((id) => scopeIds.has(id));
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
    return this.boxes.stats({
      scope: { all: false, orgIds, ownerIds: [] },
      limits: await companyLimits(this.db, limits()),
    });
  }

  /** 送检测站的单才有的 body；不是送检单返回 null。 */
  #inspectBody(row) {
    const body = JSON.parse(row.body);
    return body.inspect ? body : null;
  }

  /**
   * 签收方（B1b 修正）：调拨/送检/合并采样单看接收单位 to_org_id（检测站）；
   * 旧采样单（带 trip 或停旧态）寄回段看寄出单位 from_org_id（只读兼容）。
   */
  #receiver(row, body) {
    if (row.kind === "调拨" || row.kind === "送检") return String(row.to_org_id ?? "");
    if (row.kind === "采样" && !isLegacySample({ ...body, kind: row.kind, status: row.status }))
      return String(row.to_org_id ?? "");
    return String(row.from_org_id ?? "");
  }

  /** 送检测站的单：签收方落在 orgIds 里。 */
  #toStation(row, orgIds) {
    const body = this.#inspectBody(row);
    if (!body) return null;
    return orgIds.includes(this.#receiver(row, body)) ? body : null;
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
   * 累计口径（P13）：所有送检单（含已结束）按箱快照聚合——
   * arrivedTotal 数 [待检测,已检测,退回中,已退回] 单的箱子；openedTotal 数 inspected_at 非空的箱子（任何状态）。
   * 集团侧 #stationCounts 与单位侧 #station 共用，保证同口径。
   */
  async #cumulative() {
    return this.db.all(
      `SELECT t.id, t.kind, t.status, t.body, t.from_org_id, t.to_org_id,
              COUNT(*) AS total, SUM(CASE WHEN m.inspected_at IS NOT NULL THEN 1 ELSE 0 END) AS opened
         FROM sample_task_box m JOIN sample_task t ON t.id = m.task_id
        WHERE t.body LIKE ? ${ESCAPE_SQL}
        GROUP BY t.id, t.kind, t.status, t.body, t.from_org_id, t.to_org_id`,
      [likePattern('"inspect":true')]
    );
  }

  /**
   * 集团页用：所有检测站的四数＋今日一次算完（P13）。
   * 在途/未开箱查进行中单，累计到站/累计开箱查全部送检单快照，今日开箱查选定日——按签收方归到检测站。
   */
  async #stationCounts(units, day) {
    const stations = units.filter((unit) => unit.type === "检测站");
    const out = new Map(stations.map((unit) => [unit.id, countsZero()]));
    if (!stations.length) return out;
    const orgToUnit = new Map();
    for (const unit of stations) for (const id of unit.orgIds) orgToUnit.set(id, unit.id);

    const active = await this.db.all(
      `SELECT t.id, t.kind, t.status, t.body, t.from_org_id, t.to_org_id FROM sample_task t
        WHERE t.status NOT IN (${ENDED_SQL}) AND t.body LIKE ? ${ESCAPE_SQL} ORDER BY t.created_at DESC`,
      [likePattern('"inspect":true')]
    );
    const waitingTasks = [];
    for (const row of active) {
      const body = this.#inspectBody(row);
      if (!body) continue;
      const unitId = orgToUnit.get(this.#receiver(row, body));
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
        if (unitId) out.get(unitId).unopenedNow += Number(link.n) || 0;
      }
    }
    // 累计到站/累计开箱（含已结束单；legacy 送检/调拨映射期兼容）
    for (const row of await this.#cumulative()) {
      const body = this.#inspectBody(row);
      if (!body) continue;
      const unitId = orgToUnit.get(this.#receiver(row, body));
      if (!unitId) continue;
      const counts = out.get(unitId);
      if (ARRIVED.includes(row.status)) counts.arrivedTotal += Number(row.total) || 0;
      counts.openedTotal += Number(row.opened) || 0;
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
      const body = this.#inspectBody(row);
      if (!body) continue;
      const unitId = orgToUnit.get(this.#receiver(row, body));
      if (unitId) out.get(unitId).todayOpened += Number(row.n) || 0;
    }
    for (const [unitId, counts] of out) out.set(unitId, withAliases(counts));
    return out;
  }

  /**
   * 单位页用：检测站的四数＋今日（P13），按来源公司汇总，三类明细各自分页。
   * 不选公司时给全部公司的第一页；选了公司只给那一家。总数随筛选口径，翻页不丢数据。
   * 累计口径与集团侧 #stationCounts 共用 #cumulative，保证同数。
   */
  async #station(orgIds, day, withList, query = {}, perms = null) {
    const companyFilter = String(query.company || "");
    const pages = {
      waiting: pageNum(query.waitingPage ?? query.boxPage),
      done: pageNum(query.donePage),
      inbound: pageNum(query.inboundPage),
    };
    const active = await this.db.all(
      `SELECT t.id, t.name, t.kind, t.status, t.body, t.from_org_id, t.to_org_id, t.created_at FROM sample_task t
        WHERE t.status NOT IN (${ENDED_SQL}) AND t.body LIKE ? ${ESCAPE_SQL} ORDER BY t.created_at DESC`,
      [likePattern('"inspect":true')]
    );
    const inbound = [];
    const waitingTasks = [];
    const companies = new Map();
    const seen = { inbound: 0, waiting: 0, done: 0 };
    const companyOf = (source) => {
      let row = companies.get(source.key);
      if (!row) {
        row = { key: source.key, name: source.name, ...countsZero() };
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
        companyOf(item.source).unopenedNow += 1;
        const opens =
          link.opens_start == null
            ? null
            : Math.max(
                0,
                Number(link.opens_end ?? link.opens ?? link.opens_start) - Number(link.opens_start)
              );
        keep("waiting", item.source, waiting, {
          boxId: link.box_id,
          // 名称为空时不能把编号原样写进 boxName——现在的编号就是整串 IMEI（M-1）
          boxName: boxNameCell({ id: link.box_id, name: link.name }, perms),
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
    // 累计到站/累计开箱（含已结束单；legacy 送检/调拨映射期兼容），按来源公司归
    for (const row of await this.#cumulative()) {
      const body = this.#toStation(row, orgIds);
      if (!body) continue;
      const counts = companyOf(this.#source(row, body));
      if (ARRIVED.includes(row.status)) counts.arrivedTotal += Number(row.total) || 0;
      counts.openedTotal += Number(row.opened) || 0;
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
      companyOf(source).todayOpened += 1;
      const opens =
        row.opens_start == null
          ? null
          : Math.max(0, Number(row.opens_end ?? row.opens_start) - Number(row.opens_start));
      keep("done", source, done, {
        boxId: row.box_id,
        // 同上：没起名的箱子不把编号当名称下发（M-1）
        boxName: boxNameCell({ id: row.box_id, name: row.name }, perms),
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
      .filter(
        (item) =>
          item.moving ||
          item.arrivedTotal ||
          item.openedTotal ||
          item.unopenedNow ||
          item.todayOpened
      )
      .sort(
        (a, b) =>
          b.moving + b.arrivedTotal + b.openedTotal - (a.moving + a.arrivedTotal + a.openedTotal) ||
          a.name.localeCompare(b.name, "zh")
      );
    // counts 跟着 company 筛选走：没选是全站，选了只算那一家，
    // 和 StationBoard 页签徽章用的是同一份数（moving 按台、其余按台）。
    const scoped = companyFilter ? companies.get(companyFilter) || countsZero() : null;
    const totals = scoped
      ? {
          moving: scoped.moving,
          arrivedTotal: scoped.arrivedTotal,
          openedTotal: scoped.openedTotal,
          unopenedNow: scoped.unopenedNow,
          todayOpened: scoped.todayOpened,
        }
      : companyList.reduce(
          (sum, item) => ({
            moving: sum.moving + item.moving,
            arrivedTotal: sum.arrivedTotal + item.arrivedTotal,
            openedTotal: sum.openedTotal + item.openedTotal,
            unopenedNow: sum.unopenedNow + item.unopenedNow,
            todayOpened: sum.todayOpened + item.todayOpened,
          }),
          countsZero()
        );
    const counts = withAliases(totals);
    if (!withList) return counts;
    // 来源公司也可能上千：搜索 + 分页只传一页
    const companyQ = String(query.companyQ || "")
      .trim()
      .toLowerCase();
    const matchedCompanies = companyQ
      ? companyList.filter((item) => item.name.toLowerCase().includes(companyQ))
      : companyList;
    const companyPage = pageNum(query.companyPage);
    const companiesOut = matchedCompanies
      .slice((companyPage - 1) * COMPANY_PAGE_SIZE, companyPage * COMPANY_PAGE_SIZE)
      .map(withAliases);
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
   * to 口径与工作台 brief 同源（ReportPolicyController）：调拨/合并采样单＝接收方 toOrg
   * （合并单固定唯一检测站；B4a 修 B3 遗留①——旧写法取 body.org 致合并单 from→to 显示重复名），
   * 旧采样/旧送检＝采样单位 org（只读兼容）。
   */
  async #tasks(orgIds, monthStart, monthEnd) {
    if (!orgIds.length) return [];
    const marks = orgIds.map(() => "?").join(",");
    const likes = orgIds
      .filter(Boolean)
      .map(() => `t.body LIKE ? ${ESCAPE_SQL}`)
      .join(" OR ");
    const rows = await this.db.all(
      `SELECT t.id, t.name, t.kind, t.status, t.body, t.created_at FROM sample_task t
        WHERE t.created_at <= ? AND (t.from_org_id IN (${marks}) OR t.to_org_id IN (${marks})${likes ? ` OR ${likes}` : ""})
        ORDER BY t.created_at DESC LIMIT 2000`,
      [
        monthEnd.toISOString(),
        ...orgIds,
        ...orgIds,
        // 单位编号是服务端的，不带通配符；% _ 一律按 ! 转义（不再靠删字符防注入），
        // 双引号还是先去掉：它不是通配符，但会提前结束 JSON 片段，删掉才安全（L-P2-5）。
        ...orgIds
          .filter(Boolean)
          .map((id) => likePattern(`"orgId":"${String(id).replace(/"/g, "")}"`)),
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
          // 合并采样单与调拨同口径：接收方（检测站/调入单位）；旧采样/送检仍取采样单位（只读兼容）
          to:
            row.kind === "调拨" ||
            (row.kind === "采样" &&
              !isLegacySample({ ...body, kind: row.kind, status: row.status }))
              ? body.toOrg || ""
              : body.org || "",
          boxes: (body.boxIds || []).length,
          inspect: Boolean(body.inspect),
        },
        start,
        end,
      });
    }
    return list;
  }

  /** GET /api/v1/sample/overview?q=&type=&sort=&page=&pageSize=&asOrgId=&asRoleCode=：集团总览。 */
  async group(ctx) {
    this.require(ctx);
    const sim = await this.#resolveView(ctx);
    const access = sim ? sim.access : ctx.access;
    const today = localDay(new Date());
    const units = await this.#units(access);
    const byOrg =
      typeof this.boxes.statsByOrg === "function"
        ? await this.boxes.statsByOrg(await companyLimits(this.db, limits()))
        : null;
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
        unit.type === "检测站" ? stationCounts.get(unit.id) || withAliases(countsZero()) : null;
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
      ? withAliases(
          stationUnits.reduce(
            (sum, unit) => ({
              moving: sum.moving + unit.station.moving,
              arrivedTotal: sum.arrivedTotal + unit.station.arrivedTotal,
              openedTotal: sum.openedTotal + unit.station.openedTotal,
              unopenedNow: sum.unopenedNow + unit.station.unopenedNow,
              todayOpened: sum.todayOpened + unit.station.todayOpened,
            }),
            countsZero()
          )
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
    // 「本单位」：非全量范围且恰好只有一个单位时给出它的编号，供前端空态/筛选空结果跳转；
    // 全量范围（管理员）或范围内有多个单位时给 null，页面留在集团板。仅本人等没有单位范围时也是 null。
    const scope = access.scope;
    const myUnitId = scope && !scope.all && units.length === 1 ? units[0].id : null;
    ctx.ok({
      day: today,
      total,
      stationTotal,
      branchTotal: list.filter((unit) => !unit.station).length,
      stationCount: stationUnits.length,
      unitTotal: matched.length,
      myUnitId,
      viewAs: sim ? sim.viewAs : null,
      page,
      pageSize,
      top,
      units: matched.slice((page - 1) * pageSize, page * pageSize),
    });
  }

  /** GET /api/v1/sample/overview/:orgId?day=&month=&company=&waitingPage=&donePage=&inboundPage=&asOrgId=&asRoleCode=：单位总览。 */
  async unit(ctx) {
    this.require(ctx);
    const sim = await this.#resolveView(ctx);
    const access = sim ? sim.access : ctx.access;
    const units = await this.#units(access);
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
      viewAs: sim ? sim.viewAs : null,
      stats: await this.#stats(unit.orgIds),
      station:
        unit.type === "检测站"
          ? await this.#station(
              unit.orgIds,
              day,
              true,
              {
                company: String(ctx.query.company || ""),
                companyQ: ctx.query.companyQ,
                companyPage: ctx.query.companyPage,
                waitingPage: ctx.query.waitingPage ?? ctx.query.boxPage,
                donePage: ctx.query.donePage,
                inboundPage: ctx.query.inboundPage,
              },
              access.perms
            )
          : null,
      tasks: null,
      calendar: null,
    };
    if (access.perms.has(BOX.task)) {
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
