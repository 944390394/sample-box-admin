import { defaultBoxName } from "../domain/boxName.js";
import { currentBoxSettings, offlineGraceSec } from "../settings/boxConfig.js";
import { companyCaseSql } from "../settings/companyPolicy.js";
import { formatTimestamp } from "../domain/Clock.js";
import { CommittedUplink } from "../domain/CommittedUplink.js";
import { BoxState } from "../domain/BoxState.js";
import { FULL_RELEASE_MV } from "../domain/BatteryEstimate.js";
import { chargeFromRaw, readMillivolts, uplinkText } from "../domain/BatterySeries.js";
import { UplinkRecord } from "../domain/UplinkRecord.js";
import { pageLimit, resolveTimeRange } from "../log/timeRange.js";
import { BoxStore } from "./BoxStore.js";
import { decompressRaw } from "./rawCodec.js";
import { rawStorage } from "./schema.js";
import { UplinkBatch } from "./UplinkBatch.js";
import { scopeSql, usableMv } from "../auth/boxAccess.js";
import { queueWipe } from "../settings/DeviceCommands.js";
import { ENDED_SQL } from "../settings/taskFlow.js";
import { ESCAPE_SQL, likePattern } from "./sqlText.js";
import { badRequest } from "../domain/AppError.js";

const UPLINK_LIST_COLUMNS = [
  "id",
  "box_id",
  "imei",
  "received_at",
  "device_time",
  "kind",
  "summary",
  "lbs_lng",
  "lbs_lat",
  "gps_lng",
  "gps_lat",
];

/** 上报种类白名单（BoxState.apply 派生＋unknown 兜底），列表/概览同一份。 */
const UPLINK_KINDS = ["boot", "timer", "pad", "shut", "chg", "chgs", "unknown"];

function readUplinkKinds(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => UPLINK_KINDS.includes(item));
}

/**
 * 「仅看异常」的行级口径（控制器算好阈值传入）：
 * 低电压＝摘要电压低于 lowMv（与箱子列表 low flag 同源，公司预留覆盖后的值）；
 * 开箱超限＝该箱当前未结束任务开箱超上限（overOpen）时的开箱行。
 */
function readAnomaly(value) {
  if (!value) return null;
  const lowMv = Number(value.lowMv);
  if (!Number.isFinite(lowMv) || lowMv <= 0) return null;
  return { lowMv, overOpen: Boolean(value.overOpen) };
}

function anomalyWhere(anomaly) {
  const low = "(mv >= 2500 AND mv < ?)";
  return anomaly.overOpen ? `(${low} OR kind = 'pad')` : low;
}

/**
 * 摘要文本里的电压（mV）提取成 SQL 表达式，供列表「仅看异常」过滤和概览 MIN/MAX 聚合共用。
 * 摘要形如「定时上报 · seq 709 · 4.15 V · 开着」（Uplink.digestAs）：取「 V」前的那段数字——
 * SQLite 用 rtrim 去掉前缀尾部的数字/小数点定位起点；MySQL 用 REGEXP_SUBSTR。
 * 没有电压给 NULL；有效区间（2500–4500，与 readMillivolts 同口径）由调用点判断。
 */
export function uplinkMvSql(dialect) {
  if (dialect === "mysql") {
    return "CAST(REPLACE(REGEXP_SUBSTR(summary, '[0-9]+([.][0-9]+)? V'), ' V', '') AS DECIMAL(8,3)) * 1000";
  }
  const prefix = "rtrim(substr(summary, 1, instr(summary, ' V') - 1), '0123456789.')";
  const start = `length(${prefix}) + 1`;
  const length = `instr(summary, ' V') - 1 - length(${prefix})`;
  return `CASE WHEN instr(summary, ' V') > 0 THEN CAST(substr(summary, ${start}, ${length}) AS REAL) * 1000 END`;
}

/** 页码跳转（分页器直接跳页）：无游标时按 OFFSET 定位；有游标走键集（新上报追加也不漂移）。 */
function pageOffset(page, limit) {
  const number = Number(page);
  if (!Number.isInteger(number) || number <= 1) return 0;
  return (number - 1) * limit;
}

/** 管理操作和任务维护的列：上报写库时不覆盖（新建箱子时照常写入）。 */
const MANAGED_COLUMNS = ["life", "org", "org_id", "owner", "owner_id", "name"];

/** 电量序列：每页行数（页间让出事件循环）、缓存门槛与按箱 LRU 上限。 */
const BATTERY_PAGE = 4000;
const BATTERY_CACHE_MIN = 2000;
const BATTERY_CACHE_MAX = 3;

/** 曲线落位时间：设备时间优先（补传落在真实发生时刻），没有才用收到时间。 */
function batteryDeviceTime(row) {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(row.device_time)
    ? row.device_time.slice(0, 19)
    : String(row.received_at).slice(0, 19);
}

const BOX_COLUMNS = [
  "id",
  "name",
  "imei",
  "iccid",
  "imsi",
  "firmware",
  "org",
  "org_id",
  "owner",
  "owner_id",
  "life",
  "alert",
  "battery",
  "csq",
  "last_report_at",
  "lbs",
  "lbs_lng",
  "lbs_lat",
  "lbs_at",
  "gps",
  "gps_lng",
  "gps_lat",
  "opens",
  "device_opens",
  "lid",
  "charge",
  "last_open",
  "last_power_off",
  "booted_at",
  "uncharged_at",
  "report_seq",
  "lbs_address",
  "gps_address",
  "storage_free",
  "battery_mv",
  "battery_model",
  "activate_step",
  "powered_at",
  "gps_info",
];

