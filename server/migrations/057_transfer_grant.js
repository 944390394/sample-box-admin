/**
 * R12 门禁裁决补码：调拨单仅划拨权限者可见（some(task:create:transfer, task:transfer:revoke)）。
 * 分公司管理员是划拨主责角色、调度员可撤自己建的单——默认模板此前缺码导致反而不可见。
 * 存量库幂等补码（角色页保存过的以保存为准：只插缺失行，不改动已有行）；新库由模板覆盖。
 * 公司级策略中心迁移顺延 058。
 */
export async function up(db) {
  const roles = await db.all(
    "SELECT id, code FROM sys_role WHERE code IN ('BRANCH_ADMIN', 'DISPATCH')"
  );
  const grants = {
    BRANCH_ADMIN: ["task:create:transfer", "task:transfer:revoke"],
    DISPATCH: ["task:transfer:revoke"],
  };
  for (const role of roles) {
    for (const perm of grants[role.code] || []) {
      const exists = await db.get(
        "SELECT 1 AS x FROM sys_role_perm WHERE role_id = ? AND perm = ?",
        [String(role.id), perm]
      );
      if (exists) continue;
      await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES (?, ?, 1)", [
        String(role.id),
        perm,
      ]);
    }
  }
}
