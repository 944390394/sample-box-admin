/** 序号空洞超过一定时间还没补齐就放弃（设备在线直发的记录断电丢了，补不回来），需要记下空洞出现的时间。 */
export async function up(db) {
  await db.run("ALTER TABLE box_ack ADD COLUMN gap_since VARCHAR(32)");
}
