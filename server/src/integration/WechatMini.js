/**
 * 小程序登录用到的微信接口：
 * - openid：wx.login 的 code 换 openid（auth.code2Session）；小程序绑了微信开放平台账号时一并给 UnionID；
 * - phoneNumber：手机号快速验证组件的 code 换用户手机号（phonenumber.getPhoneNumber，要接口调用凭证）。
 * AppID、AppSecret 在「系统设置 › 集成 › 微信小程序」里配置。
 * 本机调试没有 AppSecret 时，可以在启动服务前设环境变量 SAMPLE_WECHAT_FAKE_OPENID，
 * 跳过微信接口、把所有 code 都当成这个 openid；同时可设 SAMPLE_WECHAT_FAKE_PHONE 当作授权的手机号。线上服务不要设。
 */
export class WechatMini {
  constructor({
    settings,
    fetch = globalThis.fetch,
    fakeOpenid = process.env.SAMPLE_WECHAT_FAKE_OPENID || "",
    fakePhone = process.env.SAMPLE_WECHAT_FAKE_PHONE || "",
    now = () => Date.now(),
  } = {}) {
    Object.assign(this, { settings, fetch, fakeOpenid, fakePhone, now });
    /** 接口调用凭证缓存：{ appId, token, expiresAt } */
    this.token = null;
  }

  /** code 换 openid（和 UnionID，没绑开放平台时为空）；失败抛出给人看的错误。 */
  async openid(code) {
    if (typeof code !== "string" || !code || code.length > 128)
      throw new Error("微信登录凭证无效，请重新打开小程序");
    if (this.fakeOpenid) return { openid: this.fakeOpenid, appId: "dev", unionid: "" };
    const { appId, appSecret } = this.#credentials();
    const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    const data = await this.#call(url);
    if (!data?.openid)
      throw new Error(`微信登录失败：${data?.errmsg || data?.errcode || "没有返回 openid"}`);
    return {
      openid: String(data.openid),
      appId,
      unionid: data.unionid ? String(data.unionid) : "",
    };
  }

  /** 手机号快速验证组件的 code 换手机号（不带区号的 11 位）。凭证过期时刷新一次再试。 */
  async phoneNumber(code) {
    if (typeof code !== "string" || !code || code.length > 256)
      throw new Error("手机号授权无效，请重新点「手机号快捷登录」");
    if (this.fakeOpenid) {
      if (!this.fakePhone) throw new Error("本机调试没有设 SAMPLE_WECHAT_FAKE_PHONE");
      return this.fakePhone;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.#accessToken(attempt > 0);
      const data = await this.#call(
        `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(token)}`,
        { code }
      );
      if (data?.errcode === 0 && data.phone_info)
        return String(data.phone_info.purePhoneNumber || data.phone_info.phoneNumber || "");
      if (![40001, 42001].includes(data?.errcode))
        throw new Error(`获取手机号失败：${data?.errmsg || data?.errcode || "微信没有返回手机号"}`);
    }
    throw new Error("获取手机号失败：接口调用凭证无效");
  }

  #credentials() {
    const { appId, appSecret } = this.settings();
    if (!appId || !appSecret)
      throw new Error("还没配置小程序 AppID 和 AppSecret，请联系管理员到「系统设置 › 集成」填写");
    return { appId, appSecret };
  }

  /** 接口调用凭证（稳定版接口）：缓存到过期前 5 分钟；换了 AppID 或 force 时重新取。 */
  async #accessToken(force = false) {
    const { appId, appSecret } = this.#credentials();
    if (!force && this.token && this.token.appId === appId && this.token.expiresAt > this.now())
      return this.token.token;
    const data = await this.#call("https://api.weixin.qq.com/cgi-bin/stable_token", {
      grant_type: "client_credential",
      appid: appId,
      secret: appSecret,
      force_refresh: force,
    });
    if (!data?.access_token)
      throw new Error(`获取微信接口凭证失败：${data?.errmsg || data?.errcode || "没有返回凭证"}`);
    this.token = {
      appId,
      token: String(data.access_token),
      expiresAt: this.now() + (Number(data.expires_in) || 7200) * 1000 - 300000,
    };
    return this.token.token;
  }

  async #call(url, body) {
    try {
      const res = await this.fetch(url, {
        signal: AbortSignal.timeout(8000),
        ...(body
          ? {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
      return await res.json();
    } catch {
      throw new Error("连不上微信服务器，请稍后再试");
    }
  }
}
