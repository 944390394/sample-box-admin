/**
 * 离线队列的累计确认：每台设备（按 IMEI）、每个队列代号记一个连续收到的最大序号，
 * 空洞里已经先到的序号另存一张小表，补齐后合并。设计见 docs/offline-queue.md。
 */
export async function up(db) {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS box_ack (imei VARCHAR(32) PRIMARY KEY, qe BIGINT NOT NULL, ack_q BIGINT NOT NULL, updated_at VARCHAR(32) NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS box_ack_gap (imei VARCHAR(32) NOT NULL, qe BIGINT NOT NULL, q BIGINT NOT NULL, PRIMARY KEY(imei,qe,q))`,
  ])
    await db.run(sql);
}
