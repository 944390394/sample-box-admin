import { insertOperationLog } from "./operationLog.js";

/**
 * 写日志失败只留在服务日志里，不把已经做成的事再打失败。
 * #26 B1：写入收敛——orgId 空的按 actor 当前部门补（与 orgId=actor.dept_id 口径一致），
 * orgName 空的按 org_id 查部门名补齐，各写入点不必各自再查一遍（055a 回填的是历史数据）。
 */
export async function audit(db, entry) {
  try {
    const next = { ...entry };
    if (!next.orgId && next.actorId) {
      const actor = await db.get("SELECT dept_id FROM sys_user WHERE id = ?", [
        String(next.actorId),
      ]);
      if (actor?.dept_id) next.orgId = String(actor.dept_id);
    }
    if (!next.orgName && next.orgId) {
      const dept = await db.get("SELECT name FROM sys_dept WHERE id = ?", [String(next.orgId)]);
      if (dept?.name) next.orgName = dept.name;
    }
    await insertOperationLog(db, next);
  } catch (error) {
    console.error("操作日志写入失败", error instanceof Error ? error.message : "未知错误");
  }
}
