/**
 * R21 权限颗粒度 P1（任务 #64，用户全选四项）：三组拆码的存量 expand（061 同款模式）。
 *
 * 新码（permCatalog SPLIT_062）：device:box:policyCompanyJudge(9149)、sys:settings:station(9618)；
 * 并集补码：task:create:sample 持有者补 task:create:inspect(9420)——送检建单改严格要 inspect 码
 * （去 create:sample 兜底），存量持有者补并集不丢能力，之后管理员可单独收回送检。
 * 第四项「上报记录菜单门对齐」只改 menus.js gate（some(log/event-*)），不涉及权限行，不在本迁移。
 *
 * 本迁移只做拆分 expand（045/061 模式），不强制补默认码（区别于 056/058 的补码步）：
 * - 角色 sys_role_perm：持 policyCompany / policyDefault / create:sample 的角色补对应新码并集，
 *   新码 grantable 继承产生它的老码（取 max，045:9-19 同款）；老码保留（只补不删），存量不丢能力。
 *   角色页显式收回过的项不会被恢复——expand 只看「现在持有什么」，不读默认值。
 *   ADMIN 短路不落行（resolvePerms 对 ADMIN 全量，045:29 同款）；未持老码的角色/自定义角色不动。
 * - 部门上限 sys_dept_perm 同拆（045:57-69）：否则新码被「角色 ∩ 部门上限」交集裁掉、新码不生效。
 *
 * 备份先于改动：_bak_062_perm_granularity_sys_role_perm / _bak_062_perm_granularity_sys_dept_perm
 * （CREATE TABLE IF NOT EXISTS，重跑不覆盖首次备份，058/060/061 同款）。
 *
 * 幂等：expand 只补缺（先查后插，058:48-59）＋grantable 取 max 后重跑同值；备份 IF NOT EXISTS。
 * 兼容：只动权限行，不碰 sys_dept/sys_role 本体；更老的库没有 sys_role 表时按 045:23-27 先例直接返回
 * （sys_dept_perm 044 建，045 起恒在）。MySQL/SQLite 双方言：仅标准 SELECT/INSERT/UPDATE，无方言分支。
 */
import { SPLIT_062 } from "../src/auth/permCatalog.js";

/** 045/061 expand 同款：老码 → 新码并集，grantable 取 max；SPLIT_062 parts 含老码，故不删任何行。 */
function expand(rows) {
  const have = new Map(rows.map((row) => [row.perm, Number(row.grantable) === 1 ? 1 : 0]));
  for (const [old, parts] of Object.entries(SPLIT_062)) {
    if (!have.has(old)) continue;
    const flag = have.get(old);
    for (const code of parts) have.set(code, Math.max(have.get(code) ?? 0, flag));
  }
  return have;
}

export async function up(db) {
  // 备份先于改动（双表；IF NOT EXISTS 重跑不覆盖首次备份）
  await db.run(
    "CREATE TABLE IF NOT EXISTS _bak_062_perm_granularity_sys_role_perm AS SELECT * FROM sys_role_perm"
  );
  await db.run(
    "CREATE TABLE IF NOT EXISTS _bak_062_perm_granularity_sys_dept_perm AS SELECT * FROM sys_dept_perm"
  );
  let roles;
  try {
    roles = await db.all("SELECT id, code FROM sys_role");
  } catch {
    return;
  }
  for (const role of roles) {
    if (role.code === "ADMIN") continue;
    const id = String(role.id);
    const rows = await db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id = ?", [id]);
    if (!rows.length) continue;
    const before = new Map(
      rows.map((row) => [String(row.perm), Number(row.grantable) === 1 ? 1 : 0])
    );
    const next = expand(rows.map((row) => ({ perm: String(row.perm), grantable: row.grantable })));
    for (const [perm, flag] of next) {
      if (!before.has(perm))
        await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES (?, ?, ?)", [
          id,
          perm,
          flag,
        ]);
      else if (before.get(perm) !== flag)
        await db.run("UPDATE sys_role_perm SET grantable = ? WHERE role_id = ? AND perm = ?", [
          flag,
          id,
          perm,
        ]);
    }
  }
  // 部门上限同拆：只补缺行（sys_dept_perm 无 grantable 列）
  const depts = await db.all("SELECT DISTINCT dept_id FROM sys_dept_perm");
  for (const { dept_id: deptId } of depts) {
    const rows = await db.all("SELECT perm FROM sys_dept_perm WHERE dept_id = ?", [deptId]);
    const before = new Set(rows.map((row) => String(row.perm)));
    const next = expand(rows.map((row) => ({ perm: String(row.perm), grantable: 0 })));
    for (const perm of next.keys())
      if (!before.has(perm))
        await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES (?, ?)", [deptId, perm]);
  }
}
