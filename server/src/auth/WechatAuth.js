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
 * 一个账号只绑一个微信（同一个应用里），一个微信可以绑多个账号：
 * - 绑定时只换掉这个账号原来的微信，这个微信绑的其他账号保留；
 * - 微信绑了多个账号时，login 返回账号列表（choose），小程序让用户选，再带着 userId 和新的 code 登录；
 *   带了 userId 的（小程序记着上次选的账号）直接登进那个账号，令牌过期重登不用再选；
 * - accounts：小程序「我的 › 切换账号」列出这个微信绑的全部账号。
 * 绑定时可带上用户在小程序里填的微信昵称、头像；没带时沿用这个微信在别的账号上填过的。
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

  /**
   * 打开小程序静默登录。没绑过：bound=false。只绑了一个账号，或带了 userId 且这个微信确实绑了它：发令牌。
   * 绑了多个账号又没指定（或指定的已经解绑）：返回 choose=true 和账号列表，让用户选。
   */
  async login(ctx) {
    const who = await this.wechat.openid(ctx.body?.code);
    const accounts = await this.#accountsOf(ctx, who.openid);
    if (!accounts.length) return ctx.ok({ bound: false });
    const wanted = String(ctx.body?.userId || "");
    const pick = wanted
      ? accounts.find((a) => a.view.userId === wanted)
      : accounts.length === 1
        ? accounts[0]
        : null;
    if (!pick) return ctx.ok({ bound: true, choose: true, accounts: accounts.map((a) => a.view) });
    if (Number(pick.user.status) !== 1)
      return ctx.fail("绑定的账号已停用，请联系管理员", "A0232", 403);
    const locked = lockedMinutes(pick.user);
    if (locked)
      return ctx.fail(`账号已锁定，请 ${locked} 分钟后再试，或联系管理员解锁`, "A0233", 403);
    // 小程序后来才绑开放平台的，老绑定在这次登录时补上 UnionID；没返回时不清掉已有的
    const unionid = who.unionid || "";
    await ctx.db.run(
      "UPDATE sys_user_wechat SET last_login_at = ?, unionid = CASE WHEN ? <> '' THEN ? ELSE unionid END WHERE openid = ? AND user_id = ?",
      [this.now().toISOString(), unionid, unionid, who.openid, String(pick.user.id)]
    );
    await this.onLogin(ctx, pick.user);
    ctx.ok(this.#signed(pick.user));
  }

  /** 这个微信绑的全部账号（切换账号用），不发令牌。 */
  async accounts(ctx) {
    const who = await this.wechat.openid(ctx.body?.code);
    ctx.ok({ accounts: (await this.#accountsOf(ctx, who.openid)).map((a) => a.view) });
  }

  async bind(ctx) {
    const who = await this.wechat.openid(ctx.body?.code);
    const checked = await this.credentials(ctx, ctx.body?.username, ctx.body?.password);
    if (checked.fail) return ctx.fail(...checked.fail);
    await this.#link(ctx, who, checked.user);
    await this.#record(ctx, checked.user, "绑定微信");
    ctx.ok(this.#signed(checked.user));
  }

  /**
   * 手机号快捷登录（微信官方推荐）：手机号快速验证组件拿到的手机号，和「人员」里登记的手机号对上就绑定这个账号。
   * 对上多个账号时全部绑到这个微信，返回账号列表让用户选（停用的不绑）；对不上时提示改用扫码或账号密码。
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
    if (users.length > 1) {
      for (const user of users) {
        await this.#link(ctx, who, user);
        await this.#record(ctx, user, "手机号绑定微信");
      }
      return ctx.ok({
        bound: true,
        choose: true,
        accounts: (await this.#accountsOf(ctx, who.openid)).map((a) => a.view),
      });
    }
    const user = users[0];
    const locked = lockedMinutes(user);
    if (locked)
      return ctx.fail(`账号已锁定，请 ${locked} 分钟后再试，或联系管理员解锁`, "A0233", 403);
    await this.#link(ctx, who, user);
    await this.onLogin(ctx, user);
    await this.#record(ctx, user, "手机号绑定微信");
    ctx.ok(this.#signed(user));
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
    // 昵称头像说的是这个微信：它绑的其他账号一起改
    const mineRow = await ctx.db.get(
      "SELECT openid FROM sys_user_wechat WHERE user_id = ? ORDER BY last_login_at DESC",
      [String(ctx.user.id)]
    );
    await ctx.db.run("UPDATE sys_user_wechat SET nickname = ?, avatar = ? WHERE openid = ?", [
      nickname,
      avatar,
      mineRow.openid,
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
    ctx.ok(this.#signed(user));
  }

  /** 我绑的微信：昵称、头像、绑定和最近登录时间。 */
  async mine(ctx) {
    const id = String(ctx.user.id);
    const row = await ctx.db.get(
      "SELECT openid, nickname, avatar, bound_at, last_login_at FROM sys_user_wechat WHERE user_id = ? ORDER BY last_login_at DESC",
      [id]
    );
    if (!row) return ctx.ok({ bound: false });
    // 同一个微信还绑了几个别的账号（小程序里可以切换）
    const others = await ctx.db.get(
      "SELECT COUNT(*) AS total FROM sys_user_wechat WHERE openid = ? AND user_id <> ?",
      [row.openid, id]
    );
    ctx.ok({
      bound: true,
      nickname: row.nickname || "",
      avatar: row.avatar || "",
      boundAt: row.bound_at,
      lastLoginAt: row.last_login_at || "",
      otherAccounts: Number(others?.total || 0),
    });
  }

  async unbind(ctx) {
    await ctx.db.run("DELETE FROM sys_user_wechat WHERE user_id = ?", [String(ctx.user.id)]);
    await this.#record(ctx, ctx.user, "解绑微信");
    ctx.ok(null, "已解绑微信");
  }

  /**
   * 绑定这一对微信和账号：这个账号在这个应用里原来绑的微信换掉（一个账号只留一个微信），
   * 这个微信绑的其他账号不动（一个微信可以绑多个账号）。顺带存下 UnionID（有就存）和昵称、头像（不合格的忽略），
   * 没带昵称头像时沿用这个微信在别的账号上填过的。
   */
  async #link(ctx, { openid, appId, unionid = "" }, user) {
    const given = readProfile(ctx.body);
    const known =
      given.nickname || given.avatar
        ? null
        : await ctx.db.get(
            "SELECT nickname, avatar FROM sys_user_wechat WHERE openid = ? AND user_id <> ? ORDER BY last_login_at DESC",
            [openid, String(user.id)]
          );
    const nickname = given.nickname || known?.nickname || "";
    const avatar = given.avatar || known?.avatar || "";
    const at = this.now().toISOString();
    await ctx.db.transaction(async (tx) => {
      await tx.run("DELETE FROM sys_user_wechat WHERE user_id = ? AND (appid = ? OR openid = ?)", [
        String(user.id),
        appId,
        openid,
      ]);
      await tx.run(
        "INSERT INTO sys_user_wechat (openid, user_id, appid, unionid, bound_at, last_login_at, nickname, avatar) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [openid, String(user.id), appId, unionid, at, at, nickname, avatar]
      );
    });
  }

  /** 登录成功的返回：带上 userId，小程序记住选的是哪个账号，令牌过期重登时不用再选。 */
  #signed(user) {
    return { bound: true, userId: String(user.id), ...this.tokens(user) };
  }

  /**
   * 这个微信绑的账号，最近登录的在前。停用、锁定的也列出来，标上原因，小程序里灰掉不能选。
   * 返回 [{ user, view }]，view 给小程序看：编号、姓名、用户名、部门、角色、最近登录。
   */
  async #accountsOf(ctx, openid) {
    const rows = await ctx.db.all(
      "SELECT user_id, last_login_at FROM sys_user_wechat WHERE openid = ?",
      [openid]
    );
    const list = [];
    for (const row of rows) {
      const user = await ctx.db.get("SELECT * FROM sys_user WHERE id = ?", [String(row.user_id)]);
      if (!user) continue;
      const dept =
        user.dept_id == null
          ? null
          : await ctx.db.get("SELECT name FROM sys_dept WHERE id = ?", [String(user.dept_id)]);
      const roles = await ctx.db.all(
        "SELECT r.name FROM sys_user_role ur JOIN sys_role r ON r.id = ur.role_id WHERE ur.user_id = ? ORDER BY r.sort",
        [String(user.id)]
      );
      const locked = lockedMinutes(user);
      const reason =
        Number(user.status) !== 1 ? "已停用" : locked ? `已锁定，${locked} 分钟后再试` : "";
      list.push({
        user,
        view: {
          userId: String(user.id),
          nickname: user.nickname || user.username,
          username: user.username,
          deptName: dept?.name || "",
          roleNames: roles.map((r) => r.name).join("、"),
          lastLoginAt: row.last_login_at || "",
          disabled: Boolean(reason),
          reason,
        },
      });
    }
    return list.sort((a, b) =>
      String(b.view.lastLoginAt).localeCompare(String(a.view.lastLoginAt))
    );
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