/**
 * 同一套 SQL 面对 SQLite 和 MySQL。
 * 写入全部使用占位符。箱号在一个临界区里递增，MySQL 再套事务和行锁。
 */
export class SqlBoxStore extends BoxStore {
  constructor(executor) {
    super();
    this.executor = executor;
    this.tail = Promise.resolve();
    this.batch = new UplinkBatch(executor);
    // 电量序列解码缓存（按箱 LRU）：7 天 ~7 万行逐行 gunzip 要几百毫秒，
    // 范围切换不该每次重解。COUNT+MAX(id) 守卫保证行集没变才复用（上报只追加，id 不复用）。
    this.batteryCache = new Map();
  }

  async findByImei(imei) {
    const row = await this.executor.get("SELECT * FROM sample_box WHERE imei = ?", [imei]);
    return row ? BoxState.fromRow(row) : null;
  }

  async findById(id) {
    const row = await this.executor.get("SELECT * FROM sample_box WHERE id = ?", [id]);
    return row ? BoxState.fromRow(row) : null;
  }

  async findByName(name) {
    if (!name) return null;
    const row = await this.executor.get("SELECT * FROM sample_box WHERE name = ?", [name]);
    return row ? BoxState.fromRow(row) : null;
  }

  async list() {
    // SELECT * 与 page() 同口径：策略周期/仅充电/占用锚点列也要进 BoxState，
    // 不然非分页路径的 online/宽限/自身周期判定拿不到这些字段（BOX_COLUMNS 是写入列清单，不能扩）
    const rows = await this.executor.all(`SELECT * FROM sample_box ORDER BY last_report_at DESC`);
    return rows.map((row) => BoxState.fromRow(row));
  }

  async latest({ scope = null, limit = 50 } = {}) {
    await this.#ensureBoxIndex();
    const filter = boxWhere({ scope });
    filter.where.push("last_report_at <> ''");
    const size = Math.min(100, Math.max(1, Number(limit) || 50));
    const rows = await this.executor.all(
      `SELECT * FROM sample_box WHERE ${filter.where.join(" AND ")}
       ORDER BY last_report_at DESC LIMIT ?`,
      [...filter.params, size]
    );
    return rows.map((row) => BoxState.fromRow(row));
  }

  /**
   * 清单页按页取。十万台时不能把整表送到浏览器。
   * 范围、快捷筛选、所属单位都落成 WHERE。按名称或编号（IMEI）搜。
   *
   * 两套 WHERE 各有用途，口径写清楚（L-P0-3）：
   * - scopeWhere = 范围 + 搜索 + 单位，不含 life/flag，卡片数量和 scopeTotal 用它，所以点了状态卡片以后卡片数字本身不变，还能接着点另一张；
   * - rowWhere = 上面那套再加 life/flag，列表行数和 filteredTotal 用它，分页也按它走。
   * total 保留下来是给老调用点当「列表总数」用的，含义等同 filteredTotal；新代码要看口径就用这两个新字段。
   */
  async page({
    life = "",
    q = "",
    page = 1,
    pageSize = 20,
    scope = null,
    flag = "",
    limits = null,
    matchImei = true,
    orgId = "",
  } = {}) {
    await this.#ensureBoxIndex();
    const scopeWhere = boxWhere({ scope, q, matchImei, orgId });
    const rowWhere = boxWhere({
      scope,
      q,
      matchImei,
      life,
      flag,
      limits,
      dialect: this.executor.dialect,
      orgId,
    });
    const whereSql = rowWhere.where.length ? `WHERE ${rowWhere.where.join(" AND ")}` : "";
    const totalRow = await this.executor.get(
      `SELECT COUNT(*) AS n FROM sample_box ${whereSql}`,
      rowWhere.params
    );
    const size = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const offset = (Math.max(1, Number(page) || 1) - 1) * size;
    const rows = await this.executor.all(
      `SELECT * FROM sample_box ${whereSql}
       ORDER BY CASE WHEN life = '待激活' THEN 0 ELSE 1 END,
                CASE WHEN alert <> '' THEN 0 ELSE 1 END,
                last_report_at DESC
       LIMIT ? OFFSET ?`,
      [...rowWhere.params, size, offset]
    );
    const summary = await this.#summarize(scopeWhere, limits);
    const filtered = Number(totalRow?.n || 0);
    return {
      list: rows.map((row) => BoxState.fromRow(row)),
      total: filtered,
      filteredTotal: filtered,
      scopeTotal: summary.total,
      counts: summary.counts,
      flags: summary.flags,
    };
  }

  /** 范围内一次聚合出生命周期和快捷筛选的数量。轮询频繁，同一范围几秒内复用。 */
  async stats({ scope = null, limits = null } = {}) {
    await this.#ensureBoxIndex();
    return this.#summarize(boxWhere({ scope }), limits);
  }

