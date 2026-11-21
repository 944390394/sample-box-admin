/**
 * 公司级策略层（R13，任务 #46）。公司＝部门树顶级部门（companyTool 同口径）。
 *
 * 两份完整策略（沿用「每层是完整策略」哲学，不逐字段跨层拼接）：
 * - idle_json：非任务期间默认，插在 批量 与 系统默认 之间（resolvePolicy 第 5 参）；
 * - task_json：任务期间默认，只作新建任务单「本任务统一」的初始值＋空策略兜底（选项 A），
 *   建单冻结进 assignedPolicies 快照——进行中任务不受公司级后续修改影响。
 *
 * 检测站期间（拍板④）：箱子签收后 org_id 挂检测站（companyOf 会解析到总公司），
 * 策略与判定阈值按「寄出分公司」生效——取最近一张 to_org_id∈检测站子树 的任务 from_org_id 快照；
 * 没有任务快照（手工改挂到检测站）回落 companyOf(org_id)。
 *
 * 判定阈值公司化（P1）：battery_reserve/arrive_radius_m/offline_grace_sec 三列 NULL＝继承系统默认。
 * companyLimits(db, base) 每请求装载公司数据附在 limits 上（无模块级缓存，测试与多库安全）；
 * 内存判定走 boxGraceSec/boxReserve 等纯函数，SQL 判定走 companyCaseSql（CASE 分支）。
 * 没有任何公司覆盖阈值时 company=null——SQL 与改造前逐字节一致，存量行为零变化。
 */
import { randomUUID } from "node:crypto";
import { badRequest } from "../domain/AppError.js";
import { estimateBattery } from "../domain/BatteryEstimate.js";
import { buildDeptTree, collectDeptIds } from "../../../shared/org.js";
import { companyTool } from "./boxCompany.js";
import { currentBoxSettings, isUnderHq, offlineGraceSec, stationDeptId } from "./boxConfig.js";

/** 部门行一次查齐（companyTool 要 parent_id，buildDeptTree 要 parentId，两个别名都带）。 */
export async function companyContext(db) {
  const rows = await db.all(
    "SELECT id, parent_id, parent_id AS parentId, name, sort, type, status FROM sys_dept"
  );
  const tool = companyTool(rows);
  // 唯一检测站（与 boxConfig.resolveStation 同口径：配置优先→DB 恰一个自动认定），在已有行上算不再查库
  const valid = (row) =>
    row && Number(row.status) === 1 && row.type === "检测站" && isUnderHq(rows, row.id);
  const configured = stationDeptId();
  const configuredRow = configured ? rows.find((row) => String(row.id) === configured) : null;
  const candidates = configured ? [] : rows.filter(valid);
  const station = configured
    ? valid(configuredRow)
      ? configuredRow
      : null
    : candidates.length === 1
      ? candidates[0]
      : null;
  const stationIds = station
    ? new Set(collectDeptIds(buildDeptTree(rows), String(station.id)) || [String(station.id)])
    : new Set();
  return { rows, tool, stationIds, hq: tool.hq };
}

/** 箱子最近一张寄检测站任务的寄出公司（R22：双向派生单 fromOrg＝检测站，改取采样单位 body.orgId）。 */
function senderOrgOfTaskRow(fromOrg, bodyText) {
  let from = String(fromOrg ?? "");
  if (bodyText) {
    try {
      const body = JSON.parse(bodyText);
      if (body?.tripDerived === true && body.trip === "双向" && body.orgId)
        from = String(body.orgId);
    } catch {
      /* body 损坏按 from_org_id 列 */
    }
  }
  return from;
}

/** 箱子生效公司 id：检测站子树内的箱子按最近寄出任务的 fromOrg 快照，其余按 companyOf(org_id)。 */
export async function companyOrgForBox(db, box, ctx = null) {
  const c = ctx || (await companyContext(db));
  const orgId = String(box?.org_id ?? box?.orgId ?? "");
  const boxId = String(box?.id ?? "");
  if (c.stationIds.size && boxId && c.stationIds.has(orgId)) {
    const ids = [...c.stationIds];
    const link = await db.get(
      `SELECT t.from_org_id, t.body FROM sample_task t JOIN sample_task_box m ON m.task_id=t.id
       WHERE m.box_id=? AND t.from_org_id IS NOT NULL AND t.from_org_id <> ''
         AND t.to_org_id IN (${ids.map(() => "?").join(",")})
       ORDER BY t.created_at DESC LIMIT 1`,
      [boxId, ...ids]
    );
    const from = senderOrgOfTaskRow(link?.from_org_id, link?.body);
    if (from) return c.tool.companyOf(from);
  }
  return c.tool.companyOf(orgId);
}

