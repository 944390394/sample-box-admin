/** 新权限点补授权：原持 task:create:transfer 的角色自动获得 task:transfer:revoke 与 task:create:inspect（同一动作正反两面，拆开会让老角色点不到撤销/送检）。幂等：先查存在。 */
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
    const has = new Set(rows.map((r) => String(r.perm)));
    if (!has.has("task:create:transfer")) continue;
    for (const perm of ["task:transfer:revoke", "task:create:inspect"]) {
      if (has.has(perm)) continue;
      await db.run("INSERT INTO sys_role_perm (role_id, perm) VALUES (?, ?)", [
        String(role.id),
        perm,
      ]);
      has.add(perm);
    }
  }
}