  /** 每个单位一行统计。集团总览上千家公司时用这一次查询，不再按单位各查一次。 */
  async statsByOrg(limits = null) {
    await this.#ensureBoxIndex();
    const lim = limits || { onlineSince: "9999", lowMv: 0, readyMv: 99999 };
    const online = onlineSql(this.executor.dialect, lim.onlineSince, lim.company);
    const low = companyCaseSql(
      lim.company,
      (entry) => (entry.batteryReserve == null ? null : usableMv(20, entry.batteryReserve)),
      lim.lowMv
    );
    const ready = companyCaseSql(
      lim.company,
      (entry) => (entry.batteryReserve == null ? null : usableMv(50, entry.batteryReserve)),
      lim.readyMv
    );
    const rows = await this.executor.all(
      `SELECT COALESCE(org_id,'') AS org_id, life, COUNT(*) AS n,
              SUM(CASE WHEN alert <> '' THEN 1 ELSE 0 END) AS alert,
              SUM(CASE WHEN ${online.sql} THEN 0 ELSE 1 END) AS offline,
              SUM(CASE WHEN battery_mv > 0 AND battery_mv < ${low.sql} THEN 1 ELSE 0 END) AS low,
              SUM(CASE WHEN lid = 1 THEN 1 ELSE 0 END) AS lid,
              SUM(CASE WHEN life = '未使用' AND alert = '' AND ${online.sql} AND battery_mv >= ${ready.sql}
                       THEN 1 ELSE 0 END) AS ready
       FROM sample_box GROUP BY org_id, life`,
      // 参数顺序就是片段里 ? 出现的顺序：offline 的 onlineSince+now+宽限CASE、low CASE、ready 的 onlineSince+now+宽限CASE、readyMv CASE
      [...online.params, ...low.params, ...online.params, ...ready.params]
    );
    const map = new Map();
    for (const row of rows) {
      const id = String(row.org_id ?? "");
      const bucket = map.get(id) || {
        total: 0,
        counts: { 在途: 0, 未使用: 0, 停用: 0, 待激活: 0 },
        flags: { alert: 0, offline: 0, low: 0, lid: 0, ready: 0 },
      };
      const n = Number(row.n) || 0;
      bucket.total += n;
      if (Object.prototype.hasOwnProperty.call(bucket.counts, row.life))
        bucket.counts[row.life] = Number(row.n);
      for (const name of Object.keys(bucket.flags)) bucket.flags[name] += Number(row[name]) || 0;
      map.set(id, bucket);
    }
    return map;
  }

