/**
 * 已安装的库补上「视角切换」角色，并授给系统管理员。
 * 空库留给安装种子写入，避免和种子里的同一条角色冲突。
 */

async function freeRoleId(db) {
  const rows = await db.all("SELECT id FROM sys_role");
  const used = new Set(rows.map((row) => String(row.id)));
  let next = 16;
  while (used.has(String(next))) next += 1;
  return String(next);
}

export async function up(db) {
  const users = await db.get("SELECT COUNT(*) AS total FROM sys_user");
  if (Number(users?.total || 0) === 0) return;

  let role = await db.get("SELECT id FROM sys_role WHERE code = ?", ["HOME_SWITCH"]);
  if (!role) {
    const id = await freeRoleId(db);
    await db.run(
      `INSERT INTO sys_role (id, name, code, data_scope, sort, status, create_time, update_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, "视角切换", "HOME_SWITCH", 1, 10, 1, "2026-10-07 14:00:00", null]
    );
    role = { id };
  }

  const admin = await db.get("SELECT id FROM sys_user WHERE username = ?", ["admin"]);
  if (!admin) return;
  const link = await db.get("SELECT user_id FROM sys_user_role WHERE user_id = ? AND role_id = ?", [
    String(admin.id),
    String(role.id),
  ]);
  if (link) return;
  await db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", [
    String(admin.id),
    String(role.id),
  ]);
}
