/** 封箱那一刻各箱的开箱次数：之后再开箱算「封箱后开箱」，签收核验时列为异常。 */
export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sample_task_box")
      : await db.all("PRAGMA table_info(sample_task_box)");
  const names = new Set(columns.map((r) => r.Field || r.name));
  if (!names.has("opens_seal"))
    await db.run("ALTER TABLE sample_task_box ADD COLUMN opens_seal INTEGER");
}
