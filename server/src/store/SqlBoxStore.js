import { CommittedUplink } from "../domain/CommittedUplink.js";
import { BoxState } from "../domain/BoxState.js";
import { UplinkRecord } from "../domain/UplinkRecord.js";
import { pageLimit, resolveTimeRange } from "../log/timeRange.js";
import { BoxStore } from "./BoxStore.js";
import { decompressRaw } from "./rawCodec.js";
import { rawStorage } from "./schema.js";
import { UplinkBatch } from "./UplinkBatch.js";

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

const BOX_COLUMNS = [
  "id",
  "imei",
  "iccid",
  "imsi",
  "firmware",
  "org",
  "owner",
  "life",
  "alert",
  "battery",
  "csq",
  "last_report_at",
  "lbs",
  "lbs_lng",
  "lbs_lat",
  "gps",
  "gps_lng",
  "gps_lat",
  "opens",
  "activate_step",
  "powered_at",
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

  async list() {
    const rows = await this.executor.all(
      `SELECT ${BOX_COLUMNS.join(", ")} FROM sample_box ORDER BY last_report_at DESC`
    );
    return rows.map((row) => BoxState.fromRow(row));
  }

  async save(box) {
    await this.#save(this.executor, box);
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

  async nextBoxId() {
    const allocate = (db) => this.#allocateId(db);
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

  async #writeUplink(db, uplink, receivedAt) {
    let box = await this.#findByImei(db, uplink.imei, false);
    if (!box) {
      const id = await this.#allocateId(db);
      box =
        (await this.#findByImei(db, uplink.imei, false)) ||
        BoxState.createPending(id, uplink, receivedAt);
    } else if (db.dialect === "mysql") {
      box = await this.#findByImei(db, uplink.imei, true);
    }
    box.apply(uplink, receivedAt);
    await this.#save(db, box);
    const record = UplinkRecord.capture(box, uplink, receivedAt);
    return new CommittedUplink(box, record);
  }

  async #findByImei(db, imei, lock) {
    const locking = lock && db.dialect === "mysql" ? " FOR UPDATE" : "";
    const row = await db.get(`SELECT * FROM sample_box WHERE imei = ?${locking}`, [imei]);
    return row ? BoxState.fromRow(row) : null;
  }

  async #allocateId(db) {
    const locking = db.dialect === "mysql" ? " FOR UPDATE" : "";
    const row = await db.get(`SELECT next_no FROM sample_box_seq WHERE id = 1${locking}`);
    if (!row) throw new Error("缺少箱子编号序列");
    const next = Number(row.next_no);
    await db.run("UPDATE sample_box_seq SET next_no = ? WHERE id = 1", [next + 1]);
    return `BOX-${String(next).padStart(3, "0")}`;
  }

  async #save(db, box) {
    const row = box.toRow();
    const values = BOX_COLUMNS.map((column) => row[column]);
    const marks = BOX_COLUMNS.map(() => "?").join(", ");
    const mutable = BOX_COLUMNS.filter((column) => column !== "id" && column !== "imei");
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

function sqlId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}
