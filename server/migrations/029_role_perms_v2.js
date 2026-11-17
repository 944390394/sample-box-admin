import { upgradeRolePerms } from "../src/auth/permCatalog.js";

/**
 * 权限细化：给已经保存过授权的角色补上新权限码（任务、组织、系统、改名）。
 * 还没有授权行的角色不动，启动时 seedRolePerms 会按新的默认值写入。
 */
export async function up(db) {
  let roles;
  try {
    roles = await db.all("SELECT id, code FROM sys_role");
  } catch {
    return;
  }
  for (const role of roles) {
    let rows;
    try {
      rows = await db.all("SELECT perm FROM sys_role_perm WHERE role_id = ?", [String(role.id)]);
    } catch {
      return;
    }
    if (!rows.length || role.code === "ADMIN") continue;
    for (const perm of upgradeRolePerms(
      role.code,
      rows.map((row) => String(row.perm))
    )) {
      await db.run("INSERT INTO sys_role_perm (role_id, perm) VALUES (?, ?)", [
        String(role.id),
        perm,
      ]);
    }
  }
}
