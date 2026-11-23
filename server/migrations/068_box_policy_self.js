/**
 * R28 分公司自箱上报策略（任务 #95，用户拍板「分公司管理员应该可以设置自己公司下的采样箱」）：
 * 存量两角色补 policyWrite＋policyBatch。
 *
 * 根因：BRANCH_ADMIN 预设缺 device:box:policyWrite/policyBatch——分公司管理员在采样箱详情上报策略
 * 弹框控件全 disabled、列表批量入口不显示（缺写码）。补「设置单箱上报策略」＋「批量设置上报策略」两码后，
 * 服务端 ReportPolicyController single/batch 入口的范围守卫（同批）把非 ADMIN 限在本公司子树（manageOrgIds），
 * 批量任一越权整单拒——补码只解决「持码」前提，守卫保证不越权改他司箱。
 *
 * 补码集（permCatalog BOX_POLICY_SELF_068）：device:box:policyWrite(9115)＋device:box:policyBatch(9116)。
 * 只补缺失项——已有其中之一的角色只补另一个。角色按 code 命中：BRANCH_ADMIN（代码预设）＋
 * STATION_ADMIN（生产 DB-only 自定义角色，代码模板无）；角色不存在跳过（不建角色），其他角色/自定义角色不动。
 * STATION_STAFF 不在本批（站点员工不自设上报策略，区别于 065 的三角色口径）。
 * 新库由 DEFAULT_ROLE_PERMS.BRANCH_ADMIN 升级链后置追加覆盖（permCatalog #95 注释，065/066 同款）；
 * 存量库在这里只补不删（056②b/057/063/064/065/066 补码步模式）。
 *
 * 沿 066 模式：
 * - 备份先于改动：_bak_068_sys_role_perm / _bak_068_sys_dept_perm
 *   （CREATE TABLE IF NOT EXISTS，重跑不覆盖首次备份，058/060/061/062/063/065/066 同款）。
 * - ADMIN 短路不落行（resolvePerms 对 ADMIN 全量，045:29/062/063/065/066 同款）。
 * - grantable 沿该角色现有行的 max（062 expand/065/066 取 max 同款口径；无任何授权行时 0）——
 *   已有转授能力的角色补码随即可转授，全 0 的角色不借补码扩转授面。只插缺失行，不改已有行、不删行
 *   （角色页保存过的以保存为准）。
 * - 部门上限 sys_dept_perm 同补（062 同拆/063/065/066 同补防交集裁掉）：开了「单独限制」且上限含
 *   device:box:policyRead 的受限部门，补 policyWrite＋policyBatch，否则新码被「角色 ∩ 部门上限」交集裁掉、
 *   补码不生效（policyRead 是两写码的前置码，item 9115/9116 needs）。只插缺失行（sys_dept_perm 无 grantable 列）；
 *   上限是上界不是授权，未持码的角色仍得不到。不含 policyRead 的部门上限不动。
 *
 * 幂等：只补缺（先查后插）＋备份 IF NOT EXISTS；重跑结果不变（单测覆盖）。
 * 兼容：只动权限行，不碰 sys_dept/sys_role 本体；更老的库没有 sys_role 表时按 045:23-27/062/063/065/066
 * 先例直接返回。MySQL/SQLite 双方言：仅标准 SELECT/INSERT，无方言分支。
 */
import { BOX_POLICY_SELF_068 } from "../src/auth/permCatalog.js";

/** 两角色（按 code 命中；STATION_ADMIN 为生产 DB-only 自定义角色，代码模板无）。 */
const TARGET_ROLES = new Set(["BRANCH_ADMIN", "STATION_ADMIN"]);
/** 受限部门上限的命中码：含 device:box:policyRead（两写码的前置）即同补（防交集裁掉）。 */
const CAP_HIT_CODE = "device:box:policyRead";

export async function up(db) {
  // 备份先于改动（双表；IF NOT EXISTS 重跑不覆盖首次备份）
  await db.run("CREATE TABLE IF NOT EXISTS _bak_068_sys_role_perm AS SELECT * FROM sys_role_perm");
  await db.run("CREATE TABLE IF NOT EXISTS _bak_068_sys_dept_perm AS SELECT * FROM sys_dept_perm");
  let roles;
  try {
    roles = await db.all("SELECT id, code FROM sys_role");
  } catch {
    return;
  }
  for (const role of roles) {
    if (role.code === "ADMIN") continue;
    if (!TARGET_ROLES.has(role.code)) continue;
    const id = String(role.id);
    const rows = await db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id = ?", [id]);
    const have = new Set(rows.map((row) => String(row.perm)));
    const add = BOX_POLICY_SELF_068.filter((code) => !have.has(code));
    if (!add.length) continue;
    // grantable 沿该角色现有 max（无授权行时 0）
    const flag = rows.some((row) => Number(row.grantable) === 1) ? 1 : 0;
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
  // 部门上限同补：含 policyRead 的受限部门补 policyWrite＋policyBatch（防交集裁掉）
  const depts = await db.all("SELECT DISTINCT dept_id FROM sys_dept_perm");
  for (const { dept_id: deptId } of depts) {
    const rows = await db.all("SELECT perm FROM sys_dept_perm WHERE dept_id = ?", [deptId]);
    const have = new Set(rows.map((row) => String(row.perm)));
    if (!have.has(CAP_HIT_CODE)) continue;
    for (const perm of BOX_POLICY_SELF_068) {
      if (have.has(perm)) continue;
      const exists = await db.get(
        "SELECT 1 AS x FROM sys_dept_perm WHERE dept_id = ? AND perm = ?",
        [deptId, perm]
      );
      if (exists) continue;
      await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES (?, ?)", [deptId, perm]);
    }
  }
}
