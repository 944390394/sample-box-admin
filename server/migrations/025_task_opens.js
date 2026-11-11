/** 任务开始、结束时各箱的开箱次数，用来算任务期间开了几次箱，和任务的开箱次数上限比。 */
export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sample_task_box")
      : await db.all("PRAGMA table_info(sample_task_box)");
  const names = new Set(columns.map((r) => r.Field || r.name));
  for (const name of ["opens_start", "opens_end"]) {
    if (!names.has(name)) await db.run(`ALTER TABLE sample_task_box ADD COLUMN ${name} INTEGER`);
  }
}
