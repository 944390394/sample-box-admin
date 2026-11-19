/**
 * #26 B1：GRANT_055 补码 + 自定义数据范围落地。幂等（先查存在再补）：
 * - 持 sys:oplog:read 的角色自动补 sys:oplog:export（D4，同 053 模式；可转授继承 read 的开关）；
 * - 部门上限（sys_dept_perm）同样补：上限只封顶不授权，不补的话受限部门的人永远拿不到导出；
 * - AGENCY_LEAD 补日志读/导出 + 部门查看 + scoped 人员管理（D5 用户诉求），BRANCH_ADMIN 补日志读/导出；
 *   新补项的可转授按 grantsAll（有 role:grant/user:role 的角色全可转授，与 seedRolePerms 一致）；
 * - 建 sys_role_dept（角色自定义部门，data_scope=5 用）；旧 data_scope=5 显式转 3（R5，自定义实装前的降级数据）。
 * R3 告知：补码会恢复管理员曾显式收回的项（一次性幂等，发布说明列明）。
 */
import { grant055, grantsAll } from "../src/auth/permCatalog.js";

const AGENCY_ADD = [
  "sys:oplog:read",
  "sys:oplog:export",
  "sys:dept:view",
  "sys:user:create",
  "sys:user:update",
  "sys:user:disable",
  "sys:user:enable",
];
const BRANCH_ADD = ["sys:oplog:read", "sys:oplog:export"];

export async function up(db) {
  await db.run(
    "CREATE TABLE IF NOT EXISTS sys_role_dept (role_id VARCHAR(32) NOT NULL, dept_id VARCHAR(64) NOT NULL, PRIMARY KEY (role_id, dept_id))"
  );
  let roles;
  try {
    roles = await db.all("SELECT id, code, data_scope FROM sys_role");
  } catch {
    return;
  }
  for (const role of roles) {
    if (role.code === "ADMIN") continue; // 系统管理员固定全部权限，按码短路，不落行
    const rid = String(role.id);
    let rows;
    try {
      rows = await db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id = ?", [rid]);
    } catch {
      return;
    }
    const have = new Map(
      rows.map((row) => [String(row.perm), Number(row.grantable) === 1 ? 1 : 0])
    );
    const add = new Map();
    // GRANT_055：导出继承 read 的可转授开关
    for (const code of grant055([...have.keys()])) add.set(code, have.get("sys:oplog:read") ?? 0);
    // 模板补码（D5）：可转授按补完后的码集算
    const extra =
      role.code === "AGENCY_LEAD" ? AGENCY_ADD : role.code === "BRANCH_ADMIN" ? BRANCH_ADD : [];
    if (extra.length) {
      const flag = grantsAll([...have.keys(), ...extra]) ? 1 : 0;
      for (const code of extra) if (!have.has(code) && !add.has(code)) add.set(code, flag);
    }
    for (const [perm, flag] of add)
      await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES (?, ?, ?)", [
        rid,
        perm,
        flag,
      ]);
    // 旧自定义 5 显式降级为本单位（自定义实装前的历史数据不保留悬空语义）
    if (Number(role.data_scope) === 5)
      await db.run("UPDATE sys_role SET data_scope = 3 WHERE id = ?", [rid]);
  }
  // 部门上限里的 GRANT_055：受限部门持 read 的补 export，否则上限会把导出裁掉
  let depts;
  try {
    depts = await db.all("SELECT DISTINCT dept_id FROM sys_dept_perm");
  } catch {
    return;
  }
  for (const { dept_id: deptId } of depts) {
    const codes = (await db.all("SELECT perm FROM sys_dept_perm WHERE dept_id = ?", [deptId])).map(
      (row) => String(row.perm)
    );
    for (const perm of grant055(codes))
      await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES (?, ?)", [deptId, perm]);
  }
}
