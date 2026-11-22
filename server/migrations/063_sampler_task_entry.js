/**
 * R23 现场采样员最小任务入口（任务 #66，D5 已拍板＝给最小入口）：存量 SAMPLER 角色补码。
 *
 * 补码集（permCatalog SAMPLER_ENTRY_063）：device:box:task(9104 读)＋task:sample-start(9425)＋task:seal(9426)。
 * 数据范围仍仅本人保管（scope4 不变，本迁移不碰 sys_role.data_scope）。新库由 LEGACY_DEFAULTS.SAMPLER
 * 经 upgradeCodes/seedRolePerms 覆盖；存量库在这里只补不删（056②b/057 补码步模式）。
 * 工作台卡片随读码同补：cardsFor(现有∪补码) 给出 device:box:task 隐含的 monitor:card:*（sampling/myTasks/feed 等），
 * 保证存量 SAMPLER 的工作台「我的采样待办/我经手的任务/最近动态」与新库同口径；只补缺失卡片码。
 *
 * 沿 062 模式：
 * - 备份先于改动：_bak_063_sampler_entry_sys_role_perm / _bak_063_sampler_entry_sys_dept_perm
 *   （CREATE TABLE IF NOT EXISTS，重跑不覆盖首次备份，058/060/061/062 同款）。
 * - ADMIN 短路不落行（resolvePerms 对 ADMIN 全量，045:29/062 同款）；只动 code='SAMPLER' 的角色，
 *   自定义角色/其他角色不动（角色页保存过的以保存为准：只插缺失行，不改已有行、不删行）。
 * - grantable 按 grantsAll（有 sys:role:grant/sys:user:role 的角色全可转授，056②b/seedRolePerms 一致）；
 *   SAMPLER 无这两码 → 0。
 * - 部门上限 sys_dept_perm 同补（062 同拆防交集裁掉）：开了「单独限制」且上限含 device:box:list
 *   （SAMPLER 基线读码）的部门，补同一补码集＋卡片码，否则新码被「角色 ∩ 部门上限」交集裁掉、入口不生效。
 *   只插缺失行（sys_dept_perm 无 grantable 列）；上限是上界不是授权，未持码的角色仍得不到。
 *
 * 幂等：只补缺（先查后插）＋备份 IF NOT EXISTS；重跑结果不变（单测覆盖）。
 * 兼容：只动权限行，不碰 sys_dept/sys_role 本体；更老的库没有 sys_role 表时按 045:23-27/062 先例直接返回。
 * MySQL/SQLite 双方言：仅标准 SELECT/INSERT，无方言分支。
 */
import { SAMPLER_ENTRY_063, cardsFor, grantsAll } from "../src/auth/permCatalog.js";

/** 角色补码集＝三码＋读码隐含的工作台卡片码（cardsFor 只回缺失项）。 */
function entryCodes(current) {
  const have = new Set(current);
  const next = new Set(current);
  for (const code of SAMPLER_ENTRY_063) next.add(code);
  for (const code of cardsFor([...next])) next.add(code);
  return [...next].filter((code) => !have.has(code));
}

export async function up(db) {
  // 备份先于改动（双表；IF NOT EXISTS 重跑不覆盖首次备份）
  await db.run(
    "CREATE TABLE IF NOT EXISTS _bak_063_sampler_entry_sys_role_perm AS SELECT * FROM sys_role_perm"
  );
  await db.run(
    "CREATE TABLE IF NOT EXISTS _bak_063_sampler_entry_sys_dept_perm AS SELECT * FROM sys_dept_perm"
  );
  let roles;
  try {
    roles = await db.all("SELECT id, code FROM sys_role");
  } catch {
    return;
  }
  for (const role of roles) {
    if (role.code === "ADMIN") continue;
    if (role.code !== "SAMPLER") continue;
    const id = String(role.id);
    const rows = await db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id = ?", [id]);
    const current = rows.map((row) => String(row.perm));
    const add = entryCodes(current);
    if (!add.length) continue;
    const flag = grantsAll([...current, ...add]) ? 1 : 0;
    for (const perm of add) {
      const exists = await db.get(
        "SELECT 1 AS x FROM sys_role_perm WHERE role_id = ? AND perm = ?",
        [id, perm]
      );
      if (exists) continue;
      await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES (?, ?, ?)", [
        id,
        perm,
        flag,
      ]);
    }
  }
  // 部门上限同补：开了单独限制且含 SAMPLER 基线读码的部门，补同一集合（防交集裁掉）
  const depts = await db.all("SELECT DISTINCT dept_id FROM sys_dept_perm");
  for (const { dept_id: deptId } of depts) {
    const rows = await db.all("SELECT perm FROM sys_dept_perm WHERE dept_id = ?", [deptId]);
    const current = rows.map((row) => String(row.perm));
    if (!current.includes("device:box:list")) continue;
    const add = entryCodes(current);
    for (const perm of add) {
      const exists = await db.get(
        "SELECT 1 AS x FROM sys_dept_perm WHERE dept_id = ? AND perm = ?",
        [deptId, perm]
      );
      if (exists) continue;
      await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES (?, ?)", [deptId, perm]);
    }
  }
}
