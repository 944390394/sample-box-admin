/** 支撑占用 JOIN 与划拨/送检列表、counts/todo/mine 的 NOT IN(ENDED)+ORDER BY created_at 扫描。 */
export async function up(db) {
  const want = [
    ["idx_task_box_lookup", "sample_task_box", "(box_id,task_id)"],
    ["idx_task_kind_status", "sample_task", "(kind,status,created_at)"],
    ["idx_task_status_created", "sample_task", "(status,created_at)"],
  ];
  for (const [name, table, cols] of want) {
    if (db.dialect === "mysql") {
      const indexes = await db.all(`SHOW INDEX FROM ${table}`);
      if (!indexes.some((r) => r.Key_name === name))
        await db.run(`CREATE INDEX ${name} ON ${table} ${cols}`);
    } else await db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} ${cols}`);
  }
}
