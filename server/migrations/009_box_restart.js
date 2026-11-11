import { gunzipSync } from "node:zlib";

/**
 * 记下最近一次序号。序号变小就是一次重启，why=boot 没送到时用它重算连续运行。
 * 这次已经发生的重启也按流水回填。
 */

async function columnNames(db, table) {
  if (db.dialect === "mysql") {
    const rows = await db.all(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table]
    );
    return rows.map((row) => row.name);
  }
  const rows = await db.all(`PRAGMA table_info(${table})`);
  return rows.map((row) => row.name);
}

function textOf(row) {
  if (row.raw) return String(row.raw);
  if (row.raw_gz == null || row.raw_gz === "") return "";
  try {
    const bytes = Buffer.isBuffer(row.raw_gz) ? row.raw_gz : Buffer.from(row.raw_gz);
    return gunzipSync(bytes).toString("utf8");
  } catch {
    return "";
  }
}

function seqOf(text) {
  const found = String(text).match(/(?:^|,)seq=(\d+)/);
  return found ? Number(found[1]) : null;
}

export async function up(db) {
  const boxColumns = await columnNames(db, "sample_box");
  if (!boxColumns.includes("report_seq")) {
    const type = db.dialect === "mysql" ? "INT NOT NULL DEFAULT 0" : "INTEGER NOT NULL DEFAULT 0";
    await db.exec(`ALTER TABLE sample_box ADD COLUMN report_seq ${type}`);
  }

  const uplinkColumns = await columnNames(db, "sample_uplink");
  const rawGz = uplinkColumns.includes("raw_gz");
  const boxes = await db.all("SELECT id, booted_at, last_power_off FROM sample_box");
  for (const box of boxes) {
    const rows = await db.all(
      `SELECT received_at, device_time, raw${rawGz ? ", raw_gz" : ""}
       FROM sample_uplink WHERE box_id = ? ORDER BY id`,
      [box.id]
    );
    let previousSeq = null;
    let previousTime = "";
    let restartAt = "";
    let powerOffAt = "";
    let latestSeq = 0;
    for (const row of rows) {
      const seq = seqOf(textOf(row));
      const stamp = row.device_time || row.received_at || "";
      if (seq == null) {
        if (stamp) previousTime = stamp;
        continue;
      }
      if (previousSeq != null && seq < previousSeq) {
        restartAt = stamp;
        powerOffAt = previousTime;
      }
      previousSeq = seq;
      latestSeq = seq;
      if (stamp) previousTime = stamp;
    }
    if (latestSeq > 0) {
      await db.run("UPDATE sample_box SET report_seq = ? WHERE id = ?", [latestSeq, box.id]);
    }
    if (restartAt && restartAt > (box.booted_at || "")) {
      await db.run("UPDATE sample_box SET booted_at = ? WHERE id = ?", [restartAt, box.id]);
    }
    if (powerOffAt && !box.last_power_off) {
      await db.run("UPDATE sample_box SET last_power_off = ? WHERE id = ?", [powerOffAt, box.id]);
    }
  }
}
