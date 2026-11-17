import { insertOperationLog } from "./operationLog.js";

/** 写日志失败只留在服务日志里，不把已经做成的事再打失败。 */
export async function audit(db, entry) {
  try {
    await insertOperationLog(db, entry);
  } catch (error) {
    console.error("操作日志写入失败", error instanceof Error ? error.message : "未知错误");
  }
}
