/** #26 B1：操作日志增 detail(grant diff/scope 前后) 与 target_org_id(预留)；回填 org_name（actor→dept→name）。幂等自愈。 */
import { listColumns } from "../src/store/schema.js";
export async function up(db) {
  const have = new Set((await listColumns(db, "sys_operation_log")).map((c) => c.name || c));
  if (!have.has("detail"))
    await db.run(
      db.dialect === "mysql"
        ? "ALTER TABLE sys_operation_log ADD COLUMN detail TEXT NULL"
        : "ALTER TABLE sys_operation_log ADD COLUMN detail TEXT NOT NULL DEFAULT ''"
    );
  if (!have.has("target_org_id"))
    await db.run(
      db.dialect === "mysql"
        ? "ALTER TABLE sys_operation_log ADD COLUMN target_org_id VARCHAR(32) NOT NULL DEFAULT ''"
        : "ALTER TABLE sys_operation_log ADD COLUMN target_org_id TEXT NOT NULL DEFAULT ''"
    );
  // 回填 org_name（双方言，幂等）：
  // 1) org_id 空但 actor 在：按 actor 当前部门补 org_id（与写入点 orgId=actor.dept_id 同口径）
  await db.run(
    `UPDATE sys_operation_log
        SET org_id = COALESCE((SELECT u.dept_id FROM sys_user u WHERE u.id = sys_operation_log.actor_id), '')
      WHERE org_id = '' AND actor_id <> ''`
  );
  // 2) org_name 空：按 org_id 取部门名——历史日志记的是当时的单位，不随 actor 调部门漂移；
  //    actor 已删且 org_id 也查不到的留空
  await db.run(
    `UPDATE sys_operation_log
        SET org_name = COALESCE((SELECT d.name FROM sys_dept d WHERE d.id = sys_operation_log.org_id), '')
      WHERE org_name = '' AND org_id <> ''`
  );
}
