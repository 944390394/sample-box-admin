/** 部门负责人：系统里的一个用户。调拨单选接收单位时默认由他签收。 */
export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sys_dept")
      : await db.all("PRAGMA table_info(sys_dept)");
  if (!columns.some((r) => (r.Field || r.name) === "leader_user_id"))
    await db.run("ALTER TABLE sys_dept ADD COLUMN leader_user_id VARCHAR(32)");
}
