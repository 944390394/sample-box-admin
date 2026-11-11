import { firmwareSupportsRemote } from "./boxConfig.js";

const DAY = 86400000;
const REISSUE_MS = 60000;
const STALE_MS = 30 * 60000;
const ACTIVE = ["querying", "ready", "pending", "running"];
export const WIPE_KEEP_MS = 30 * DAY;
export const DUMP_MAX = 20000;
const KIND = { 1: "存活", 2: "掉电", 3: "上电", 4: "开箱" };

/** 登记待抹除。档案保留到设备确认抹除完成才删除，期间页面显示「抹除中」。 */
export async function queueWipe(tx, { imei, id }, mode, by) {
  await tx.run("DELETE FROM box_wipe_pending WHERE imei=?", [imei]);
  await tx.run(
    "INSERT INTO box_wipe_pending (imei,box_id,mode,requested_by,requested_at) VALUES (?,?,?,?,?)",
    [imei, id, mode, String(by || ""), new Date().toISOString()]
  );
}

/**
 * 服务器给设备的附加指令。指令写在 ok 之后单独成行，补传队列的确认不受影响。
 * 抹除、导出都只发给 1.0.6 以上的固件；s 是设备最近一次上报的 seq，设备用它核对指令是不是对这一包的回应。
 */
export class DeviceCommands {
  constructor(db) {
    this.db = db;
  }

  /**
   * 返回 { wipe: { mode, seq } } 表示这包不入库，只回抹除指令；
   * { done: { boxId } } 表示设备已重启并报 opens=0，调用方删掉旧档案后调 finishWipe，这一包再按新设备建档；
   * null 表示照常处理（没有待抹除，或指令已过期、设备不支持，档案原样保留）。
   */
  async onUplink(uplink) {
    const row = await this.db.get("SELECT * FROM box_wipe_pending WHERE imei=?", [uplink.imei]);
    if (!row) return null;
    if (Date.now() - Date.parse(row.requested_at) > WIPE_KEEP_MS) return this.#drop(uplink.imei);
    if (uplink.why === "boot" && uplink.opens === 0 && row.issued_at)
      return { done: { boxId: row.box_id } };
    if (!firmwareSupportsRemote(uplink.firmware) || uplink.seq == null)
      return this.#drop(uplink.imei);
    return { wipe: { mode: row.mode, seq: uplink.seq, imei: uplink.imei } };
  }

  /** 抹除确认后清掉待抹除记录。 */
  finishWipe(imei) {
    return this.#drop(imei);
  }

  /** 页面用：这批设备里哪些正在抹除。 */
  async wipeStates(imeis) {
    const list = [...new Set(imeis.filter(Boolean))];
    const out = new Map();
    if (!list.length) return out;
    const rows = await this.db.all(
      `SELECT imei,mode,requested_at,issued_at FROM box_wipe_pending WHERE imei IN (${list.map(() => "?").join(",")})`,
      list
    );
    for (const row of rows)
      out.set(row.imei, {
        mode: row.mode,
        requestedAt: row.requested_at,
        issued: Boolean(row.issued_at),
      });
    return out;
  }