/** 公司非任务期间默认策略（完整 Policy JSON 或 null＝整层继承系统默认）。 */
export async function companyIdleFor(db, box, ctx = null) {
  const cid = await companyOrgForBox(db, box, ctx);
  if (!cid) return null;
  const row = await db.get("SELECT idle_json FROM box_company_policy WHERE dept_id=?", [cid]);
  return row?.idle_json ? JSON.parse(row.idle_json) : null;
}

/** 公司任务期间默认策略（建单初始值＋兜底用）：按寄出单位向上找公司。 */
export async function companyTaskFor(db, orgId, ctx = null) {
  const c = ctx || (await companyContext(db));
  const cid = c.tool.companyOf(String(orgId ?? ""));
  if (!cid) return null;
  const row = await db.get("SELECT task_json FROM box_company_policy WHERE dept_id=?", [cid]);
  return row?.task_json ? JSON.parse(row.task_json) : null;
}

/**
 * 任务的公司策略/判定阈值归属（R22）：派生方向合并单按采样单位 orgId——
 * 双向 fromOrg＝检测站（无公司层），采样分公司才是 R13④「检测站期间按寄出公司」的等价主体；
 * 单向 orgId 通常＝fromOrg。旧单（无 tripDerived 标记）沿用 fromOrgId→orgId 口径。
 */
export function companyOrgOfTask(task) {
  return task?.tripDerived === true
    ? String(task.orgId || task.fromOrgId || "")
    : String(task?.fromOrgId || task?.orgId || "");
}

/** 检测站子树内箱子 → 寄出公司 id（一次查询取每台最近一张寄检测站任务的 fromOrg；R22 双向取采样单位）。 */
async function stationSenderMap(db, ctx) {
  if (!ctx.stationIds.size) return new Map();
  const ids = [...ctx.stationIds];
  const marks = ids.map(() => "?").join(",");
  const latest = `FROM sample_task t JOIN sample_task_box m ON m.task_id=t.id
        WHERE m.box_id=b.id AND t.from_org_id IS NOT NULL AND t.from_org_id <> ''
          AND t.to_org_id IN (${marks}) ORDER BY t.created_at DESC LIMIT 1`;
  const rows = await db.all(
    `SELECT b.id, (SELECT t.from_org_id ${latest}) AS from_org,
            (SELECT t.body ${latest}) AS task_body
     FROM sample_box b WHERE b.org_id IN (${marks})`,
    [...ids, ...ids, ...ids]
  );
  return new Map(
    rows.map((row) => [
      String(row.id),
      ctx.tool.companyOf(senderOrgOfTaskRow(row.from_org, row.task_body)),
    ])
  );
}

/**
 * 公司化判定阈值（P1）：在全局 limits 上附 company 数据。
 * company=null 表示没有任何公司覆盖阈值——调用点 SQL/内存判定与改造前完全一致。
 * byId 只收至少覆盖了一项阈值的公司；orgCompany 是全量 org→company 映射（含 ""→总公司）。
 */
export async function companyLimits(db, base) {
  const graceSec = offlineGraceSec();
  if (!db) return { ...base, graceSec, company: null };
  const ctx = await companyContext(db);
  const rows = await db.all(
    "SELECT dept_id, battery_reserve, arrive_radius_m, offline_grace_sec FROM box_company_policy"
  );
  const orgCompany = new Map();
  for (const row of ctx.rows) orgCompany.set(String(row.id), ctx.tool.companyOf(String(row.id)));
  orgCompany.set("", ctx.hq);
  const byId = new Map();
  for (const row of rows) {
    const num = (v) => (v == null || v === "" ? null : Number(v));
    const entry = {
      batteryReserve: num(row.battery_reserve),
      arriveRadiusM: num(row.arrive_radius_m),
      taskOfflineGraceSec: num(row.offline_grace_sec),
      orgIds: [],
    };
    if (
      entry.batteryReserve == null &&
      entry.arriveRadiusM == null &&
      entry.taskOfflineGraceSec == null
    )
      continue;
    byId.set(String(row.dept_id), entry);
  }
  if (!byId.size) return { ...base, graceSec, company: null };
  for (const [orgId, cid] of orgCompany) if (byId.has(cid)) byId.get(cid).orgIds.push(orgId);
  const stationBoxes = await stationSenderMap(db, ctx);
  // token：公司阈值指纹（Map 不能进 JSON 缓存键，序列化成串供 SqlBoxStore.summaryCache 键用）
  const token = JSON.stringify([
    [...byId.entries()].map(([cid, e]) => [
      cid,
      e.batteryReserve,
      e.arriveRadiusM,
      e.taskOfflineGraceSec,
      e.orgIds,
    ]),
    [...stationBoxes.entries()],
  ]);
  return {
    ...base,
    graceSec,
    company: { byId, orgCompany, stationBoxes, stationIds: [...ctx.stationIds], hq: ctx.hq, token },
  };
}