  async #summarize(base, limits) {
    // 缓存键带公司阈值指纹（company.token）：公司策略保存后几秒内也不会复用旧阈值的计数
    const key = JSON.stringify([base.where, base.params, limits]);
    const cached = this.summaryCache?.get(key);
    if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.value;
    const whereSql = base.where.length ? `WHERE ${base.where.join(" AND ")}` : "";
    const lim = limits || { onlineSince: "9999", lowMv: 0, readyMv: 99999 };
    const online = onlineSql(this.executor.dialect, lim.onlineSince, lim.company);
    const low = companyCaseSql(
      lim.company,
      (entry) => (entry.batteryReserve == null ? null : usableMv(20, entry.batteryReserve)),
      lim.lowMv
    );
    const ready = companyCaseSql(
      lim.company,
      (entry) => (entry.batteryReserve == null ? null : usableMv(50, entry.batteryReserve)),
      lim.readyMv
    );
    const rows = await this.executor.all(
      `SELECT life, COUNT(*) AS n,
              SUM(CASE WHEN alert <> '' THEN 1 ELSE 0 END) AS alert,
              SUM(CASE WHEN ${online.sql} THEN 0 ELSE 1 END) AS offline,
              SUM(CASE WHEN battery_mv > 0 AND battery_mv < ${low.sql} THEN 1 ELSE 0 END) AS low,
              SUM(CASE WHEN lid = 1 THEN 1 ELSE 0 END) AS lid,
              SUM(CASE WHEN life = '未使用' AND alert = '' AND ${online.sql} AND battery_mv >= ${ready.sql}
                       THEN 1 ELSE 0 END) AS ready
       FROM sample_box ${whereSql} GROUP BY life`,
      // 缓存键里没有 now：这批数量本来就允许旧 SUMMARY_TTL_MS，跟以前把 now 拼进 SQL 时一样
      [...online.params, ...low.params, ...online.params, ...ready.params, ...base.params]
    );
    const counts = { 在途: 0, 未使用: 0, 停用: 0, 待激活: 0 };
    const flags = { alert: 0, offline: 0, low: 0, lid: 0, ready: 0 };
    let total = 0;
    for (const row of rows) {
      total += Number(row.n) || 0;
      if (Object.prototype.hasOwnProperty.call(counts, row.life)) counts[row.life] = Number(row.n);
      for (const name of Object.keys(flags)) flags[name] += Number(row[name]) || 0;
    }
    const value = { total, counts, flags };
    if (!this.summaryCache) this.summaryCache = new Map();
    if (this.summaryCache.size > 200) this.summaryCache.clear();
    this.summaryCache.set(key, { at: Date.now(), value });
    return value;
  }

  /** 导出按主键往后翻，不用 OFFSET。 */
  async *exportBoxes({
    life = "",
    q = "",
    scope = null,
    flag = "",
    limits = null,
    matchImei = true,
    max = 50000,
  } = {}) {
    const filter = boxWhere({
      scope,
      q,
      matchImei,
      life,
      flag,
      limits,
      dialect: this.executor.dialect,
    });
    let after = "";
    let sent = 0;
    while (sent < max) {
      const where = [...filter.where, "id > ?"];
      const size = Math.min(1000, max - sent);
      const rows = await this.executor.all(
        `SELECT * FROM sample_box WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`,
        [...filter.params, after, size]
      );
      if (!rows.length) return;
      for (const row of rows) yield BoxState.fromRow(row);
      sent += rows.length;
      after = rows[rows.length - 1].id;
      if (rows.length < size) return;
    }
  }

  /**
   * 管理操作改箱子当前行。和上报走同一把锁，避免上报把刚改的生命周期写回去。
   * change 返回 false 表示不改。
   */
  async updateBox(id, change) {
    const write = async (db) => {
      const locking = db.dialect === "mysql" ? " FOR UPDATE" : "";
      const row = await db.get(`SELECT * FROM sample_box WHERE id = ?${locking}`, [id]);
      if (!row) return null;
      const box = BoxState.fromRow(row);
      if (change(box) === false) return box;
      await this.#save(db, box);
      return box;
    };
    const box =
      typeof this.executor.transaction === "function"
        ? await this.executor.transaction(write)
        : await this.#exclusive(() => write(this.executor));
    this.summaryCache?.clear();
    return box;
  }

  async #ensureBoxIndex() {
    if (this.boxIndexed) return;
    try {
      await this.executor.run(
        "CREATE INDEX IF NOT EXISTS idx_sample_box_life_last ON sample_box (life, last_report_at)"
      );
    } catch {
      // 旧版 MySQL 不支持 IF NOT EXISTS，索引已存在时忽略。
    }
    this.boxIndexed = true;
  }

  async save(box) {
    await this.#save(this.executor, box);
  }

  /** 调用方持有设备接入锁；事务内重新校验状态、范围和所有未结束任务。 */
  async deleteBox(id, authorize, { wipe = "", by = "" } = {}) {
    await this.flush();
    const result = await this.executor.transaction(async (db) => {
      const lock = db.dialect === "mysql" ? " FOR UPDATE" : "";
      const row = await db.get(`SELECT * FROM sample_box WHERE id=?${lock}`, [id]);
      if (!row || !authorize(BoxState.fromRow(row))) return { error: "采样箱不存在", status: 404 };
      if (!["未使用", "停用"].includes(row.life))
        return { error: "只能删除未使用或停用的采样箱", status: 409 };
      const pending = await db.get(
        `SELECT t.id FROM sample_task t JOIN sample_task_box m ON m.task_id=t.id WHERE m.box_id=? AND t.status NOT IN (${ENDED_SQL}) AND m.inspected_at IS NULL LIMIT 1`,
        [id]
      );
      const active = await db.get("SELECT task_id FROM box_active_task WHERE box_id=?", [id]);
      if (pending || active) return { error: "采样箱仍关联未结束任务，请先结束任务", status: 409 };
      // 要抹除设备时档案先留着，设备确认重启后由 removeWiped 删除；不抹除则直接删，并撤销可能还挂着的抹除请求。
      if (wipe) {
        await queueWipe(db, row, wipe, by);
        return { deleted: false, wiping: true };
      }
      await db.run("DELETE FROM box_wipe_pending WHERE imei=?", [row.imei]);
      await this.#purge(db, row);
      return { deleted: true };
    });
    this.summaryCache?.clear();
    return result;
  }

  /** 设备确认抹除完成后删除旧档案。调用方持有设备接入锁；任务关联在请求时已核对过，这里不再拦截。 */
  async removeWiped(imei) {
    await this.flush();
    const removed = await this.executor.transaction(async (db) => {
      const row = await db.get("SELECT * FROM sample_box WHERE imei=?", [imei]);
      if (!row) return null;
      await this.#purge(db, row);
      return row.id;
    });
    this.summaryCache?.clear();
    return removed;
  }

  async #purge(db, row) {
    await db.run("UPDATE sample_task_box SET org_id=?,owner_id=? WHERE box_id=?", [
      row.org_id,
      row.owner_id,
      row.id,
    ]);
    for (const table of [
      "sample_uplink",
      "box_report_delivery",
      "box_report_policy",
      "box_dump_record",
      "box_dump_request",
    ])
      await db.run(`DELETE FROM ${table} WHERE box_id=?`, [row.id]);
    await db.run("DELETE FROM sample_box WHERE id=?", [row.id]);
    for (const table of ["box_ack_gap", "box_ack"])
      await db.run(`DELETE FROM ${table} WHERE imei=?`, [row.imei]);
  }

  async appendLog(record) {
    await this.batch.add(record);
  }

  flush() {
    return this.batch.flush();
  }

  /**
   * 单箱上报必须带时间。语句不取原文，翻页用上一页最后的时间和主键。
   * 电量曲线要解码 raw（chg/bat/rp/rc），7 天真机 ~7 万行：
   * - 键集分页取行＋每页之间让出事件循环，其他请求/上报 ACK 不被冻结；
   * - 先按设备时间过滤再解压，补传窗口外的行不白花 gunzip；
   * - 大序列解码结果按箱缓存（LRU），COUNT+MAX(id) 守卫行集不变才复用，
   *   范围切换（1h⊂7d）直接命中，不再每次全量重解。
   */
  async listBattery(boxId, from, to) {
    if (this.batch && typeof this.batch.flush === "function") await this.batch.flush();
    const columns = await this.#uplinkColumns();
    // 补传的记录晚到：收到时间往后多看一天，再按设备时间筛回到所选范围
    const later = new Date(Date.parse(to.replace(" ", "T")) + 86400000);
    const until = Number.isFinite(later.getTime()) ? formatTimestamp(later) : to;
    const cached = this.batteryCache.get(boxId);
    if (cached && cached.from <= from) {
      const guard = await this.#batteryGuard(boxId, cached.from, cached.until);
      if (guard.count === cached.count && guard.maxId === cached.maxId) {
        this.batteryCache.delete(boxId);
        this.batteryCache.set(boxId, cached);
        const rows = cached.rows.filter(
          (row) =>
            row.received_at >= from &&
            row.received_at <= until &&
            batteryDeviceTime(row) >= from &&
            batteryDeviceTime(row) <= to
        );
        rows.startFull = await this.#batteryStartsFull(boxId, from, columns);
        return rows;
      }
      this.batteryCache.delete(boxId);
    }
    const selected = ["id", "received_at", "summary"];
    if (columns.has("device_time")) selected.push("device_time");
    if (columns.has("raw")) selected.push("raw");
    if (columns.has("raw_gz")) selected.push("raw_gz");
    const before = await this.#batteryGuard(boxId, from, until);
    const mapped = [];
    let keyAt = null;
    let keyId = null;
    for (;;) {
      const keyset = keyAt == null ? "" : " AND (received_at > ? OR (received_at = ? AND id > ?))";
      const params =
        keyAt == null ? [boxId, from, until] : [boxId, from, until, keyAt, keyAt, keyId];
      const page = await this.executor.all(
        `SELECT ${selected.join(", ")} FROM sample_uplink
         WHERE box_id = ? AND received_at >= ? AND received_at <= ?${keyset}
         ORDER BY received_at, id LIMIT ${BATTERY_PAGE}`,
        params
      );
      for (const row of page) {
        keyAt = row.received_at;
        keyId = row.id;
        const time = batteryDeviceTime(row);
        if (time < from || time > to) continue;
        const raw = uplinkText(row);
        mapped.push({
          received_at: row.received_at,
          device_time: row.device_time || "",
          summary: row.summary,
          stmMv: raw.match(/,bat=(\d+)(?=,|\\|\s|"|$)/)?.[1],
          charge: chargeFromRaw(raw),
          periodSec: Number(raw.match(/,rp=(\d+)(?=,|\\|\s|"|$)/)?.[1]),
          chargeOnly: /,rc=1(?=,|\\|\s|"|$)/.test(raw),
        });
      }
      if (page.length < BATTERY_PAGE) break;
      // 让出事件循环：分页解码期间心跳/轮询/其他用户请求照常响应
      await new Promise((resolve) => setImmediate(resolve));
    }
    const after = await this.#batteryGuard(boxId, from, until);
    // 解码期间有新上报（守卫变了）就不缓存，避免把缺行的快照钉住；下次请求重建
    if (
      mapped.length >= BATTERY_CACHE_MIN &&
      before.count === after.count &&
      before.maxId === after.maxId
    ) {
      this.batteryCache.delete(boxId);
      this.batteryCache.set(boxId, {
        from,
        until,
        count: after.count,
        maxId: after.maxId,
        rows: mapped,
      });
      while (this.batteryCache.size > BATTERY_CACHE_MAX)
        this.batteryCache.delete(this.batteryCache.keys().next().value);
    }
    mapped.startFull = await this.#batteryStartsFull(boxId, from, columns);
    return mapped;
  }

  /** 行集指纹：只走 (box_id, received_at) 索引（叶子含主键 id），毫秒级。 */
  async #batteryGuard(boxId, from, until) {
    const row = await this.executor.get(
      `SELECT COUNT(*) AS c, MAX(id) AS m FROM sample_uplink
       WHERE box_id = ? AND received_at >= ? AND received_at <= ?`,
      [boxId, from, until]
    );
    return { count: Number(row?.c ?? 0), maxId: Number(row?.m ?? -1) };
  }

  async #uplinkColumns() {
    if (this.uplinkColumns) return this.uplinkColumns;
    const rows =
      this.executor.dialect === "mysql"
        ? await this.executor.all(
            `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sample_uplink'`
          )
        : await this.executor.all("PRAGMA table_info(sample_uplink)");
    this.uplinkColumns = new Set(rows.map((row) => row.name));
    return this.uplinkColumns;
  }

  /**
   * 往前看最多约 3 小时。先碰到充满且电压一直不低于 4.1 V，窗口一开始就算充满。
   * 先碰到电压掉下去，就不继承之前的充满。逐行解压同样分块让出事件循环。
   */
  async #batteryStartsFull(boxId, from, columns) {
    const selected = ["summary"];
    if (columns.has("raw")) selected.push("raw");
    if (columns.has("raw_gz")) selected.push("raw_gz");
    const rows = await this.executor.all(
      `SELECT ${selected.join(", ")} FROM sample_uplink
       WHERE box_id = ? AND received_at < ?
       ORDER BY received_at DESC LIMIT 2000`,
      [boxId, from]
    );
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const mv = readMillivolts(row.summary);
      if (mv != null && mv < FULL_RELEASE_MV) return false;
      if (chargeFromRaw(uplinkText(row)) === 2) return true;
      if (index % 256 === 255) await new Promise((resolve) => setImmediate(resolve));
    }
    return false;
  }

  async listPlaces(boxId) {
    if (this.batch && typeof this.batch.flush === "function") await this.batch.flush();
    const load = async (lngColumn, latColumn) => {
      const rows = await this.executor.all(
        `SELECT ROUND(${lngColumn}, 5) AS lng, ROUND(${latColumn}, 5) AS lat,
                COUNT(*) AS count, MAX(received_at) AS latest
         FROM sample_uplink
         WHERE box_id = ? AND ${lngColumn} IS NOT NULL AND ${latColumn} IS NOT NULL
         GROUP BY ROUND(${lngColumn}, 5), ROUND(${latColumn}, 5)`,
        [boxId]
      );
      return rows
        .map((row) => ({
          lng: Number(row.lng),
          lat: Number(row.lat),
          count: Number(row.count),
          latest: row.latest || "",
        }))
        .filter((row) => Number.isFinite(row.lng) && Number.isFinite(row.lat));
    };
    return {
      lbs: await load("lbs_lng", "lbs_lat"),
      gps: await load("gps_lng", "gps_lat"),
    };
  }

  async listLogs(boxId, range = {}) {
    await this.batch.flush();
    let from = range.from;
    let to = range.to;
    if (!from || !to) {
      const resolved = resolveTimeRange(range);
      if (resolved.error) throw badRequest(resolved.error);
      from = resolved.from;
      to = resolved.to;
    }
    const limit = pageLimit(range.limit);
    const params = [boxId, from, to];
    const where = ["box_id = ?", "received_at >= ?", "received_at <= ?"];
    const kinds = readUplinkKinds(range.kind);
    if (kinds.length) {
      where.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
      params.push(...kinds);
    }
    const keyset = Boolean(range.cursorTime && range.cursorId);
    if (keyset) {
      where.push("(received_at < ? OR (received_at = ? AND id < ?))");
      const cursorId = Number(range.cursorId);
      params.push(
        range.cursorTime,
        range.cursorTime,
        Number.isSafeInteger(cursorId) ? cursorId : range.cursorId
      );
    }
    const anomaly = readAnomaly(range.anomaly);
    let sql;
    if (anomaly) {
      // 电压在摘要文本里：先在内层取成 mv 列，外层按阈值过滤（与概览聚合同一表达式）
      sql = `SELECT ${UPLINK_LIST_COLUMNS.join(", ")}
      FROM (SELECT ${UPLINK_LIST_COLUMNS.join(", ")}, ${uplinkMvSql(this.executor.dialect)} AS mv
        FROM sample_uplink
        WHERE ${where.join(" AND ")}) u
      WHERE ${anomalyWhere(anomaly)}`;
      params.push(anomaly.lowMv);
    } else {
      sql = `SELECT ${UPLINK_LIST_COLUMNS.join(", ")}
      FROM sample_uplink
      WHERE ${where.join(" AND ")}`;
    }
    sql += ` ORDER BY received_at DESC, id DESC LIMIT ${limit + 1}`;
    const offset = keyset ? 0 : pageOffset(range.page, limit);
    if (offset) sql += ` OFFSET ${offset}`;
    const rows = await this.executor.all(sql, params);
    const hasMore = rows.length > limit;
    const list = rows.slice(0, limit).map((row) => UplinkRecord.fromRow(row));
    const last = list[list.length - 1];
    return {
      list,
      nextCursor: hasMore && last ? { time: last.receivedAt, id: last.id } : null,
    };
  }

  /**
   * 上报记录页概览：当前筛选范围一次 GROUP BY kind 聚合（与翻页游标无关）。
   * total 给分页器；MIN/MAX 电压与列表「仅看异常」用同一提取表达式；latest 给「最近上报」。
   * 不取原文列，kind/anomaly 过滤与 listLogs 完全同口径。
   */
  async uplinkSummary(boxId, range = {}) {
    await this.batch.flush();
    let from = range.from;
    let to = range.to;
    if (!from || !to) {
      const resolved = resolveTimeRange(range);
      if (resolved.error) throw badRequest(resolved.error);
      from = resolved.from;
      to = resolved.to;
    }
    const params = [boxId, from, to];
    const where = ["box_id = ?", "received_at >= ?", "received_at <= ?"];
    const kinds = readUplinkKinds(range.kind);
    if (kinds.length) {
      where.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
      params.push(...kinds);
    }
    const anomaly = readAnomaly(range.anomaly);
    const inner = `SELECT kind, received_at, ${uplinkMvSql(this.executor.dialect)} AS mv
      FROM sample_uplink
      WHERE ${where.join(" AND ")}`;
    let outer = "";
    if (anomaly) {
      outer = ` WHERE ${anomalyWhere(anomaly)}`;
      params.push(anomaly.lowMv);
    }
    const rows = await this.executor.all(
      `SELECT kind, COUNT(*) AS n,
              MIN(CASE WHEN mv BETWEEN 2500 AND 4500 THEN mv END) AS min_mv,
              MAX(CASE WHEN mv BETWEEN 2500 AND 4500 THEN mv END) AS max_mv,
              MAX(received_at) AS latest
       FROM (${inner}) u${outer}
       GROUP BY kind`,
      params
    );
    const kindsOut = {};
    let total = 0;
    let minMv = null;
    let maxMv = null;
    let latest = "";
    for (const row of rows) {
      const count = Number(row.n) || 0;
      const kind = String(row.kind || "unknown");
      kindsOut[kind] = (kindsOut[kind] || 0) + count;
      total += count;
      const low = row.min_mv == null ? null : Number(row.min_mv);
      const high = row.max_mv == null ? null : Number(row.max_mv);
      if (low != null && (minMv == null || low < minMv)) minMv = low;
      if (high != null && (maxMv == null || high > maxMv)) maxMv = high;
      const at = String(row.latest || "");
      if (at > latest) latest = at;
    }
    return { total, kinds: kindsOut, minMv, maxMv, latest };
  }

  /** 多台箱子在一段时间内的上报，按时间倒序翻页。任务详情用，时间范围由调用方限定在任务窗口内。 */
  async listLogsMany(boxIds, range = {}) {
    await this.batch.flush();
    if (!boxIds.length) return { list: [], nextCursor: null };
    const limit = pageLimit(range.limit);
    const params = [...boxIds, range.from, range.to];
    let sql = `SELECT ${UPLINK_LIST_COLUMNS.join(", ")}
      FROM sample_uplink
      WHERE box_id IN (${boxIds.map(() => "?").join(", ")}) AND received_at >= ? AND received_at <= ?`;
    const allowed = ["boot", "timer", "pad", "shut", "chg", "chgs", "unknown"];
    const kinds = String(range.kind || "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => allowed.includes(item));
    if (kinds.length) {
      sql += ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
      params.push(...kinds);
    }
    if (range.cursorTime && range.cursorId) {
      sql += " AND (received_at < ? OR (received_at = ? AND id < ?))";
      const cursorId = Number(range.cursorId);
      params.push(
        range.cursorTime,
        range.cursorTime,
        Number.isSafeInteger(cursorId) ? cursorId : range.cursorId
      );
    }
    sql += ` ORDER BY received_at DESC, id DESC LIMIT ${limit + 1}`;
    const rows = await this.executor.all(sql, params);
    const hasMore = rows.length > limit;
    const list = rows.slice(0, limit).map((row) => UplinkRecord.fromRow(row));
    const last = list[list.length - 1];
    return { list, nextCursor: hasMore && last ? { time: last.receivedAt, id: last.id } : null };
  }

  async readRaw(boxId, logId, receivedAt) {
    await this.batch.flush();
    if (!receivedAt) return null;
    const mode = await rawStorage(this.executor);
    const columns = mode === "raw_gz" ? "raw, raw_gz" : "raw";
    const row = await this.executor.get(
      `SELECT ${columns} FROM sample_uplink WHERE box_id = ? AND id = ? AND received_at = ?`,
      [boxId, sqlId(logId), receivedAt]
    );
    if (!row) return null;
    if (row.raw_gz != null && row.raw_gz !== "") return decompressRaw(row.raw_gz);
    return decompressRaw(row.raw);
  }

  /** 最近动态走箱子当前状态。上报流水不能按全表时间倒序翻。 */
  async listRecent(limit = 50) {
    const size = Math.min(100, Math.max(1, Number(limit) || 50));
    const boxes = await this.list();
    return boxes.filter((box) => box.last).slice(0, size);
  }

  /** 下一个默认名称（采样箱_00000001）。编号是 IMEI，不再分配。 */
  async nextBoxName() {
    const allocate = (db) => this.#allocateName(db);
    if (typeof this.executor.transaction === "function") {
      return this.executor.transaction(allocate);
    }
    return this.#exclusive(() => allocate(this.executor));
  }

  /**
   * 箱子当前行马上提交。原文进入批量插入，避免每来一条就单独等落盘。
   * 新建时先锁编号行再插入，更新时只锁这一台箱子，两条路径不会交叉持锁。
   */
  async commitUplink(uplink, receivedAt) {
    const write = (db) => this.#writeUplink(db, uplink, receivedAt);
    const committed =
      typeof this.executor.transaction === "function"
        ? await this.executor.transaction(write)
        : await this.#exclusive(() => write(this.executor));
    await this.batch.add(committed.record);
    return committed;
  }

  // A queue ACK permits the STM to erase its only copy. Persist the raw event,
  // the box state and the cumulative ACK in the same database transaction.
  async commitQueuedUplink(uplink, receivedAt, queue) {
    return this.executor.transaction(async (db) => {
      const box = await this.#findByImei(db, uplink.imei, true);
      if (box) {
        const seen = await queue.seen(uplink, db);
        if (seen.dup) return { box, ack: seen.ack };
      }
      const committed = await this.#writeUplink(db, uplink, receivedAt);
      await this.batch.insert([committed.record], db);
      committed.ack = await queue.record(uplink, db);
      return committed;
    });
  }

  async #writeUplink(db, uplink, receivedAt) {
    let box = await this.#findByImei(db, uplink.imei, false);
    if (!box) {
      const name = await this.#allocateName(db);
      box =
        (await this.#findByImei(db, uplink.imei, false)) ||
        BoxState.createPending(uplink.imei, uplink, receivedAt, name);
    } else if (db.dialect === "mysql") {
      box = await this.#findByImei(db, uplink.imei, true);
    }
    // apply 返回派生种类、不再就地改入参（R-12）。存储层显式把它标注到 uplink.kind，
    // 供下游（录像、策略生效、指令确认、日志种类）统一读取——写回是编排层的显式决定，不是 apply 的隐藏副作用。
    const kind = box.apply(uplink, receivedAt);
    uplink.kind = kind;
    // 上报只改工况和位置；状态、归属、名称由管理操作和任务改，避免并发时被这一包的旧值盖回去
    await this.#save(db, box, MANAGED_COLUMNS);
    const record = UplinkRecord.capture(box, uplink, receivedAt, kind);
    return new CommittedUplink(box, record);
  }

  async #findByImei(db, imei, lock) {
    const locking = lock && db.dialect === "mysql" ? " FOR UPDATE" : "";
    const row = await db.get(`SELECT * FROM sample_box WHERE imei = ?${locking}`, [imei]);
    return row ? BoxState.fromRow(row) : null;
  }

  async #allocateName(db) {
    const locking = db.dialect === "mysql" ? " FOR UPDATE" : "";
    const row = await db.get(`SELECT next_no FROM sample_box_seq WHERE id = 1${locking}`);
    if (!row) throw new Error("缺少箱子编号序列");
    const next = Number(row.next_no);
    await db.run("UPDATE sample_box_seq SET next_no = ? WHERE id = 1", [next + 1]);
    return defaultBoxName(next);
  }

  async #save(db, box, keep = []) {
    const row = box.toRow();
    const values = BOX_COLUMNS.map((column) => row[column]);
    const marks = BOX_COLUMNS.map(() => "?").join(", ");
    const mutable = BOX_COLUMNS.filter(
      (column) => column !== "id" && column !== "imei" && !keep.includes(column)
    );
    if (db.dialect === "mysql") {
      const assignments = mutable.map((column) => `${column} = ?`).join(", ");
      const updateValues = mutable.map((column) => row[column]);
      await db.run(
        `INSERT INTO sample_box (${BOX_COLUMNS.join(", ")}) VALUES (${marks})
         ON DUPLICATE KEY UPDATE ${assignments}`,
        [...values, ...updateValues]
      );
      return;
    }
    const assignments = mutable.map((column) => `${column} = excluded.${column}`).join(", ");
    await db.run(
      `INSERT INTO sample_box (${BOX_COLUMNS.join(", ")}) VALUES (${marks})
       ON CONFLICT(imei) DO UPDATE SET ${assignments}`,
      values
    );
  }

  #exclusive(task) {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

