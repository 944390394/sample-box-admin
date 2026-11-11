/**
 * 账号安全策略：密码长度、字符类别、定期更换、连续输错锁定。存在 db.config.json 的 security 里。
 */

export const SECURITY_DEFAULTS = {
  minLength: 8,
  /** 必须同时包含的字符类别：letter 字母、digit 数字、symbol 符号。 */
  classes: ["letter", "digit"],
  /** 密码多少天必须更换，0 表示不限。 */
  expireDays: 0,
  /** 连续输错几次锁定。 */
  lockThreshold: 5,
  lockMinutes: 15,
};

const CLASS_TEST = {
  letter: [/[A-Za-z]/, "字母"],
  digit: [/\d/, "数字"],
  symbol: [/[^A-Za-z0-9]/, "符号"],
};

export function publicSecurity(config) {
  const raw = config?.security && typeof config.security === "object" ? config.security : {};
  const classes = Array.isArray(raw.classes)
    ? raw.classes.filter((item) => CLASS_TEST[item])
    : SECURITY_DEFAULTS.classes;
  const int = (value, min, max, fallback) =>
    Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  return {
    minLength: int(raw.minLength, 6, 64, SECURITY_DEFAULTS.minLength),
    classes,
    expireDays: int(raw.expireDays, 0, 3650, SECURITY_DEFAULTS.expireDays),
    lockThreshold: int(raw.lockThreshold, 3, 20, SECURITY_DEFAULTS.lockThreshold),
    lockMinutes: int(raw.lockMinutes, 1, 1440, SECURITY_DEFAULTS.lockMinutes),
  };
}

export function mergeSecuritySettings(current, input) {
  const base = current && typeof current === "object" ? current : {};
  const body = input && typeof input === "object" ? input : {};
  const num = (value, min, max, label) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`${label}要在 ${min}–${max} 之间`);
    return n;
  };
  const classes = Array.isArray(body.classes)
    ? [...new Set(body.classes.filter((item) => CLASS_TEST[item]))]
    : [];
  return {
    ...base,
    security: {
      minLength: num(body.minLength, 6, 64, "最短长度"),
      classes,
      expireDays: num(body.expireDays, 0, 3650, "更换周期"),
      lockThreshold: num(body.lockThreshold, 3, 20, "锁定次数"),
      lockMinutes: num(body.lockMinutes, 1, 1440, "锁定时长"),
    },
  };
}

/** 按策略检查新密码，不合格返回原因，合格返回 null。 */
export function checkPassword(password, policy) {
  if (typeof password !== "string" || password.length > 128) return "密码格式不正确";
  if (password.length < policy.minLength) return `密码至少 ${policy.minLength} 位`;
  const missing = policy.classes
    .filter((item) => !CLASS_TEST[item][0].test(password))
    .map((item) => CLASS_TEST[item][1]);
  if (missing.length) return `密码还需要包含${missing.join("、")}`;
  return null;
}

/** 给人看的规则说明，用在改密页和人员表单。 */
export function describePolicy(policy) {
  const parts = [`至少 ${policy.minLength} 位`];
  if (policy.classes.length)
    parts.push(`包含${policy.classes.map((item) => CLASS_TEST[item][1]).join("、")}`);
  return parts.join("，");
}

/**
 * 这个账号现在要不要先改密码：管理员要求的（新建、重置、强制）或者到期了。返回原因或 null。
 */
export function passwordChangeReason(user, policy, now = Date.now()) {
  if (!user) return null;
  if (Number(user.must_change_password) === 1) return "required";
  if (policy.expireDays > 0 && user.password_changed_at) {
    const changed = Date.parse(user.password_changed_at);
    if (Number.isFinite(changed) && now - changed > policy.expireDays * 86400000) return "expired";
  }
  return null;
}

/** 锁定剩余分钟数，没锁返回 0。 */
export function lockedMinutes(user, now = Date.now()) {
  const until = Date.parse(user?.locked_until || "");
  if (!Number.isFinite(until) || until <= now) return 0;
  return Math.ceil((until - now) / 60000);
}