/** 箱子生效公司 id（内存判定用，纯函数）：检测站箱按寄出公司映射，其余按 org 映射。 */
export function boxCompanyId(box, limits) {
  const c = limits?.company;
  if (!c) return null;
  const id = String(box?.id ?? box?.boxId ?? "");
  if (c.stationBoxes.has(id)) return c.stationBoxes.get(id);
  return c.orgCompany.get(String(box?.orgId ?? box?.org_id ?? "")) ?? c.hq ?? null;
}

function boxCompanyEntry(box, limits) {
  const cid = boxCompanyId(box, limits);
  return cid ? (limits.company.byId.get(cid) ?? null) : null;
}

/** 箱子离线宽限（秒）：公司覆盖优先，无覆盖用全局（limits.graceSec 或当前系统设置）。 */
export function boxGraceSec(box, limits) {
  return boxCompanyEntry(box, limits)?.taskOfflineGraceSec ?? limits?.graceSec ?? offlineGraceSec();
}

/** 箱子弹量预留（%）：公司覆盖优先，无覆盖用系统默认。 */
export function boxReserve(box, limits) {
  return boxCompanyEntry(box, limits)?.batteryReserve ?? currentBoxSettings().batteryReserve;
}

/** 箱子到达半径（米）：公司覆盖优先，无覆盖用系统默认。 */
export function boxArriveRadius(box, limits) {
  return boxCompanyEntry(box, limits)?.arriveRadiusM ?? currentBoxSettings().arriveRadiusM;
}

/** 公司 id 直接解析阈值（任务到达半径按寄出公司用；异步、无缓存）。 */
export async function companyJudgmentFor(db, orgId) {
  const settings = currentBoxSettings();
  const fallback = {
    batteryReserve: settings.batteryReserve,
    arriveRadiusM: settings.arriveRadiusM,
    taskOfflineGraceSec: offlineGraceSec(),
  };
  if (!db) return fallback;
  const ctx = await companyContext(db);
  const cid = ctx.tool.companyOf(String(orgId ?? ""));
  const row = cid
    ? await db.get(
        "SELECT battery_reserve, arrive_radius_m, offline_grace_sec FROM box_company_policy WHERE dept_id=?",
        [cid]
      )
    : null;
  const num = (v, fb) => (v == null || v === "" ? fb : Number(v));
  return {
    batteryReserve: num(row?.battery_reserve, fallback.batteryReserve),
    arriveRadiusM: num(row?.arrive_radius_m, fallback.arriveRadiusM),
    taskOfflineGraceSec: num(row?.offline_grace_sec, fallback.taskOfflineGraceSec),
  };
}

/**
 * SQL 阈值 CASE（onlineSql 宽限 / low / ready 用）。valueOf(entry)→整数或 null（该公司继承全局）。
 * 分支顺序：①检测站箱按 id 枚举（寄出公司可能与挂名总公司不同，必须先于 org 分支）；
 * ②公司 org 子树（含 ""＝未分配归总公司）。没有任何公司覆盖这一项时返回裸全局值——SQL 不变。
 * 箱号来自库内（IMEI/测试编号），严格字符集校验后内插（避免几百台箱子的占位符撑爆参数上限）；
 * 部门 id 走占位符。不合字符集的箱号跳过（回落 org 分支，安全降级）。
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function companyCaseSql(company, valueOf, fallback) {
  const fb = Number(fallback);
  if (!company) return { sql: String(fb), params: [] };
  const values = new Map();
  for (const [cid, entry] of company.byId) {
    const v = valueOf(entry);
    if (v != null) values.set(cid, Number(v));
  }
  if (!values.size) return { sql: String(fb), params: [] };
  const branches = [];
  const params = [];
  const groups = new Map();
  for (const [boxId, cid] of company.stationBoxes) {
    if (!SAFE_ID.test(boxId)) continue;
    const list = groups.get(cid) || [];
    list.push(boxId);
    groups.set(cid, list);
  }
  for (const [cid, ids] of groups) {
    const v = values.get(cid) ?? fb;
    branches.push(`WHEN id IN (${ids.map((x) => `'${x}'`).join(",")}) THEN ${v}`);
  }
  for (const [cid, v] of values) {
    const orgIds = company.byId.get(cid)?.orgIds || [];
    if (!orgIds.length) continue;
    branches.push(`WHEN COALESCE(org_id,'') IN (${orgIds.map(() => "?").join(",")}) THEN ${v}`);
    params.push(...orgIds);
  }
  if (!branches.length) return { sql: String(fb), params: [] };
  return { sql: `CASE ${branches.join(" ")} ELSE ${fb} END`, params };
}

/** 公司策略行读模型（GET 端点用）：NULL 列＝继承系统默认，原样下发 null。 */
export async function readCompanyPolicy(db, orgId) {
  const row = await db.get("SELECT * FROM box_company_policy WHERE dept_id=?", [String(orgId)]);
  const num = (v) => (v == null || v === "" ? null : Number(v));
  return {
    idle: row?.idle_json ? JSON.parse(row.idle_json) : null,
    task: row?.task_json ? JSON.parse(row.task_json) : null,
    batteryReserve: num(row?.battery_reserve),
    arriveRadiusM: num(row?.arrive_radius_m),
    taskOfflineGraceSec: num(row?.offline_grace_sec),
    updatedAt: row?.updated_at || "",
    updatedBy: row?.updated_by || "",
  };
}

