/**
 * 检测站开箱检测：每台箱子扫码「开始检测」的时间和人。有值表示这台箱子的本次任务已结束，
 * 可以再绑新任务单，开箱次数从新任务开始重新算。
 */
export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sample_task_box")
      : await db.all("PRAGMA table_info(sample_task_box)");
  const names = new Set(columns.map((r) => r.Field || r.name));
  if (!names.has("inspected_at"))
    await db.run("ALTER TABLE sample_task_box ADD COLUMN inspected_at VARCHAR(32)");
  if (!names.has("inspected_by"))
    await db.run("ALTER TABLE sample_task_box ADD COLUMN inspected_by VARCHAR(64)");
}
