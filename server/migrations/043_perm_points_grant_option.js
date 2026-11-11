import { grantsAll, split043 } from "../src/auth/permCatalog.js";

/**
 * 按钮级权限 + 可转授：
 * 1. 合在一起的老码拆开（部门增删改、人员增改停删、账号安全五个动作、角色增改删），已有角色按原来的码补齐，谁能做什么不变；
 * 2. sys_role_perm 加 grantable 列（类似 WITH GRANT OPTION）：开了的才能转授给别人。
 *    有「给角色分配权限」或「给人员分配角色」的角色，自己的权限全部可转授——和以前「能授自己有的权限」一样。
 */
export async function up(db) {
  let columns;
  try {
    columns =
      db.dialect === "mysql"
        ? await db.all("SHOW COLUMNS FROM sys_role_perm")
        : await db.all("PRAGMA table_info(sys_role_perm)");
  } catch {
    return;
  }
  if (!columns.some((r) => (r.Field || r.name) === "grantable")) {
    await db.run("ALTER TABLE sys_role_perm ADD COLUMN grantable INTEGER NOT NULL DEFAULT 0");
  }
  const roles = await db.all("SELECT id, code FROM sys_role");
  for (const role of roles) {
    if (role.code === "ADMIN") continue;
    const id = String(role.id);
    const rows = await db.all("SELECT perm FROM sys_role_perm WHERE role_id = ?", [id]);
    const { add, remove } = split043(rows.map((row) => String(row.perm)));
    for (const perm of add)
      await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES (?, ?, 0)", [
        id,
        perm,
      ]);
    for (const perm of remove)
      await db.run("DELETE FROM sys_role_perm WHERE role_id = ? AND perm = ?", [id, perm]);
    const after = (await db.all("SELECT perm FROM sys_role_perm WHERE role_id = ?", [id])).map(
      (row) => String(row.perm)
    );
    if (grantsAll(after))
      await db.run("UPDATE sys_role_perm SET grantable = 1 WHERE role_id = ?", [id]);
  }
}
