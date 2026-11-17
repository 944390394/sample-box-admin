/** 上报策略与任务分开存储；结束任务只解除覆盖，不回写旧的设备配置。 */
export async function up(db) {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS box_report_policy (box_id VARCHAR(64) PRIMARY KEY, single_json TEXT, batch_json TEXT)`,
    `CREATE TABLE IF NOT EXISTS box_report_delivery (box_id VARCHAR(64) PRIMARY KEY, version VARCHAR(32) NOT NULL, sent_at VARCHAR(32), confirmed_at VARCHAR(32))`,
    `CREATE TABLE IF NOT EXISTS sample_task (id VARCHAR(64) PRIMARY KEY, name VARCHAR(120) NOT NULL, kind VARCHAR(16) NOT NULL, status VARCHAR(16) NOT NULL, body TEXT NOT NULL, created_at VARCHAR(32) NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sample_task_box (task_id VARCHAR(64) NOT NULL, box_id VARCHAR(64) NOT NULL, PRIMARY KEY(task_id,box_id))`,
    `CREATE TABLE IF NOT EXISTS box_active_task (box_id VARCHAR(64) PRIMARY KEY, task_id VARCHAR(64) NOT NULL)`,
  ])
    await db.run(sql);
}
