/**
 * 接口兜底分支的错误口径（体检编号 L-P1-8）。
 *
 * 修复前 `fail(res, error.message || "系统出错", error.publicCode || "B0001", error.httpStatus || 500)`
 * 把任何异常原文都回给客户端：SQL 语法、JSON 解析、第三方库的英文报错跟着一起外泄，
 * 而且都算 500，前端分不清是自己填错还是服务端坏了。
 *
 * 现在只回「带码的错误」：domain/AppError 或手工带的 publicCode + httpStatus 的对象。
 * 其余未知异常统一 B0001 + 固定文案，原文只在诊断日志里（request 结束时会带 error 记一条）。
 */

/** 未知异常的固定文案：不暴露内部细节，也告诉用户下一步能做什么。 */
const GENERIC = { code: "B0001", status: 500, message: "系统出错，请稍后再试或联系管理员" };

/** 只有码没有状态，或只有状态没有码，都按未知处理：免得漏填的调用点悄悄变成「可外泄」。 */
export function errorResponse(error) {
  const code = error?.publicCode;
  const status = error?.httpStatus;
  if (typeof code !== "string" || !code || typeof status !== "number") return { ...GENERIC };
  return {
    code,
    status,
    message: error.message || GENERIC.message,
    // 带码错误可附结构化 data（如划拨整单禁撤的逐台原因，§6.2）；未知异常不带，避免外泄
    ...(error.data !== undefined && error.data !== null ? { data: error.data } : {}),
  };
}
