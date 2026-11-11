import { defaultBoxName } from "../domain/boxName.js";
import { currentBoxSettings } from "../settings/boxConfig.js";
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
import { scopeSql } from "../auth/boxAccess.js";
import { queueWipe } from "../settings/DeviceCommands.js";
import { ENDED_SQL } from "../settings/taskFlow.js";

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

/** 管理操作和任务维护的列：上报写库时不覆盖（新建箱子时照常写入）。 */
const MANAGED_COLUMNS = ["life", "org", "org_id", "owner", "owner_id", "name"];

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
    const rows = await this.executor.all(
      `SELECT ${BOX_COLUMNS.join(", ")} FROM sample_box ORDER BY last_report_at DESC`
    );
    return rows.map((row) => BoxState.fromRow(row));
  }

  async latest({ scope = null, limit = 50 } = {}) {
    await this.#ensureBoxIndex();
    const filter = boxWhere({ scope });
    filter.where.push("last_report_at <> ''");
    const size = Math.min(100, Math.max(1, Number(limit) || 50));
    const rows = await this.executor.all(
      `SELECT ${BOX_COLUMNS.join(", ")} FROM sample_box WHERE ${filter.where.join(" AND ")}
       ORDER BY last_report_at DESC LIMIT ?`,
      [...filter.params, size]
    );
    return rows.map((row) => BoxState.fromRow(row));
  }

  /**
   * 清单页按页取。十万台时不能把整表送到浏览器。
   * 范围、快捷筛选、所属单位都落成 WHERE。按名称或编号（IMEI）搜。
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
    const base = boxWhere({ scope, q, matchImei, orgId });
    const filter = boxWhere({
      scope,
      q,
      matchImei,
      life,
      flag,
      limits,
      dialect: this.executor.dialect,
      orgId,
    });
    const whereSql = filter.where.length ? `WHERE ${filter.where.join(" AND ")}` : "";
    const totalRow = await this.executor.get(
      `SELECT COUNT(*) AS n FROM sample_box ${whereSql}`,
      filter.params
    );
    const size = Math.min(100, Math.max(1, Number(pageSize) || 20));
    const offset = (Math.max(1, Number(page) || 1) - 1) * size;
    const rows = await this.executor.all(
      `SELECT * FROM sample_box ${whereSql}
       ORDER BY CASE WHEN life = '待激活' THEN 0 ELSE 1 END,
                CASE WHEN alert <> '' THEN 0 ELSE 1 END,
                last_report_at DESC
       LIMIT ? OFFSET ?`,
      [...filter.params, size, offset]
    );
    const summary = await this.#summarize(base, limits);
    return {
      list: rows.map((row) => BoxState.fromRow(row)),
      total: Number(totalRow?.n || 0),
      counts: summary.counts,
      flags: summary.flags,
    };
  }

  /** 范围内一次聚合出生命周期和快捷筛选的数量。轮询频繁，同一范围几秒内复用。 */
  async stats({ scope = null, limits = null } = {}) {
    await this.#ensureBoxIndex();
    return this.#summarize(boxWhere({ scope }), limits);
  }

  async #summarize(base, limits) {
    const key = JSON.stringify([base.where, base.params, limits]);
    const cached = this.summaryCache?.get(key);
    if (cached && Date.now() - cached.at < SUMMARY_TTL_MS) return cached.value;
    const whereSql = base.where.length ? `WHERE ${base.where.join(" AND ")}` : "";
    const online = onlineSql(this.executor.dialect);
    const lim = limits || { onlineSince: "9999", lowMv: 0, readyMv: 99999 };
    const rows = await this.executor.all(
      `SELECT life, COUNT(*) AS n,
              SUM(CASE WHEN alert <> '' THEN 1 ELSE 0 END) AS alert,
              SUM(CASE WHEN ${online} THEN 0 ELSE 1 END) AS offline,
              SUM(CASE WHEN battery_mv > 0 AND battery_mv < ? THEN 1 ELSE 0 END) AS low,
              SUM(CASE WHEN lid = 1 THEN 1 ELSE 0 END) AS lid,
              SUM(CASE WHEN life = '未使用' AND alert = '' AND ${online} AND battery_mv >= ?
                       THEN 1 ELSE 0 END) AS ready
       FROM sample_box ${whereSql} GROUP BY life`,
      [lim.onlineSince, lim.lowMv, lim.onlineSince, lim.readyMv, ...base.params]
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
   */
  async listBattery(boxId, from, to) {
    if (this.batch && typeof this.batch.flush === "function") await this.batch.flush();
    const columns = await this.#uplinkColumns();
    const selected = ["received_at", "summary"];
    if (columns.has("device_time")) selected.push("device_time");
    if (columns.has("raw")) selected.push("raw");
    if (columns.has("raw_gz")) selected.push("raw_gz");
    // 补传的记录晚到：收到时间往后多看一天，再按设备时间筛回到所选范围
    const later = new Date(Date.parse(to.replace(" ", "T")) + 86400000);
    const until = Number.isFinite(later.getTime()) ? formatTimestamp(later) : to;
    const rows = await this.executor.all(
      `SELECT ${selected.join(", ")} FROM sample_uplink
       WHERE box_id = ? AND received_at >= ? AND received_at <= ?
       ORDER BY received_at`,
      [boxId, from, until]
    );
    const mapped = rows
      .map((row) => {
        const raw = uplinkText(row);
        return {
          received_at: row.received_at,
          device_time: row.device_time || "",
          summary: row.summary,
          stmMv: raw.match(/,bat=(\d+)(?=,|\\|\s|"|$)/)?.[1],
          charge: chargeFromRaw(raw),
          periodSec: Number(raw.match(/,rp=(\d+)(?=,|\\|\s|"|$)/)?.[1]),
          chargeOnly: /,rc=1(?=,|\\|\s|"|$)/.test(raw),
        };
      })
      .filter((row) => {
        const time = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(row.device_time)
          ? row.device_time.slice(0, 19)
          : String(row.received_at).slice(0, 19);
        return time >= from && time <= to;
      });
    mapped.startFull = await this.#batteryStartsFull(boxId, from, columns);
    return mapped;
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
   * 先碰到电压掉下去，就不继承之前的充满。
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
    for (const row of rows) {
      const mv = readMillivolts(row.summary);
      if (mv != null && mv < FULL_RELEASE_MV) return false;
      if (chargeFromRaw(uplinkText(row)) === 2) return true;
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
      if (resolved.error) throw new Error(resolved.error);
      from = resolved.from;
      to = resolved.to;
    }
    const limit = pageLimit(range.limit);
    const params = [boxId, from, to];
    let sql = `SELECT ${UPLINK_LIST_COLUMNS.join(", ")}
      FROM sample_uplink
      WHERE box_id = ? AND received_at >= ? AND received_at <= ?`;
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
    return {
      list,
      nextCursor: hasMore && last ? { time: last.receivedAt, id: last.id } : null,
    };
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
    const kind = box.kindOf(uplink);
    box.apply(uplink, receivedAt);
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
    // MySQL 默认把反斜杠当字符串转义符，ESCAPE '\' 会让字面量不闭合，所以换成 !
    const like = `%${text.replace(/[!%_]/g, (char) => `!${char}`)}%`;
    // 编号就是 IMEI；名称和编号都能搜。matchImei 只为兼容旧调用，不再区分
    void matchImei;
    where.push("(name LIKE ? ESCAPE '!' OR id LIKE ? ESCAPE '!')");
    params.push(like, like);
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
    const online = onlineSql(dialect);
    if (flag === "alert") where.push("alert <> ''");
    if (flag === "offline") {
      where.push(`NOT ${online}`);
      params.push(limits.onlineSince);
    }
    if (flag === "low") {
      where.push("battery_mv > 0 AND battery_mv < ?");
      params.push(limits.lowMv);
    }
    if (flag === "lid") where.push("lid = 1");
    if (flag === "ready") {
      where.push(`life = '未使用' AND alert = '' AND ${online} AND battery_mv >= ?`);
      params.push(limits.onlineSince, limits.readyMv);
    }
  }
  return { where, params };
}

function sqlId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}

/** 当前箱子自己的周期用于离线判断；仅充电模式且未充电时不据缺心跳断言掉线。 */
function onlineSql(dialect) {
  const now = formatTimestamp(new Date(Math.floor(Date.now() / 5000) * 5000)).slice(0, 19);
  const chargeOnly = currentBoxSettings().reportOnlyWhenCharging ? 1 : 0;
  const elapsed =
    dialect === "mysql"
      ? `TIMESTAMPDIFF(SECOND, last_report_at, '${now}')`
      : `(julianday('${now}') - julianday(last_report_at))*86400`;
  return `(last_report_at <> '' AND ((COALESCE(policy_charge_only,${chargeOnly})=1 AND charge=0) OR (CASE WHEN policy_period_sec IS NULL THEN last_report_at >= ? ELSE ${elapsed} <= policy_period_sec*3 END)))`;
}
