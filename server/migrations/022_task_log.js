/**
 * 任务每一步的流转记录：谁、什么时候、当时各箱离目的地多远（detail 里的 JSON）。
 * 调拨单另存寄出、接收单位编号：接收单位看不到寄出方的箱子，也要能看到并签收这张单。
 */
export async function up(db) {
  await db.run(
    `CREATE TABLE IF NOT EXISTS sample_task_log (id VARCHAR(64) PRIMARY KEY, task_id VARCHAR(64) NOT NULL, status VARCHAR(16) NOT NULL, action VARCHAR(32) NOT NULL, actor_id VARCHAR(32), actor_name VARCHAR(64), note VARCHAR(1000), detail TEXT, created_at VARCHAR(32) NOT NULL)`
  );
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sample_task")
      : await db.all("PRAGMA table_info(sample_task)");
  const names = new Set(columns.map((r) => r.Field || r.name));
  for (const name of ["from_org_id", "to_org_id"]) {
    if (!names.has(name)) await db.run(`ALTER TABLE sample_task ADD COLUMN ${name} VARCHAR(32)`);
  }
  if (db.dialect === "mysql") {
    const indexes = await db.all("SHOW INDEX FROM sample_task_log");
    if (!indexes.some((r) => r.Key_name === "idx_task_log_task"))
      await db.run("CREATE INDEX idx_task_log_task ON sample_task_log (task_id,created_at)");
  } else
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_task_log_task ON sample_task_log (task_id,created_at)"
    );
}
