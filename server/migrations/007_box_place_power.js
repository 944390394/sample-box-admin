/**
 * 基站和 GPS 的详细地址、闪存剩余字节，以及电量学习记录。
 */

const ADDITIONS = {
  sqlite: [
    ["lbs_address", "TEXT NOT NULL DEFAULT ''"],
    ["gps_address", "TEXT NOT NULL DEFAULT ''"],
    ["storage_free", "INTEGER"],
    ["battery_mv", "INTEGER"],
    ["battery_model", "TEXT NOT NULL DEFAULT ''"],
  ],
  mysql: [
    ["lbs_address", "VARCHAR(255) NOT NULL DEFAULT ''"],
    ["gps_address", "VARCHAR(255) NOT NULL DEFAULT ''"],
    ["storage_free", "INT NULL"],
    ["battery_mv", "INT NULL"],
    ["battery_model", "TEXT NULL"],
  ],
};

async function columnNames(db) {
  if (db.dialect === "mysql") {
    const rows = await db.all(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sample_box'`
    );
    return new Set(rows.map((row) => row.name));
  }
  const rows = await db.all("PRAGMA table_info(sample_box)");
  return new Set(rows.map((row) => row.name));
}

export async function up(db) {
  const names = await columnNames(db);
  const additions = ADDITIONS[db.dialect === "mysql" ? "mysql" : "sqlite"];
  for (const [name, type] of additions) {
    if (names.has(name)) continue;
    await db.exec(`ALTER TABLE sample_box ADD COLUMN ${name} ${type}`);
  }
}
