import { gunzipSync } from "node:zlib";

/**
 * 上次结束充电的服务器时间。使用时间从这里起算，再次充电时清空。
 */

async function hasColumn(db, name) {
  if (db.dialect === "mysql") {
    const row = await db.get(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sample_box' AND COLUMN_NAME = ?`,
      [name]
    );
    return Boolean(row);
  }
  const rows = await db.all("PRAGMA table_info(sample_box)");
  return rows.some((row) => row.name === name);
}

function textOf(row) {
  if (row.raw) return String(row.raw);
  if (!row.raw_gz) return "";
  try {
    const bytes = Buffer.isBuffer(row.raw_gz) ? row.raw_gz : Buffer.from(row.raw_gz);
    return gunzipSync(bytes).toString("utf8");
  } catch {
    return "";
  }
}

function chargeOf(text) {
  const uart = String(text).match(/(?:^|[,\\\n])chg=(\d+)/);
  if (uart) return Number(uart[1]);
  const json = String(text).match(/"chg"\s*:\s*(\d+)/);
  if (json) return Number(json[1]);
  return null;
}

export async function up(db) {
  if (!(await hasColumn(db, "uncharged_at"))) {
    const type =
      db.dialect === "mysql" ? "VARCHAR(32) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''";
    await db.exec(`ALTER TABLE sample_box ADD COLUMN uncharged_at ${type}`);
  }
  // 更早的库只有流水索引、没有原文列，无法回放充电事件，保留原记录。
  const columns =
    db.dialect === "mysql"
      ? await db.all(
          "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sample_uplink'"
        )
      : await db.all("PRAGMA table_info(sample_uplink)");
  if (!columns.some((column) => column.name === "raw")) return;
  let rows;
  try {
    rows = await db.all(
      `SELECT box_id, received_at, raw, raw_gz FROM sample_uplink
       ORDER BY received_at, id`
    );
  } catch {
    rows = await db.all(
      `SELECT box_id, received_at, raw FROM sample_uplink
       ORDER BY received_at`
    );
  }
  const state = new Map();
  for (const row of rows) {
    const charge = chargeOf(textOf(row));
    if (charge == null) continue;
    const current = state.get(row.box_id) || { charge: null, unchargedAt: "" };
    const wasCharging = current.charge === 1 || current.charge === 2;
    if (wasCharging && charge === 0) current.unchargedAt = String(row.received_at);
    if (charge === 1 || charge === 2) current.unchargedAt = "";
    current.charge = charge;
    state.set(row.box_id, current);
  }
  for (const [boxId, current] of state) {
    if (!current.unchargedAt) continue;
    await db.run("UPDATE sample_box SET uncharged_at = ? WHERE id = ? AND uncharged_at = ''", [
      current.unchargedAt,
      boxId,
    ]);
  }
}
