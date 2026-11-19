/** 把「送检」从 body JSON 布尔提升为真列 is_inspect；不改任何存量 kind 值。回填口径与统计侧 LIKE 完全同源。 */
export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sample_task")
      : await db.all("PRAGMA table_info(sample_task)");
  const names = new Set(columns.map((r) => r.Field || r.name));
  if (!names.has("is_inspect"))
    await db.run(
      db.dialect === "mysql"
        ? "ALTER TABLE sample_task ADD COLUMN is_inspect TINYINT NOT NULL DEFAULT 0"
        : "ALTER TABLE sample_task ADD COLUMN is_inspect INTEGER NOT NULL DEFAULT 0"
    );
  await db.run(
    `UPDATE sample_task SET is_inspect=1 WHERE kind IN ('调拨','送检') AND body LIKE '%"inspect":true%'`
  );
}
