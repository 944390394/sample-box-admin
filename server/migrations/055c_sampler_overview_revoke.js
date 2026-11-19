/** #26/截图核对批2：仅本人范围角色（SAMPLER）不应有集团总览入口；收回旧种子误授的 monitor:overview。幂等。 */
export async function up(db) {
  const roles = await db.all("SELECT id FROM sys_role WHERE code = 'SAMPLER'");
  for (const r of roles) {
    await db.run("DELETE FROM sys_role_perm WHERE role_id = ? AND perm = 'monitor:overview'", [
      String(r.id),
    ]);
  }
}
