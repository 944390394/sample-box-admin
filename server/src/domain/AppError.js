/**
 * 带响应码的错误。放在 domain 层是因为接口层之外的模块（第三方集成、领域服务）也要用它标清楚
 * 「这话是给用户看的」：index.js 的兜底分支只回带码的错误，
 * 没有 AppError 包装的未知异常一律 B0001 + 固定文案，原文只进诊断日志（体检编号 L-P1-8）。
 *
 * 参数顺序按「码 → 状态 → 文案」，和 fail(res, msg, code, status) 的字段一一对应，
 * 少写 httpStatus 时按码的类别推一个默认值，避免调用点漏填又回 500。
 */
export class AppError extends Error {
  constructor(code, httpStatus, message) {
    super(message);
    this.name = "AppError";
    this.publicCode = code;
    this.httpStatus = httpStatus ?? HTTP_STATUS[code] ?? 200;
  }
}

/** 常用码的默认 HTTP 状态，和现有 ctx.fail(msg, code, status) 调用点保持一致。 */
const HTTP_STATUS = {
  A0230: 401,
  A0231: 401,
  A0240: 403,
  A0301: 403,
  A0400: 400,
  A0404: 404,
  A0409: 409,
  A0410: 400,
  A0411: 400,
  A0429: 429,
  B0001: 500,
};

/** 参数没填对、当前状态不允许这个动作：客户端改一改可以重来。 */
export const badRequest = (message) => new AppError("A0400", 400, message);

/** 看进自己数据范围外的资源：和不存在给同一个码，不给存在性线索。 */
export const notVisible = (message = "记录不存在或不在你的管理范围内") =>
  new AppError("A0404", 404, message);

/** 角色权限不够。 */
export const noPermission = (message = "没有这项操作权限") => new AppError("A0301", 403, message);

/** 这个功能没配置或不支持：不是调用方填错，也不是服务端异常。项目里 A0409 一直是这个用途。 */
export const notConfigured = (message) => new AppError("A0409", 409, message);

/** 当前状态不允许这个动作（数据被别人改过、箱子还在别的单里）：刷新或先做完前一步再来。 */
export const conflict = (message) => new AppError("A0409", 409, message);

/** 第三方接口不通或返回失败：原文是对方给的话，可以回给用户，但不是我们自己的错。 */
export const upstreamUnavailable = (message) => new AppError("B0503", 503, message);

/** 服务端内部出错，原文不外泄。 */
export const internalError = (message = "系统出错，请稍后再试") =>
  new AppError("B0001", 500, message);
