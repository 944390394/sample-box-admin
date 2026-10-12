import { CommittedUplink } from "../domain/CommittedUplink.js";
import { BoxState } from "../domain/BoxState.js";
import { UplinkRecord } from "../domain/UplinkRecord.js";
import { BoxStore } from "./BoxStore.js";

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
    const rows = await this.executor.all("SELECT * FROM sample_box ORDER BY last_report_at DESC");
    return rows.map((row) => BoxState.fromRow(row));
  }

  async save(box) {
    await this.#save(this.executor, box);
  }

  async appendLog(record) {
    await this.#appendLog(this.executor, record);
  }

  async listLogs(boxId) {
    const rows = await this.executor.all(
      `SELECT * FROM sample_uplink WHERE box_id = ? ORDER BY received_at DESC LIMIT 100`,
      [boxId]
    );
    return rows.map((row) => UplinkRecord.fromRow(row));
  }

  async listRecent(limit = 50) {
    const size = Math.min(100, Math.max(1, Number(limit) || 50));
    const rows = await this.executor.all(
      `SELECT * FROM sample_uplink ORDER BY received_at DESC LIMIT ${size}`
    );
    return rows.map((row) => UplinkRecord.fromRow(row));
  }

  async nextBoxId() {
    const allocate = (db) => this.#allocateId(db);
    if (typeof this.executor.transaction === "function") {
      return this.executor.transaction(allocate);
    }
    return this.#exclusive(() => allocate(this.executor));
  }

  /**
   * 箱子和原始报文同一个事务。
   * 新建时先锁编号行再插入，更新时只锁这一台箱子，两条路径不会交叉持锁。
   */
  async commitUplink(uplink, receivedAt) {
    const write = (db) => this.#writeUplink(db, uplink, receivedAt);
    if (typeof this.executor.transaction === "function") {
      return this.executor.transaction(write);
    }
    return this.#exclusive(() => write(this.executor));
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
    await this.#appendLog(db, record);
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

  async #appendLog(db, record) {
    await db.run(
      `INSERT INTO sample_uplink
        (box_id, imei, received_at, device_time, kind, summary, raw, lbs_lng, lbs_lat, gps_lng, gps_lat)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.boxId,
        record.imei,
        record.receivedAt,
        record.deviceTime,
        record.kind,
        record.summary,
        record.raw,
        record.lbsLng,
        record.lbsLat,
        record.gpsLng,
        record.gpsLat,
      ]
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
