/**
 * 总览接口的支撑索引：待检测按任务批查箱链接、当日检测按时间范围扫、单位任务按创建时间取最近。
 * 几千张单、上万台箱时避免全表扫。
 */
export async function up(db) {
  const wanted = [
    ["idx_task_box_task", "sample_task_box", "(task_id, inspected_at)"],
    ["idx_task_box_inspected", "sample_task_box", "(inspected_at)"],
    ["idx_sample_task_created", "sample_task", "(created_at)"],
  ];
  if (db.dialect === "mysql") {
    for (const [name, table, cols] of wanted) {
      const indexes = await db.all(`SHOW INDEX FROM ${table}`);
      if (!indexes.some((r) => r.Key_name === name))
        await db.run(`CREATE INDEX ${name} ON ${table} ${cols}`);
    }
    return;
  }
  for (const [name, table, cols] of wanted) {
    await db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} ${cols}`);
  }
}