  async #drop(imei) {
    await this.db.run("DELETE FROM box_wipe_pending WHERE imei=?", [imei]);
    return null;
  }

  wipeLine({ mode, seq, imei }) {
    return {
      text: `wipe m=${mode === "full" ? "f" : "q"} s=${seq}\n`,
      onSent: () =>
        this.db.run("UPDATE box_wipe_pending SET issued_at=?,issued_seq=? WHERE imei=?", [
          new Date().toISOString(),
          seq,
          imei,
        ]),
    };
  }

  /** 箱子已有档案时，是否有要发的导出指令。 */
  async downlink(box, uplink) {
    if (!box || uplink.seq == null || !firmwareSupportsRemote(box.firmware)) return null;
    const row = await this.db.get(
      `SELECT * FROM box_dump_request WHERE box_id=? AND state IN ('querying','pending') ORDER BY created_at DESC LIMIT 1`,
      [box.id]
    );
    if (!row) return null;
    if (row.issued_at && Date.now() - Date.parse(row.issued_at) < REISSUE_MS) return null;
    const text =
      row.state === "querying"
        ? `dump q s=${uplink.seq}\n`
        : `dump f=${row.from_sec} n=${row.max_count} s=${uplink.seq} r=${row.id}\n`;
    return {
      text,
      onSent: () =>
        this.db.run("UPDATE box_dump_request SET issued_at=?,updated_at=? WHERE id=?", [
          new Date().toISOString(),
          new Date().toISOString(),
          row.id,
        ]),
    };
  }

  async createDump(box, by) {
    const open = await this.latestDump(box.id);
    if (open && ACTIVE.includes(open.state) && Date.now() - Date.parse(open.updated_at) < STALE_MS)
      return open;
    let id = Math.floor(Date.now() / 1000);
    while (await this.db.get("SELECT id FROM box_dump_request WHERE id=?", [String(id)])) id += 1;
    const now = new Date().toISOString();
    await this.db.run(
      "INSERT INTO box_dump_request (id,box_id,imei,state,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      [String(id), box.id, box.imei, "querying", String(by || ""), now, now]
    );
    return this.dumpById(box.id, String(id));
  }

  /** 查询条数得到回复后，用户确认起始时间和上限才真正开始回传。 */
  async confirmDump(box, id, { fromSec, max }) {
    const row = await this.dumpById(box.id, id);
    if (!row || row.state !== "ready") return null;
    const count = Math.min(DUMP_MAX, Math.max(1, Math.floor(Number(max)) || DUMP_MAX));
    const from = Math.max(0, Math.floor(Number(fromSec)) || 0);
    await this.db.run(
      "UPDATE box_dump_request SET state='pending',from_sec=?,max_count=?,issued_at=NULL,updated_at=? WHERE id=?",
      [from, count, new Date().toISOString(), id]
    );
    return this.dumpById(box.id, id);
  }

  async cancelDump(box, id) {
    await this.db.run(
      "UPDATE box_dump_request SET state='cancelled',updated_at=? WHERE id=? AND box_id=? AND state IN ('querying','ready','pending','running')",
      [new Date().toISOString(), id, box.id]
    );
    return this.dumpById(box.id, id);
  }

  latestDump(boxId) {
    return this.db.get(
      "SELECT * FROM box_dump_request WHERE box_id=? ORDER BY created_at DESC LIMIT 1",
      [boxId]
    );
  }

  dumpById(boxId, id) {
    return this.db.get("SELECT * FROM box_dump_request WHERE id=? AND box_id=?", [
      String(id),
      boxId,
    ]);
  }

  /** 收到板子回传的 why=dumpinfo / why=dump。重复的段按 (请求, 段号) 丢弃。 */
  async takeDump(box, uplink) {
    const d = uplink.dump;
    if (!box || !d) return;
    const now = new Date().toISOString();
    if (uplink.why === "dumpinfo") {
      if (d.total == null) return;
      await this.db.run(
        `UPDATE box_dump_request SET state='ready',total=?,updated_at=? WHERE box_id=? AND state='querying'`,
        [d.total, now, box.id]
      );
      return;
    }
    if (d.req == null || d.part == null || !d.parts) return;
    const row = await this.dumpById(box.id, String(d.req));
    if (!row || !["pending", "running"].includes(row.state)) return;
    if (
      !(await this.db.get("SELECT part FROM box_dump_record WHERE req_id=? AND part=?", [
        row.id,
        d.part,
      ]))
    ) {
      await this.db.run("INSERT INTO box_dump_record (req_id,part,box_id,body) VALUES (?,?,?,?)", [
        row.id,
        d.part,
        box.id,
        d.body,
      ]);
    }
    const got = (
      await this.db.get("SELECT COUNT(*) n FROM box_dump_record WHERE req_id=?", [row.id])
    ).n;
    await this.db.run("UPDATE box_dump_request SET state=?,parts=?,updated_at=? WHERE id=?", [
      got >= d.parts ? "done" : "running",
      d.parts,
      now,
      row.id,
    ]);
  }

  /** 给页面看的状态；长时间没有进展的进行中请求显示为超时。 */
  async view(row) {
    if (!row) return null;
    const got = (
      await this.db.get("SELECT COUNT(*) n FROM box_dump_record WHERE req_id=?", [row.id])
    ).n;
    const stale = ACTIVE.includes(row.state) && Date.now() - Date.parse(row.updated_at) > STALE_MS;
    return {
      id: row.id,
      state: stale ? "timeout" : row.state,
      total: row.total,
      parts: row.parts,
      receivedParts: Number(got),
      fromSec: Number(row.from_sec),
      max: row.max_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** 展开成逐条记录，按时间升序。 */
  async records(id) {
    const rows = await this.db.all(
      "SELECT part,body FROM box_dump_record WHERE req_id=? ORDER BY part",
      [id]
    );
    const out = [];
    for (const row of rows) {
      for (const item of String(row.body).split(";")) {
        const [kind, sec, opens] = item.split(":").map(Number);
        if (!Number.isFinite(sec)) continue;
        out.push({
          kind: KIND[kind] || `类型${kind}`,
          sec,
          opens: Number.isFinite(opens) ? opens : "",
        });
      }
    }
    return out.sort((a, b) => a.sec - b.sec);
  }
}
