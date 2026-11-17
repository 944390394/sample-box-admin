import { splitPerms } from "../src/auth/permCatalog.js";

/**
 * 权限拆分：「历史轨迹」从「位置」里拆出来，「给角色分配权限」从「编辑角色」里拆出来，
 * 「给人员分配角色」从「编辑人员」里拆出来。已有角色按原来的码补上新码，升级后谁能做什么不变；
 * 之后在角色页上可以单独收回。还没有授权行的角色不动，启动时 seedRolePerms 按新的默认值写入。
 */
export async function up(db) {
  let roles;
  try {
    roles = await db.all("SELECT id, code FROM sys_role");
  } catch {
    return;
  }
  for (const role of roles) {
    if (role.code === "ADMIN") continue;
    let rows;
    try {
      rows = await db.all("SELECT perm FROM sys_role_perm WHERE role_id = ?", [String(role.id)]);
    } catch {
      return;
    }
    for (const perm of splitPerms(rows.map((row) => String(row.perm)))) {
      await db.run("INSERT INTO sys_role_perm (role_id, perm) VALUES (?, ?)", [
        String(role.id),
        perm,
      ]);
    }
  }
}
