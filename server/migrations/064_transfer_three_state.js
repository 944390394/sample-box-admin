/**
 * R25 划拨三态（任务 #71，用户拍板「照预览实施」）：历史状态映射＋接受码存量补码。
 *
 * 两件事，都幂等（重跑结果不变，单测覆盖）：
 * 1. 历史两态单映射：kind=划拨 且 status=已划拨 → 已完成（R25 接受时转移语义对齐）。
 *    接受人/接受时间不伪造——历史单没有接受动作，body 打 legacyTransfer=true 标，
 *    列表/详情据此显「历史已划拨」tag＋接受人「—」。已撤销只读保留（不动）。
 *    逐行读 body→JSON 加标→写回（不用 json_set，MySQL/SQLite 双方言仅标准 SELECT/UPDATE）。
 * 2. 新码 task:transfer:accept（permCatalog TRANSFER_ACCEPT_064，9427）补 BRANCH_ADMIN：
 *    模板（LEGACY_DEFAULTS.BRANCH_ADMIN）＋存量角色（本迁移，063 同款只补不删）。
 *    接受是目标分公司管理员动作；创建/取消/补单号/拒收不另设码（创建沿用 create:transfer，
 *    取消/补单号按创建方身份门，拒收沿用 task:reject）。
 *
 * 沿 062/063 模式：
 * - 备份先于改动：_bak_064_transfer_three_state_sample_task / _sys_role_perm / _sys_dept_perm
 *   （CREATE TABLE IF NOT EXISTS，重跑不覆盖首次备份，058/060/061/062/063 同款）。
 * - ADMIN 短路不落行（resolvePerms 对 ADMIN 全量，045:29/062/063 同款）；只动 code='BRANCH_ADMIN'
 *   的角色，自定义角色/其他角色不动（角色页保存过的以保存为准：只插缺失行，不改已有行、不删行）。
 * - grantable 按 grantsAll（有 sys:role:grant/sys:user:role 的角色全可转授，056②b/063 一致）；
 *   BRANCH_ADMIN 持 sys:user:role → 1。
 * - 部门上限 sys_dept_perm 同补（062/063 同拆防交集裁掉）：开了「单独限制」且上限含
 *   device:box:list（BRANCH_ADMIN 基线读码）的部门补接受码，否则新码被「角色 ∩ 部门上限」交集裁掉。
 *   只插缺失行（sys_dept_perm 无 grantable 列）；上限是上界不是授权，未持码的角色仍得不到。
 *
 * 兼容：只动 sample_task 划拨行与权限行，不碰 sys_dept/sys_role 本体；更老的库没有 sys_role 表时
 * 按 045:23-27/062/063 先例直接返回（sample_task 映射步仍跑——它不依赖 sys_role）。
 */
import { TRANSFER_ACCEPT_064, grantsAll } from "../src/auth/permCatalog.js";
import { migrateStatus } from "../../shared/taskFlow.js";

export async function up(db) {
  // 备份先于改动（三表；IF NOT EXISTS 重跑不覆盖首次备份）
  await db.run(
    "CREATE TABLE IF NOT EXISTS _bak_064_transfer_three_state_sample_task AS SELECT * FROM sample_task"
  );
  await db.run(
    "CREATE TABLE IF NOT EXISTS _bak_064_transfer_three_state_sys_role_perm AS SELECT * FROM sys_role_perm"
  );
  await db.run(
    "CREATE TABLE IF NOT EXISTS _bak_064_transfer_three_state_sys_dept_perm AS SELECT * FROM sys_dept_perm"
  );

  // 1. 历史已划拨→已完成（接受人不伪造，打 legacyTransfer 标）。映射外同名（migrateStatus 划拨组）。
  const legacy = await db.all(
    "SELECT id, body FROM sample_task WHERE kind='划拨' AND status='已划拨'"
  );
  for (const row of legacy) {
    let body;
    try {
      body = row.body ? JSON.parse(row.body) : {};
    } catch {
      body = {};
    }
    body.legacyTransfer = true;
    await db.run(
      "UPDATE sample_task SET status=?, body=? WHERE id=? AND kind='划拨' AND status='已划拨'",
      [migrateStatus("划拨", "已划拨"), JSON.stringify(body), row.id]
    );
  }

  // 2. BRANCH_ADMIN 存量补接受码（063 同款）
  let roles;
  try {
    roles = await db.all("SELECT id, code FROM sys_role");
  } catch {
    return;
  }
  for (const role of roles) {
    if (role.code === "ADMIN") continue;
    if (role.code !== "BRANCH_ADMIN") continue;
    const id = String(role.id);
    const rows = await db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id = ?", [id]);
    const current = rows.map((row) => String(row.perm));
    const add = TRANSFER_ACCEPT_064.filter((code) => !current.includes(code));
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
  // 部门上限同补：开了单独限制且含 BRANCH_ADMIN 基线读码的部门，补接受码（防交集裁掉）
  const depts = await db.all("SELECT DISTINCT dept_id FROM sys_dept_perm");
  for (const { dept_id: deptId } of depts) {
    const rows = await db.all("SELECT perm FROM sys_dept_perm WHERE dept_id = ?", [deptId]);
    const current = rows.map((row) => String(row.perm));
    if (!current.includes("device:box:list")) continue;
    for (const perm of TRANSFER_ACCEPT_064) {
      if (current.includes(perm)) continue;
      const exists = await db.get(
        "SELECT 1 AS x FROM sys_dept_perm WHERE dept_id = ? AND perm = ?",
        [deptId, perm]
      );
      if (exists) continue;
      await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES (?, ?)", [deptId, perm]);
    }
  }
}