const SUMMARY_TTL_MS = 5000;

/** 清单、统计、导出共用的条件。limits 由调用方按上报周期和电量预留算好。 */
function boxWhere({
  scope,
  q = "",
  matchImei = true,
  life = "",
  flag = "",
  limits = null,
  dialect = "sqlite",
  orgId = "",
}) {
  const where = [];
  const params = [];
  const scoped = scopeSql(scope);
  if (scoped) {
    where.push(scoped.sql);
    params.push(...scoped.params);
  }
  const text = String(q || "").trim();
  if (text) {
    const like = likePattern(text);
    // 编号就是 IMEI。没有「设备标识」权限的角色只让它搜名称，
    // 不然拿编号当筛选器就能把整队箱子的 IMEI 一台台试出来（和列表里 IMEI 打码是同一件事）。
    if (matchImei) {
      where.push(`(name LIKE ? ${ESCAPE_SQL} OR id LIKE ? ${ESCAPE_SQL})`);
      params.push(like, like);
    } else {
      where.push(`name LIKE ? ${ESCAPE_SQL}`);
      params.push(like);
    }
  }
  if (orgId != null && orgId !== "") {
    where.push("org_id = ?");
    params.push(String(orgId));
  }
  if (life) {
    where.push("life = ?");
    params.push(life);
  }
  if (flag && limits) {
    const online = onlineSql(dialect, limits.onlineSince, limits.company);
    // R13：低电/可调配阈值按公司电量预留 CASE；无公司覆盖时是裸全局值（与改造前一致）
    const low = companyCaseSql(
      limits.company,
      (entry) => (entry.batteryReserve == null ? null : usableMv(20, entry.batteryReserve)),
      limits.lowMv
    );
    const ready = companyCaseSql(
      limits.company,
      (entry) => (entry.batteryReserve == null ? null : usableMv(50, entry.batteryReserve)),
      limits.readyMv
    );
    if (flag === "alert") where.push("alert <> ''");
    if (flag === "offline") {
      where.push(`NOT ${online.sql}`);
      params.push(...online.params);
    }
    if (flag === "low") {
      where.push(`battery_mv > 0 AND battery_mv < ${low.sql}`);
      params.push(...low.params);
    }
    if (flag === "lid") where.push("lid = 1");
    if (flag === "ready") {
      where.push(`life = '未使用' AND alert = '' AND ${online.sql} AND battery_mv >= ${ready.sql}`);
      params.push(...online.params, ...ready.params);
    }
  }
  return { where, params };
}

