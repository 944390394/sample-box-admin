import { randomBytes } from "node:crypto";
import { lockedMinutes } from "../settings/securityConfig.js";
import { audit } from "../log/audit.js";

/** 绑定二维码 5 分钟有效。 */
const TICKET_TTL_MS = 5 * 60000;
/** 头像是小程序里选的图片，压缩后转成 data URL 存，最多约 200 KB。 */
const AVATAR_MAX = 200000;

/**
 * 小程序登录。打开小程序时 wx.login 拿 code：
 * - login：code 换 openid，绑过账号就直接发令牌；没绑过返回 bound=false，小程序再让用户绑定；
 * - phone：手机号快捷登录（微信官方推荐），按「人员」里登记的手机号找到账号并绑定；
 * - bind：账号密码校验通过后把当前微信绑到这个账号；
 * - ticket / bindTicket：网页个人中心生成绑定二维码（5 分钟、只能用一次），小程序扫码后绑到网页上登录的那个账号，手机上不用输密码；
 * - unbind：自己解绑（小程序「我的」或网页个人中心），之后要重新绑定；mine：网页个人中心看我绑的是哪个微信。
 * 换绑：这个微信或这个账号原来的绑定都换成这一对。绑定时可带上用户在小程序里填的微信昵称、头像。
 * 小程序绑了微信开放平台账号时，code2Session 会带 UnionID，绑定和登录时顺带记下。
 * 账号停用、锁定时不发令牌；账号须改密时照常发令牌，由接口门禁拦到改密。
 *
 * credentials(ctx, username, password) → { user } | { fail: [提示, 错误码, 状态码] }，带登录失败锁定；
 * tokens(user) → 令牌；onLogin(ctx, user) 记登录日志。
 */
export class WechatAuth {
  constructor({ wechat, credentials, tokens, onLogin = async () => {}, now = () => new Date() }) {
    Object.assign(this, { wechat, credentials, tokens, onLogin, now });
    /** 绑定票据只放内存：服务重启后网页上点一下刷新二维码即可。 */
    this.tickets = new Map();
  }

  async login(ctx) {
    const { openid, unionid = "" } = await this.wechat.openid(ctx.body?.code);
    const bound = await ctx.db.get("SELECT user_id FROM sys_user_wechat WHERE openid = ?", [
      openid,
    ]);
    if (!bound) return ctx.ok({ bound: false });
    const user = await ctx.db.get("SELECT * FROM sys_user WHERE id = ?", [bound.user_id]);
    if (!user || Number(user.status) !== 1)
      return ctx.fail("绑定的账号已停用，请联系管理员", "A0232", 403);
    const locked = lockedMinutes(user);
    if (locked)
      return ctx.fail(`账号已锁定，请 ${locked} 分钟后再试，或联系管理员解锁`, "A0233", 403);
    // 小程序后来才绑开放平台的，老绑定在这次登录时补上 UnionID；没返回时不清掉已有的
    await ctx.db.run(
      "UPDATE sys_user_wechat SET last_login_at = ?, unionid = CASE WHEN ? <> '' THEN ? ELSE unionid END WHERE openid = ?",
      [this.now().toISOString(), unionid, unionid, openid]
    );
    await this.onLogin(ctx, user);
    ctx.ok({ bound: true, ...this.tokens(user) });
  }

  async bind(ctx) {
    const who = await this.wechat.openid(ctx.body?.code);
    const checked = await this.credentials(ctx, ctx.body?.username, ctx.body?.password);
    if (checked.fail) return ctx.fail(...checked.fail);
    await this.#link(ctx, who, checked.user);
    await this.#record(ctx, checked.user, "绑定微信");
    ctx.ok({ bound: true, ...this.tokens(checked.user) });
  }

  /**
   * 手机号快捷登录（微信官方推荐）：手机号快速验证组件拿到的手机号，和「人员」里登记的手机号对上就绑定这个账号。
   * 对不上或对上多个账号时不绑定，提示改用扫码或账号密码。
   */
  async phone(ctx) {
    const who = await this.wechat.openid(ctx.body?.code);
    const phone = normalizePhone(await this.wechat.phoneNumber(ctx.body?.phoneCode));
    if (!phone) return ctx.fail("没拿到手机号，请重试，或用扫码、账号密码绑定", "A0411", 400);
    const masked = `${phone.slice(0, 3)}****${phone.slice(-4)}`;
    // 人员里的手机号可能带空格、横线、+86：先按后 4 位粗筛，再统一格式比对
    const candidates = await ctx.db.all(
      "SELECT * FROM sys_user WHERE status = 1 AND mobile LIKE ?",
      [`%${phone.slice(-4)}%`]
    );
    const users = candidates.filter((user) => normalizePhone(user.mobile) === phone);
    if (!users.length)
      return ctx.fail(
        `手机号 ${masked} 没有对应的账号。请管理员在「人员」里给你的账号填上这个手机号，或改用扫码、账号密码绑定`,
        "A0411",
        400
      );
    if (users.length > 1)
      return ctx.fail(`手机号 ${masked} 登记在多个账号上，请改用扫码或账号密码绑定`, "A0411", 400);
    const user = users[0];
    const locked = lockedMinutes(user);
    if (locked)
      return ctx.fail(`账号已锁定，请 ${locked} 分钟后再试，或联系管理员解锁`, "A0233", 403);
    await this.#link(ctx, who, user);
    await this.onLogin(ctx, user);
    await this.#record(ctx, user, "手机号绑定微信");
    ctx.ok({ bound: true, ...this.tokens(user) });
  }

