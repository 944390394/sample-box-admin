/**
 * R27 自部门基本信息编辑（任务 #89，用户拍板「管理角色自部门基本信息编辑，结构归总部」）：
 * 存量两角色补 sys:dept:update。
 *
 * 根因：BRANCH_ADMIN 预设缺 sys:dept:update——分公司管理员改不了本单位名称/地址/联系人/电话/排序。
 * 补「编辑部门基本信息」一码后，org-api updateDept 字段级守卫（同批）放行基本资料、把类型/上级/
 * 启停/编码挡给总部 ADMIN（结构归总部）。服务端守卫口径正确不改；补码只解决「持码」前提。
 *
 * 补码集（permCatalog DEPT_SELF_EDIT_066）：sys:dept:update(9511)。只补缺失项——已有 update 的
 * 角色不动。角色按 code 命中：BRANCH_ADMIN（代码预设）＋ STATION_ADMIN（生产 DB-only 自定义角色，
 * 代码模板无）；角色不存在跳过（不建角色），其他角色/自定义角色不动。STATION_STAFF 不在本批
 * （采样员/站点员工不自编辑部门，区别于 065 的三角色口径）。
 * 新库由 DEFAULT_ROLE_PERMS.BRANCH_ADMIN 升级链后置追加覆盖（permCatalog #89 注释，绕 SPLIT_045/061
 * 连带拆码）；存量库在这里只补不删（056②b/057/063/064/065 补码步模式）。
 *
 * 沿 065 模式：
 * - 备份先于改动：_bak_066_sys_role_perm / _bak_066_sys_dept_perm
 *   （CREATE TABLE IF NOT EXISTS，重跑不覆盖首次备份，058/060/061/062/063/065 同款）。
 * - ADMIN 短路不落行（resolvePerms 对 ADMIN 全量，045:29/062/063/065 同款）。
 * - grantable 沿该角色现有行的 max（062 expand/065 取 max 同款口径；无任何授权行时 0）——
 *   已有转授能力的角色补码随即可转授，全 0 的角色不借补码扩转授面。只插缺失行，不改已有行、不删行
 *   （角色页保存过的以保存为准）。
 * - 部门上限 sys_dept_perm 同补（062 同拆/063/065 同补防交集裁掉）：开了「单独限制」且上限含
 *   sys:dept:view 的受限部门，补 sys:dept:update，否则新码被「角色 ∩ 部门上限」交集裁掉、补码不生效
 *   （view 是 update 的前置码，item 9511 needs）。只插缺失行（sys_dept_perm 无 grantable 列）；
 *   上限是上界不是授权，未持码的角色仍得不到。不含 view 的部门上限不动。
 *
 * 幂等：只补缺（先查后插）＋备份 IF NOT EXISTS；重跑结果不变（单测覆盖）。
 * 兼容：只动权限行，不碰 sys_dept/sys_role 本体；更老的库没有 sys_role 表时按 045:23-27/062/063/065
 * 先例直接返回。MySQL/SQLite 双方言：仅标准 SELECT/INSERT，无方言分支。
 */
import { DEPT_SELF_EDIT_066 } from "../src/auth/permCatalog.js";

/** 两角色（按 code 命中；STATION_ADMIN 为生产 DB-only 自定义角色，代码模板无）。 */
const TARGET_ROLES = new Set(["BRANCH_ADMIN", "STATION_ADMIN"]);
/** 受限部门上限的命中码：含 sys:dept:view（update 的前置）即同补 update（防交集裁掉）。 */
const CAP_HIT_CODE = "sys:dept:view";

export async function up(db) {
  // 备份先于改动（双表；IF NOT EXISTS 重跑不覆盖首次备份）
  await db.run("CREATE TABLE IF NOT EXISTS _bak_066_sys_role_perm AS SELECT * FROM sys_role_perm");
  await db.run("CREATE TABLE IF NOT EXISTS _bak_066_sys_dept_perm AS SELECT * FROM sys_dept_perm");
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
    const add = DEPT_SELF_EDIT_066.filter((code) => !have.has(code));
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
  // 部门上限同补：含 sys:dept:view 的受限部门补 update（防交集裁掉）
  const depts = await db.all("SELECT DISTINCT dept_id FROM sys_dept_perm");
  for (const { dept_id: deptId } of depts) {
    const rows = await db.all("SELECT perm FROM sys_dept_perm WHERE dept_id = ?", [deptId]);
    const have = new Set(rows.map((row) => String(row.perm)));
    if (!have.has(CAP_HIT_CODE)) continue;
    for (const perm of DEPT_SELF_EDIT_066) {
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