function sqlId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}

/**
 * 在线判断的 SQL 片段。当前箱子自己的周期用于离线判断；仅充电模式且未充电时不据缺心跳断言掉线。
 *
 * 「现在几点」以前是直接拼进 SQL 文本的：同一句查询每次文字都不一样，语句缓存用不上，
 * 时间还绕过了参数通道（L-P2-8）。现在 now 和阈值 onlineSince 一起放 params 里返回，
 * 顺序就是它们在片段里出现的顺序（先 onlineSince，再 now），调用点按这个顺序展开。
 * R13：宽限按公司层 CASE（companyCaseSql，检测站箱按寄出公司）；无公司覆盖时与改造前逐字节一致。
 * CASE 的部门 id 占位符排在片段末尾（宽限在 SQL 文本最后出现），调用点按序展开。
 */
function onlineSql(dialect, onlineSince, company = null) {
  const now = formatTimestamp(new Date(Math.floor(Date.now() / 5000) * 5000)).slice(0, 19);
  const chargeOnly = currentBoxSettings().reportOnlyWhenCharging ? 1 : 0;
  const elapsed =
    dialect === "mysql"
      ? "TIMESTAMPDIFF(SECOND, last_report_at, ?)"
      : "(julianday(?) - julianday(last_report_at))*86400";
  // B3/#18 宽限分支：被未结束任务占用且从未上报的箱子，建单后 grace 内不算离线（中性），超 grace 才算离线。
  // bound_task_at 与 now 同格式（formatTimestamp 墙钟）；grace 为公司化 CASE 或全局整数秒，内插安全。
  const grace = companyCaseSql(company, (entry) => entry.taskOfflineGraceSec, offlineGraceSec());
  const elapsedBound =
    dialect === "mysql"
      ? "TIMESTAMPDIFF(SECOND, bound_task_at, ?)"
      : "(julianday(?) - julianday(bound_task_at))*86400";
  return {
    // 外层必须整体括号：调用点有 `NOT ${sql}`，SQL 的 NOT 优先级高于 OR，不包裹会短路宽限分支
    sql: `((last_report_at <> '' AND ((COALESCE(policy_charge_only,${chargeOnly})=1 AND charge=0) OR (CASE WHEN policy_period_sec IS NULL THEN last_report_at >= ? ELSE ${elapsed} <= policy_period_sec*3 END))) OR (last_report_at = '' AND bound_task_at <> '' AND ${elapsedBound} <= ${grace.sql}))`,
    params: [onlineSince, now, now, ...grace.params],
  };
}
