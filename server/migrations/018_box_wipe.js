/**
 * 删除档案后的设备抹除，以及从板子回传的本机日志。
 * 待抹除按 IMEI 保存，在档案删除后仍然存在；回传的数据跟着箱号走，删除档案时一并清掉。
 */
export async function up(db) {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS box_wipe_pending (imei VARCHAR(32) PRIMARY KEY, box_id VARCHAR(64) NOT NULL, mode VARCHAR(8) NOT NULL, requested_by VARCHAR(64) NOT NULL, requested_at VARCHAR(32) NOT NULL, issued_at VARCHAR(32), issued_seq INTEGER)`,
    `CREATE TABLE IF NOT EXISTS box_dump_request (id VARCHAR(64) PRIMARY KEY, box_id VARCHAR(64) NOT NULL, imei VARCHAR(32) NOT NULL, state VARCHAR(16) NOT NULL, from_sec BIGINT NOT NULL DEFAULT 0, max_count INTEGER NOT NULL DEFAULT 0, total INTEGER, parts INTEGER, created_by VARCHAR(64) NOT NULL, created_at VARCHAR(32) NOT NULL, updated_at VARCHAR(32) NOT NULL, issued_at VARCHAR(32))`,
    `CREATE TABLE IF NOT EXISTS box_dump_record (req_id VARCHAR(64) NOT NULL, part INTEGER NOT NULL, box_id VARCHAR(64) NOT NULL, body TEXT NOT NULL, PRIMARY KEY(req_id,part))`,
  ])
    await db.run(sql);
  if (db.dialect === "mysql") {
    const indexes = await db.all("SHOW INDEX FROM box_dump_request");
    if (!indexes.some((r) => r.Key_name === "idx_dump_box"))
      await db.run("CREATE INDEX idx_dump_box ON box_dump_request (box_id,created_at)");
  } else
    await db.run("CREATE INDEX IF NOT EXISTS idx_dump_box ON box_dump_request (box_id,created_at)");
}
