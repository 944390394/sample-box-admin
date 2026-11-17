/**
 * 离线队列放弃等待的序号：空洞超时后确认号越过去，但这些序号之后真补上来时照样入库一次，不当成重复。
 */
export async function up(db) {
  await db.run(
    "CREATE TABLE IF NOT EXISTS box_ack_lost (imei VARCHAR(32) NOT NULL, qe BIGINT NOT NULL, q BIGINT NOT NULL, lost_at VARCHAR(32) NOT NULL, PRIMARY KEY(imei,qe,q))"
  );
}
