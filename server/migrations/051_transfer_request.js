/** 划拨提交幂等表：client_token 防重复提交，task_id 反查。不做滚动清理（公司级批量操作，量级小）。 */
export async function up(db) {
  await db.run(
    `CREATE TABLE IF NOT EXISTS transfer_request (
      client_token VARCHAR(64) PRIMARY KEY,
      task_id VARCHAR(64) NOT NULL,
      created_at VARCHAR(32) NOT NULL
    )`
  );
  if (db.dialect === "mysql") {
    const indexes = await db.all("SHOW INDEX FROM transfer_request");
    if (!indexes.some((r) => r.Key_name === "idx_transfer_request_task"))
      await db.run("CREATE INDEX idx_transfer_request_task ON transfer_request (task_id)");
  } else
    await db.run(
      "CREATE INDEX IF NOT EXISTS idx_transfer_request_task ON transfer_request (task_id)"
    );
}
