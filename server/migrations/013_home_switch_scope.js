/**
 * 视角切换角色只发界面权限。数据范围按并集算，它原来是「全部数据」，授给谁谁就能看全公司的箱子。
 */
export async function up(db) {
  await db.run("UPDATE sys_role SET data_scope = 4 WHERE code = 'HOME_SWITCH' AND data_scope = 1");
}
