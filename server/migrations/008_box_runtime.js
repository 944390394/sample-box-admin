/**
 * 最近一次上电时间。连续运行从这里算，下一次 why=boot 会把它拨回零点。
 * 已有箱子用最近一条上电报文回填，没有就用第一次入库的上电时间。
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
  if (!(await hasColumn(db, "booted_at"))) {
    const type =
      db.dialect === "mysql" ? "VARCHAR(32) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''";
    await db.exec(`ALTER TABLE sample_box ADD COLUMN booted_at ${type}`);
  }
  if (db.dialect === "mysql") return;
  await db.run(
    `UPDATE sample_box
     SET booted_at = COALESCE(
       (SELECT device_time FROM sample_uplink
        WHERE box_id = sample_box.id AND kind = 'boot' AND device_time != ''
        ORDER BY received_at DESC LIMIT 1),
       powered_at,
       ''
     )
     WHERE booted_at = ''`
  );
}