  /** 登录后完善资料：改我绑定的微信的昵称、头像。 */
  async profile(ctx) {
    if (
      !(await ctx.db.get("SELECT openid FROM sys_user_wechat WHERE user_id = ?", [
        String(ctx.user.id),
      ]))
    )
      return ctx.fail("还没有绑定微信");
    const { nickname, avatar } = readProfile(ctx.body);
    await ctx.db.run("UPDATE sys_user_wechat SET nickname = ?, avatar = ? WHERE user_id = ?", [
      nickname,
      avatar,
      String(ctx.user.id),
    ]);
    await this.mine(ctx);
  }

  /** 网页个人中心生成绑定二维码的票据；同一账号再生成时旧的作废。 */
  async ticket(ctx) {
    this.#sweep();
    const userId = String(ctx.user.id);
    for (const [key, item] of this.tickets) if (item.userId === userId) this.tickets.delete(key);
    const ticket = randomBytes(24).toString("hex");
    const expiresAt = this.now().getTime() + TICKET_TTL_MS;
    this.tickets.set(ticket, { userId, sv: Number(ctx.user.session_version || 0), expiresAt });
    ctx.ok({ ticket, expiresAt: new Date(expiresAt).toISOString(), ttlSec: TICKET_TTL_MS / 1000 });
  }

  /** 小程序扫网页上的绑定二维码。票据只能用一次；账号在这期间被停用、下线、改密都会让票据失效。 */
  async bindTicket(ctx) {
    const who = await this.wechat.openid(ctx.body?.code);
    this.#sweep();
    const key = String(ctx.body?.ticket || "");
    const item = this.tickets.get(key);
    if (!item) return ctx.fail("二维码已过期或已经用过，请在网页上刷新二维码再扫", "A0410", 400);
    this.tickets.delete(key);
    const user = await ctx.db.get("SELECT * FROM sys_user WHERE id = ?", [item.userId]);
    if (!user || Number(user.status) !== 1 || Number(user.session_version || 0) !== item.sv) {
      return ctx.fail("网页上的登录已失效，请重新登录网页后再生成二维码", "A0410", 400);
    }
    const locked = lockedMinutes(user);
    if (locked)
      return ctx.fail(`账号已锁定，请 ${locked} 分钟后再试，或联系管理员解锁`, "A0233", 403);
    await this.#link(ctx, who, user);
    await this.onLogin(ctx, user);
    await this.#record(ctx, user, "扫码绑定微信");
    ctx.ok({ bound: true, ...this.tokens(user) });
  }

  /** 我绑的微信：昵称、头像、绑定和最近登录时间。 */
  async mine(ctx) {
    const row = await ctx.db.get(
      "SELECT nickname, avatar, bound_at, last_login_at FROM sys_user_wechat WHERE user_id = ? ORDER BY last_login_at DESC",
      [String(ctx.user.id)]
    );
    ctx.ok(
      row
        ? {
            bound: true,
            nickname: row.nickname || "",
            avatar: row.avatar || "",
            boundAt: row.bound_at,
            lastLoginAt: row.last_login_at || "",
          }
        : { bound: false }
    );
  }

  async unbind(ctx) {
    await ctx.db.run("DELETE FROM sys_user_wechat WHERE user_id = ?", [String(ctx.user.id)]);
    await this.#record(ctx, ctx.user, "解绑微信");
    ctx.ok(null, "已解绑微信");
  }

  /** 绑定这一对微信和账号（一个账号只留一个微信），顺带存下 UnionID（有就存）和昵称、头像（不合格的忽略）。 */
  async #link(ctx, { openid, appId, unionid = "" }, user) {
    const { nickname, avatar } = readProfile(ctx.body);
    const at = this.now().toISOString();
    await ctx.db.transaction(async (tx) => {
      await tx.run("DELETE FROM sys_user_wechat WHERE openid = ? OR user_id = ?", [
        openid,
        String(user.id),
      ]);
      await tx.run(
        "INSERT INTO sys_user_wechat (openid, user_id, appid, unionid, bound_at, last_login_at, nickname, avatar) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [openid, String(user.id), appId, unionid, at, at, nickname, avatar]
      );
    });
  }

  #sweep() {
    const now = this.now().getTime();
    for (const [key, item] of this.tickets) if (item.expiresAt <= now) this.tickets.delete(key);
  }

  async #record(ctx, user, action) {
    await audit(ctx.db, {
      orgId: String(user.dept_id || ""),
      orgName: "",
      actorId: String(user.id),
      actorName: user.nickname || user.username,
      action,
      targetType: "user",
      targetId: String(user.id),
      result: "成功",
      ip: ctx.ip || "",
    });
  }
}

/** 手机号只留数字，去掉 86 / 0086 区号，得到 11 位；不是大陆手机号的原样保留数字。 */
export function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  const local = digits.replace(/^(0086|86)(1\d{10})$/, "$2");
  return local.length >= 6 ? local : "";
}

/** 小程序里填的微信昵称（最多 32 字）和头像（data:image/... base64，最多约 200 KB）。 */
export function readProfile(body) {
  const nickname = typeof body?.nickname === "string" ? body.nickname.trim().slice(0, 32) : "";
  const raw = typeof body?.avatar === "string" ? body.avatar : "";
  const avatar =
    raw.length <= AVATAR_MAX &&
    /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(raw)
      ? raw
      : "";
  return { nickname, avatar };
}
