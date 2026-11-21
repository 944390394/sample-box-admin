/**
 * R13 公司级策略中心（P0+P1，任务 #46）：
 * ① box_company_policy：公司默认策略层（dept_id PK）。idle_json/task_json 各存一份完整策略
 *    （NULL＝整层继承系统默认；task 仅作建单初始值＋空策略兜底，进行中任务按建单快照不波及）；
 *    battery_reserve/arrive_radius_m/offline_grace_sec 是公司化判定阈值列（NULL＝继承系统默认，
 *    服务端生效不下发）。updated_at/updated_by 记最近一次保存。
 * ② box_report_delivery 补 echo_lights（rl= 灯回显，P1 三态生效确认；016 同款幂等加列）。
 * ③ 幂等补码 device:box:policyCompany 给 BRANCH_ADMIN/DISPATCH（沿 056 ②b：先查存在再补、
 *    可转授按 grantsAll、只补不删——角色页显式收回过的项会被恢复，一次性，发布说明列明）。
 *    连前置 needs 一起补：device:box:policyRead（公司策略页读模型要它；角色页勾选自动补前置，
 *    迁移/模板补码走同一契约）。ADMIN 按码短路不落行（resolvePerms 全量）；自定义角色不动。
 * ④ 备份 sys_role_perm 整表到 _bak_company_policy_sys_role_perm（补码前留底；
 *    IF NOT EXISTS 保证重跑不覆盖首次备份）。新表/新列无需备份（ additive）。
 * 幂等：CREATE IF NOT EXISTS＋列存在检查＋补码先查后插，重跑结果不变。
 */
import { grantsAll } from "../src/auth/permCatalog.js";

export async function up(db) {
  // ④ 备份先于改动
  await db.run(
    "CREATE TABLE IF NOT EXISTS _bak_company_policy_sys_role_perm AS SELECT * FROM sys_role_perm"
  );
  // ① 公司策略表
  await db.run(`CREATE TABLE IF NOT EXISTS box_company_policy (
    dept_id VARCHAR(32) PRIMARY KEY,
    idle_json TEXT,
    task_json TEXT,
    battery_reserve INTEGER,
    arrive_radius_m INTEGER,
    offline_grace_sec INTEGER,
    updated_at VARCHAR(32),
    updated_by VARCHAR(64)
  )`);
  // ② rl= 灯回显列（016 同款：按方言查列，缺才加）
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM box_report_delivery")
      : await db.all("PRAGMA table_info(box_report_delivery)");
  const names = new Set(columns.map((row) => row.Field || row.name));
  if (!names.has("echo_lights"))
    await db.run("ALTER TABLE box_report_delivery ADD COLUMN echo_lights INTEGER");
  // ③ 补码（只补不删，幂等；前置 policyRead 先补，可转授按补码时的码集算）
  const roles = await db.all(
    "SELECT id, code FROM sys_role WHERE code IN ('BRANCH_ADMIN', 'DISPATCH')"
  );
  for (const role of roles) {
    const rid = String(role.id);
    const rows = await db.all("SELECT perm FROM sys_role_perm WHERE role_id = ?", [rid]);
    const have = new Set(rows.map((row) => String(row.perm)));
    for (const perm of ["device:box:policyRead", "device:box:policyCompany"]) {
      if (have.has(perm)) continue;
      const flag = grantsAll([...have, perm]) ? 1 : 0;
      await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES (?, ?, ?)", [
        rid,
        perm,
        flag,
      ]);
      have.add(perm);
    }
  }
}
