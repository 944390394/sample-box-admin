/**
 * 部门权限上限（参考云平台的服务控制策略、权限边界）：
 * - sys_dept_perm：部门自己勾的上限；
 * - sys_dept.perm_limited：0 跟上级一样，1 按 sys_dept_perm 封顶；
 * - sys_dept.max_data_scope：最大数据范围 1–4，空 = 跟上级。
 * 实际权限 = 角色权限之和 ∩ 从顶级到所在部门每一级的上限。现有部门全部「跟上级一样」，升级后不变。
 */
export async function up(db) {
  await db.run(
    "CREATE TABLE IF NOT EXISTS sys_dept_perm (dept_id VARCHAR(64) NOT NULL, perm VARCHAR(64) NOT NULL, PRIMARY KEY (dept_id, perm))"
  );
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sys_dept")
      : await db.all("PRAGMA table_info(sys_dept)");
  const names = new Set(columns.map((r) => r.Field || r.name));
  if (!names.has("perm_limited"))
    await db.run("ALTER TABLE sys_dept ADD COLUMN perm_limited INTEGER NOT NULL DEFAULT 0");
  if (!names.has("max_data_scope"))
    await db.run("ALTER TABLE sys_dept ADD COLUMN max_data_scope INTEGER");
}
