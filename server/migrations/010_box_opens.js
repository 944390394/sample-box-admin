import { gunzipSync } from "node:zlib";

/**
 * 开箱次数以前只在芯片内存里，重启后会从 0 再报，服务器也跟着写成 0。
 * 按每次往上增加的差值把历史次数加回来，并记下芯片最近一次报的数。
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

function opensOf(text) {
  const found = String(text).match(/(?:^|,)opens=(\d+)/);
  return found ? Number(found[1]) : null;
}

export async function up(db) {
  const boxColumns = await columnNames(db, "sample_box");
  if (!boxColumns.includes("device_opens")) {
    const type = db.dialect === "mysql" ? "INT NULL" : "INTEGER";
    await db.exec(`ALTER TABLE sample_box ADD COLUMN device_opens ${type}`);
  }

  const uplinkColumns = await columnNames(db, "sample_uplink");
  const rawGz = uplinkColumns.includes("raw_gz");
  const boxes = await db.all("SELECT id FROM sample_box");
  for (const box of boxes) {
    const rows = await db.all(
      `SELECT raw${rawGz ? ", raw_gz" : ""} FROM sample_uplink WHERE box_id = ? ORDER BY id`,
      [box.id]
    );
    let total = 0;
    let device = null;
    for (const row of rows) {
      const reported = opensOf(textOf(row));
      if (reported == null) continue;
      if (device == null) {
        device = reported;
        if (reported > total) total = reported;
        continue;
      }
      if (reported >= device) total += reported - device;
      device = reported;
    }
    if (device == null) continue;
    await db.run("UPDATE sample_box SET opens = ?, device_opens = ? WHERE id = ?", [
      total,
      device,
      box.id,
    ]);
  }
}
