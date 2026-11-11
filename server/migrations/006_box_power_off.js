/**
 * 掉电前最后一次还在走的时间。已有库补列，新库在 002 里已经带上。
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

export async function up(db) {
  if (await hasColumn(db, "last_power_off")) return;
  const type =
    db.dialect === "mysql" ? "VARCHAR(32) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''";
  await db.exec(`ALTER TABLE sample_box ADD COLUMN last_power_off ${type}`);
}
