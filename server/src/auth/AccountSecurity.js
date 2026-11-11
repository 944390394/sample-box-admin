import { hashPassword, verifyPassword } from "../../auth.js";
import { audit } from "../log/audit.js";
import { checkPassword, SECURITY_DEFAULTS } from "../settings/securityConfig.js";

/** 只允许当前账户改密；原密码失败限流不影响管理员恢复账户。 */
export class AccountSecurity {
  constructor({ now = Date.now, policy = () => SECURITY_DEFAULTS } = {}) {
    this.now = now;
    this.policy = policy;
    this.attempts = new Map();
  }

  async changePassword(ctx) {
    const id = String(ctx.user.id),
      now = this.now();
    for (const [key, item] of this.attempts) if (now >= item.until) this.attempts.delete(key);
    const attempt = this.attempts.get(id);
    if (attempt?.count >= 5 || (!attempt && this.attempts.size >= 10000))
      return ctx.fail("尝试次数过多，请15分钟后重试", "A0429", 429);
    const { oldPassword, newPassword, confirmPassword } = ctx.body || {};
    if (typeof oldPassword !== "string" || !oldPassword || oldPassword.length > 1024)
      return ctx.fail("请输入原密码", "A0400", 400);
    const problem = checkPassword(newPassword, this.policy());
    if (problem) return ctx.fail(problem, "A0400", 400);
    if (newPassword !== confirmPassword) return ctx.fail("两次输入的新密码不一致", "A0400", 400);
    if (newPassword === oldPassword) return ctx.fail("新密码不能与原密码相同", "A0400", 400);
    const current = await ctx.db.get("SELECT * FROM sys_user WHERE id = ?", [id]);
    if (
      !current ||
      Number(current.status) !== 1 ||
      Number(current.session_version || 0) !== Number(ctx.user.session_version || 0)
    )
      return ctx.fail("登录已过期，请重新登录", "A0230", 401);
    if (!verifyPassword(oldPassword, current.password_hash)) {
      const latest = this.attempts.get(id);
      this.attempts.set(id, {
        count: (latest?.count || 0) + 1,
        until: latest?.until || now + 15 * 60000,
      });
      await this.record(ctx, "失败");
      return ctx.fail("原密码不正确", "A0400", 400);
    }
    const result = await ctx.db.run(
      "UPDATE sys_user SET password_hash = ?, must_change_password = 0, password_changed_at = ?, session_version = session_version + 1 WHERE id = ? AND password_hash = ? AND session_version = ? AND status = 1",
      [
        hashPassword(newPassword),
        new Date(this.now()).toISOString(),
        id,
        current.password_hash,
        Number(current.session_version || 0),
      ]
    );
    if (Number(result.changes ?? result.affectedRows) !== 1)
      return ctx.fail("账户状态已变化，请重新登录", "A0230", 401);
    this.attempts.delete(id);
    ctx.invalidateSessions?.(id);
    await this.record(ctx, "成功");
    ctx.ok(null, "密码修改成功，请重新登录");
  }

  async record(ctx, result) {
    await audit(ctx.db, {
      orgId: String(ctx.user.dept_id || ""),
      actorId: String(ctx.user.id),
      actorName: ctx.user.nickname || ctx.user.username,
      action: "修改密码",
      targetType: "user",
      targetId: String(ctx.user.id),
      result,
      ip: ctx.ip || "",
    });
  }
}
