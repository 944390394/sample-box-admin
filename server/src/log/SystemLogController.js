import { resolveAccess } from "../auth/boxAccess.js";
import { LOG_READ, LOG_DETAIL } from "./systemLog.js";

/** 系统诊断是全平台能力，需单独授权，不沿用设备数据可见范围。 */
export class SystemLogController {
  constructor(logger) {
    this.logger = logger;
    this.limits = new Map();
  }
  async allowed(ctx, perm) {
    const access = await resolveAccess(ctx.db, ctx.user);
    if (access.perms.has(perm)) return true;
    ctx.fail("没有系统日志权限", "A0301", 403);
    return false;
  }
  async page(ctx) {
    if (!(await this.allowed(ctx, LOG_READ))) return;
    try {
      ctx.ok(this.logger.query(ctx.query));
    } catch (error) {
      ctx.fail(error.message, "A0400", 400);
    }
  }
  async detail(ctx) {
    if (!(await this.allowed(ctx, LOG_READ)) || !(await this.allowed(ctx, LOG_DETAIL))) return;
    const item = this.logger.detail(ctx.params.id);
    if (!item) return ctx.fail("日志不存在或已超过保留期", "A0404", 404);
    ctx.ok(item);
  }
  async client(ctx) {
    const now = Date.now(),
      id = String(ctx.user.id);
    for (const [key, value] of this.limits) if (now - value.at >= 60000) this.limits.delete(key);
    const counter = this.limits.get(id) || { at: now, count: 0 };
    if (counter.count >= 30 || (this.limits.size >= 2000 && !this.limits.has(id)))
      return ctx.fail("诊断上报过于频繁", "A0429", 429);
    counter.count++;
    this.limits.set(id, counter);
    const b = ctx.body;
    if (typeof b.message !== "string" || !b.message.trim())
      return ctx.fail("缺少异常描述", "A0400", 400);
    const item = this.logger.record({
      source: "frontend",
      level: b.kind === "slow" ? "warn" : "error",
      kind: ["exception", "promise", "vue", "request_failed", "slow", "resource"].includes(b.kind)
        ? b.kind
        : "exception",
      message: b.message,
      stack: typeof b.stack === "string" ? b.stack : "",
      path: typeof b.path === "string" ? b.path : "",
      method: typeof b.method === "string" ? b.method : "",
      duration: typeof b.duration === "number" ? b.duration : null,
      requestId: b.requestId,
      actorId: id,
      status: Number.isInteger(b.status) ? b.status : null,
      code: typeof b.code === "string" ? b.code : "",
    });
    ctx.ok({ accepted: Boolean(item), id: item?.id || null });
  }
}
