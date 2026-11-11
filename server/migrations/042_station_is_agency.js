/** 采样机构就是检测站：上一版单独加的「检测站」类型并回「采样机构」。 */
export async function up(db) {
  await db.run("UPDATE sys_dept SET type = '采样机构' WHERE type = '检测站'");
}
