/**
 * 外部集成：邮件服务（SMTP）和视频平台。存在 db.config.json 的 smtp、video 里。
 * 密码、令牌只写不读：页面上显示是否已设置，保存时留空表示不改。
 */

const SECURE = ["none", "ssl", "starttls"];

export function readSmtp(config) {
  const raw = config?.smtp && typeof config.smtp === "object" ? config.smtp : {};
  return {
    enabled: Boolean(raw.enabled),
    host: String(raw.host || ""),
    port: Number(raw.port) || 465,
    secure: SECURE.includes(raw.secure) ? raw.secure : "ssl",
    user: String(raw.user || ""),
    password: String(raw.password || ""),
    fromName: String(raw.fromName || "智采 · 采样箱"),
    fromAddress: String(raw.fromAddress || ""),
  };
}

export function publicSmtp(config) {
  const { password, ...rest } = readSmtp(config);
  return { ...rest, passwordSet: Boolean(password) };
}

export function mergeSmtpSettings(current, input) {
  const base = current && typeof current === "object" ? current : {};
  const body = input && typeof input === "object" ? input : {};
  const previous = readSmtp(base);
  const host = String(body.host || "").trim();
  const port = Number(body.port);
  const secure = SECURE.includes(body.secure) ? body.secure : "ssl";
  const fromAddress = String(body.fromAddress || "").trim();
  const enabled = Boolean(body.enabled);
  if (enabled && !host) throw new Error("请填写 SMTP 服务器");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口不正确");
  if (fromAddress && !/^[^\s@]+@[^\s@]+$/.test(fromAddress)) throw new Error("发件地址格式不正确");
  if (host.length > 255 || String(body.user || "").length > 255)
    throw new Error("服务器或账号过长");
  const typed = String(body.password || "");
  return {
    ...base,
    smtp: {
      enabled,
      host,
      port,
      secure,
      user: String(body.user || "").trim(),
      password: typed || previous.password,
      fromName:
        String(body.fromName || "")
          .trim()
          .slice(0, 64) || "智采 · 采样箱",
      fromAddress,
    },
  };
}

export function readVideo(config) {
  const raw = config?.video && typeof config.video === "object" ? config.video : {};
  return {
    enabled: Boolean(raw.enabled),
    url: String(raw.url || ""),
    token: String(raw.token || ""),
    timeoutMs: Number.isInteger(raw.timeoutMs) ? raw.timeoutMs : 8000,
  };
}

export function publicVideo(config) {
  const { token, ...rest } = readVideo(config);
  return { ...rest, tokenSet: Boolean(token) };
}

export function mergeVideoSettings(current, input) {
  const base = current && typeof current === "object" ? current : {};
  const body = input && typeof input === "object" ? input : {};
  const previous = readVideo(base);
  const url = String(body.url || "").trim();
  const enabled = Boolean(body.enabled);
  if (enabled && !/^https?:\/\/\S+$/.test(url)) throw new Error("请填写 http(s) 开头的接口地址");
  const timeoutMs = Number(body.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000)
    throw new Error("超时要在 1000–60000 毫秒之间");
  const typed = String(body.token || "");
  return { ...base, video: { enabled, url, token: typed || previous.token, timeoutMs } };
}

/** 微信小程序：AppID 和 AppSecret，用来把小程序登录的 code 换成 openid。AppSecret 只写不读。 */
export function readWechat(config) {
  const raw = config?.wechat && typeof config.wechat === "object" ? config.wechat : {};
  return { appId: String(raw.appId || ""), appSecret: String(raw.appSecret || "") };
}

export function publicWechat(config) {
  const { appSecret, ...rest } = readWechat(config);
  return { ...rest, appSecretSet: Boolean(appSecret) };
}

export function mergeWechatSettings(current, input) {
  const base = current && typeof current === "object" ? current : {};
  const body = input && typeof input === "object" ? input : {};
  const previous = readWechat(base);
  const appId = String(body.appId || "").trim();
  if (appId && !/^wx[0-9a-zA-Z]{16}$/.test(appId))
    throw new Error("AppID 格式不对，应为 wx 开头的 18 位");
  const typed = String(body.appSecret || "").trim();
  if (typed && !/^[0-9a-zA-Z]{16,64}$/.test(typed)) throw new Error("AppSecret 格式不对");
  return { ...base, wechat: { appId, appSecret: typed || previous.appSecret } };
}
