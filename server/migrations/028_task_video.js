/**
 * 开箱录像请求。采样任务要求录像时，箱子在采样单位开箱一次记一条，再向视频平台发请求。
 * status：待请求 / 已请求 / 录制中 / 已完成 / 失败 / 平台未接入。
 */
export async function up(db) {
  const text = db.dialect === "mysql" ? "TEXT" : "TEXT";
  await db.run(`CREATE TABLE IF NOT EXISTS sample_task_video (
    id VARCHAR(64) PRIMARY KEY,
    task_id VARCHAR(64) NOT NULL,
    box_id VARCHAR(64) NOT NULL,
    opened_at VARCHAR(32) NOT NULL,
    distance_m INTEGER,
    status VARCHAR(16) NOT NULL,
    detail ${text},
    url ${text},
    poster ${text},
    duration_sec INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at VARCHAR(32) NOT NULL,
    updated_at VARCHAR(32) NOT NULL
  )`);
  if (db.dialect === "mysql") {
    const indexes = await db.all("SHOW INDEX FROM sample_task_video");
    if (!indexes.some((r) => r.Key_name === "idx_task_video"))
      await db.run("CREATE INDEX idx_task_video ON sample_task_video (task_id, opened_at)");
  } else
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_task_video ON sample_task_video (task_id, opened_at)"
    );
}
