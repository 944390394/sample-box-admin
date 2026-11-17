/** 已结束任务保留箱号和所属范围快照，删除设备不扩大历史任务的可见范围。 */
export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sample_task_box")
      : await db.all("PRAGMA table_info(sample_task_box)");
  const names = new Set(columns.map((r) => r.Field || r.name));
  for (const name of ["org_id", "owner_id"]) {
    if (!names.has(name))
      await db.run(`ALTER TABLE sample_task_box ADD COLUMN ${name} VARCHAR(64)`);
    await db.run(
      `UPDATE sample_task_box SET ${name}=(SELECT ${name} FROM sample_box WHERE id=sample_task_box.box_id) WHERE ${name} IS NULL`
    );
  }
  if (db.dialect === "mysql") {
    const indexes = await db.all("SHOW INDEX FROM sample_task_box");
    if (!indexes.some((r) => r.Key_name === "idx_task_box_lookup"))
      await db.run("CREATE INDEX idx_task_box_lookup ON sample_task_box (box_id,task_id)");
  } else
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_task_box_lookup ON sample_task_box (box_id,task_id)"
    );
}