/** 判定阈值三列校验：null/缺省＝继承系统默认；带值按系统设置同款范围（友好报错）。 */
export function validateCompanyNumbers(input) {
  const read = (value, min, max, label) => {
    if (value == null || value === "") return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max)
      throw badRequest(`${label}要在 ${min} 到 ${max} 之间，或留空继承系统默认`);
    return n;
  };
  return {
    batteryReserve: read(input?.batteryReserve, 0, 80, "电量预留"),
    arriveRadiusM: read(input?.arriveRadiusM, 100, 50000, "到达半径"),
    taskOfflineGraceSec: read(input?.taskOfflineGraceSec, 60, 86400, "离线宽限（秒）"),
  };
}

/**
 * 保存公司策略（idle/task 须已过 validatePolicy；null＝整层继承）。
 * 与单箱/批量同口径：每次保存盖新 revision（版本指纹变→按既有 sent/observe 状态机重发）。
 * 调用方在事务内连同 refresh 一起提交；单条 upsert 自身原子。
 */
export async function saveCompanyPolicy(db, orgId, value, actor = {}) {
  const stamp = (p) => (p ? JSON.stringify({ ...p, revision: randomUUID() }) : null);
  const now = new Date().toISOString();
  const by = String(actor.name || "").slice(0, 64);
  const idle = stamp(value.idle);
  const task = stamp(value.task);
  const existing = await db.get("SELECT dept_id FROM box_company_policy WHERE dept_id=?", [
    String(orgId),
  ]);
  if (existing)
    await db.run(
      `UPDATE box_company_policy SET idle_json=?, task_json=?, battery_reserve=?, arrive_radius_m=?, offline_grace_sec=?, updated_at=?, updated_by=? WHERE dept_id=?`,
      [
        idle,
        task,
        value.batteryReserve,
        value.arriveRadiusM,
        value.taskOfflineGraceSec,
        now,
        by,
        String(orgId),
      ]
    );
  else
    await db.run(
      `INSERT INTO box_company_policy (dept_id, idle_json, task_json, battery_reserve, arrive_radius_m, offline_grace_sec, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?)`,
      [
        String(orgId),
        idle,
        task,
        value.batteryReserve,
        value.arriveRadiusM,
        value.taskOfflineGraceSec,
        now,
        by,
      ]
    );
  return { updatedAt: now, updatedBy: by };
}

/** 生效公司＝companyId 的全部箱号（含检测站里由该公司寄出的箱子）；公司保存后 refresh 用。 */
export async function companyBoxIds(db, companyId, ctx = null) {
  const c = ctx || (await companyContext(db));
  const boxes = await db.all("SELECT id, org_id FROM sample_box");
  const stationBoxes = c.stationIds.size ? await stationSenderMap(db, c) : new Map();
  const target = String(companyId);
  return boxes
    .filter((box) => {
      const orgId = String(box.org_id ?? "");
      const cid =
        c.stationIds.has(orgId) && stationBoxes.has(String(box.id))
          ? stationBoxes.get(String(box.id))
          : c.tool.companyOf(orgId);
      return cid === target;
    })
    .map((box) => String(box.id));
}

/** 电量显示按公司预留重算（列表/详情/签收核验 JSON 用）：reserve 与全局相同时原样返回。 */
export function withCompanyBattery(json, box, reserve) {
  if (reserve == null || reserve === json.batteryReserve) return json;
  const estimate = estimateBattery(box.batteryModel, box.batteryMv, reserve, box.charge);
  if (!estimate) return { ...json, batteryUsable: null, batteryReserve: reserve };
  return {
    ...json,
    batterySoc: estimate.soc,
    batteryUsable: estimate.usable,
    batteryReserve: estimate.reserve,
  };
}

/** 公司策略页继承态灰字用的系统默认生效值（只读下发）。 */
export function systemJudgmentDefaults() {
  const settings = currentBoxSettings();
  return {
    reportPeriodSec: settings.reportPeriodSec,
    reportOnlyWhenCharging: settings.reportOnlyWhenCharging,
    batteryReserve: settings.batteryReserve,
    arriveRadiusM: settings.arriveRadiusM,
    taskOfflineGraceSec: offlineGraceSec(),
  };
}
