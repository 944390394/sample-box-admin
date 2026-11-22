/**
 * R26 上报记录角色可见性（任务 #85，用户拍板「三角色补码」）：存量三角色补 log＋logExport。
 *
 * 根因（诊断已核）：BRANCH_ADMIN 预设缺 device:box:log，SampleController #logPerm 只放行
 * 持码事件类（pad/shut/boot/chg）——只有定时报文的箱子（如 采样箱_00000002）概览 0/空态。
 * 服务端 #logPerm 口径正确不改；补码后持 log 角色默认查全部可见种类（web 侧同批）。
 *
 * 补码集（permCatalog UPLINK_LOG_GRANT_065）：device:box:log(9103)＋device:box:logExport(9120)。
 * 导出是读的延伸，随读同补（055 口径）；只补缺失项——已有 log 缺 logExport 的角色只补导出。
 * 角色按 code 命中：BRANCH_ADMIN（代码预设）＋ STATION_ADMIN/STATION_STAFF（生产 DB-only
 * 自定义角色，代码模板无）；角色不存在跳过（不建角色），其他角色/自定义角色不动。
 * 新库由 DEFAULT_ROLE_PERMS.BRANCH_ADMIN 后置追加覆盖（permCatalog #85 注释）；
 * 存量库在这里只补不删（056②b/057/063/064 补码步模式）。
 *
 * 沿 062/063 模式：
 * - 备份先于改动：_bak_065_sys_role_perm / _bak_065_sys_dept_perm
 *   （CREATE TABLE IF NOT EXISTS，重跑不覆盖首次备份，058/060/061/062/063 同款）。
 * - ADMIN 短路不落行（resolvePerms 对 ADMIN 全量，045:29/062/063 同款）。
 * - grantable 沿该角色现有行的 max（062 expand 取 max 同款口径；无任何授权行时 0）——
 *   区别于 063 的 grantsAll：本批派单明确「沿现有 max」，已有转授能力的角色补码随即可转授，
 *   全 0 的角色不借补码扩转授面。只插缺失行，不改已有行、不删行（角色页保存过的以保存为准）。
 * - 部门上限 sys_dept_perm 同补（062 同拆/063 同补防交集裁掉）：开了「单独限制」且上限含
 *   事件类码（device:box:event-lid/event-boot/event-charge 任一）的受限部门，补 log＋logExport，
 *   否则新码被「角色 ∩ 部门上限」交集裁掉、补码不生效。只插缺失行（sys_dept_perm 无 grantable 列）；
 *   上限是上界不是授权，未持码的角色仍得不到。不含事件类码的部门上限不动。
 *
 * 幂等：只补缺（先查后插）＋备份 IF NOT EXISTS；重跑结果不变（单测覆盖）。
 * 兼容：只动权限行，不碰 sys_dept/sys_role 本体；更老的库没有 sys_role 表时按 045:23-27/062/063
 * 先例直接返回。MySQL/SQLite 双方言：仅标准 SELECT/INSERT，无方言分支。
 */
import { UPLINK_LOG_GRANT_065 } from "../src/auth/permCatalog.js";

/** 三角色（按 code 命中；STATION_* 为生产 DB-only 自定义角色，代码模板无）。 */
const TARGET_ROLES = new Set(["BRANCH_ADMIN", "STATION_ADMIN", "STATION_STAFF"]);
/** 受限部门上限的命中码：含任一事件类码即同补（事件-only 角色的部门上限形态）。 */
const EVENT_CAP_CODES = [
  "device:box:event-lid",
  "device:box:event-boot",
  "device:box:event-charge",
];

export async function up(db) {
  // 备份先于改动（双表；IF NOT EXISTS 重跑不覆盖首次备份）
  await db.run("CREATE TABLE IF NOT EXISTS _bak_065_sys_role_perm AS SELECT * FROM sys_role_perm");
  await db.run("CREATE TABLE IF NOT EXISTS _bak_065_sys_dept_perm AS SELECT * FROM sys_dept_perm");
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
    const add = UPLINK_LOG_GRANT_065.filter((code) => !have.has(code));
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
  // 部门上限同补：含事件类码的受限部门补 log＋logExport（防交集裁掉）
  const depts = await db.all("SELECT DISTINCT dept_id FROM sys_dept_perm");
  for (const { dept_id: deptId } of depts) {
    const rows = await db.all("SELECT perm FROM sys_dept_perm WHERE dept_id = ?", [deptId]);
    const have = new Set(rows.map((row) => String(row.perm)));
    if (!EVENT_CAP_CODES.some((code) => have.has(code))) continue;
    for (const perm of UPLINK_LOG_GRANT_065) {
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
