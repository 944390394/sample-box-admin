/**
 * 系统设置里除数据库以外的可保存项。
 * 安全密钥留在配置文件里；读接口也会带上，因为浏览器地图要自己拿去请求瓦片。
 * 留空的安全密钥表示不改原来的值。
 */

const LABEL_DEFAULTS = {
  lifePending: "待激活",
  lifeIdle: "未使用",
  uplinkBoot: "上电",
  uplinkTimer: "定时",
  lidOpen: "开着",
  lidShut: "关着",
  chargeIdle: "未充电",
  chargeOn: "充电中",
  online: "在线",
  offline: "离线",
  ledMcu: "STM 指示灯",
  ledModem: "4G 模块指示灯",
};

export const LABEL_KEYS = Object.keys(LABEL_DEFAULTS);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function defaultProduct() {
  return {
    map: { tk: "", sk: "" },
    policy: {
      reportIntervalSec: 60,
      scheduledReport: false,
      batteryPercent: 20,
      arrivalRadiusM: 2000,
    },
    brand: {
      name: "智采 · 采样箱",
      title: "智采 · 采样箱",
      logoDataUrl: "",
    },
    labels: { ...LABEL_DEFAULTS },
    security: {
      idleMinutes: 30,
      passwordMin: 8,
      lockAfter: 5,
    },
    integration: {
      webhookEnabled: false,
      webhookUrl: "",
    },
  };
}

function text(value, max, label, required) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed && required) throw new Error(`请填写${label}`);
  if ([...trimmed].length > max) throw new Error(`${label}不能超过 ${max} 个字`);
  return trimmed;
}

function intIn(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label}需在 ${min} 到 ${max} 之间`);
  }
  return number;
}

function logoData(value) {
  const data = String(value ?? "");
  if (!data) return "";
  if (!/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(data)) {
    throw new Error("图标只接受 PNG、JPG 或 WebP");
  }
  if (data.length > 110000) throw new Error("图标需小于 80KB");
  return data.replace(/\s/g, "");
}

export function normalizeProduct(raw) {
  const base = defaultProduct();
  const source = raw && typeof raw === "object" ? raw : {};
  const map = source.map && typeof source.map === "object" ? source.map : {};
  const policy = source.policy && typeof source.policy === "object" ? source.policy : {};
  const brand = source.brand && typeof source.brand === "object" ? source.brand : {};
  const labels = source.labels && typeof source.labels === "object" ? source.labels : {};
  const security = source.security && typeof source.security === "object" ? source.security : {};
  const integration =
    source.integration && typeof source.integration === "object" ? source.integration : {};

  base.map.tk = String(map.tk ?? "");
  base.map.sk = String(map.sk ?? "");
  if (Number.isInteger(Number(policy.reportIntervalSec))) {
    base.policy.reportIntervalSec = Number(policy.reportIntervalSec);
  }
  base.policy.scheduledReport = Boolean(policy.scheduledReport);
  if (Number.isInteger(Number(policy.batteryPercent))) {
    base.policy.batteryPercent = Number(policy.batteryPercent);
  }
  if (Number.isInteger(Number(policy.arrivalRadiusM))) {
    base.policy.arrivalRadiusM = Number(policy.arrivalRadiusM);
  }
  if (brand.name) base.brand.name = String(brand.name);
  if (brand.title) base.brand.title = String(brand.title);
  base.brand.logoDataUrl = String(brand.logoDataUrl ?? "");
  for (const key of LABEL_KEYS) {
    if (labels[key]) base.labels[key] = String(labels[key]);
  }
  if (Number.isInteger(Number(security.idleMinutes))) {
    base.security.idleMinutes = Number(security.idleMinutes);
  }
  if (Number.isInteger(Number(security.passwordMin))) {
    base.security.passwordMin = Number(security.passwordMin);
  }
  if (Number.isInteger(Number(security.lockAfter))) {
    base.security.lockAfter = Number(security.lockAfter);
  }
  base.integration.webhookEnabled = Boolean(integration.webhookEnabled);
  base.integration.webhookUrl = String(integration.webhookUrl ?? "");
  return base;
}

export function mergeProduct(current, input) {
  const next = normalizeProduct(current);
  const patch = input && typeof input === "object" ? input : {};

  if (patch.map && typeof patch.map === "object") {
    if (patch.map.tk != null) {
      next.map.tk = text(patch.map.tk, 64, "应用密钥", false);
      if (next.map.tk && !/^[A-Za-z0-9]+$/.test(next.map.tk)) {
        throw new Error("应用密钥只包含字母和数字");
      }
    }
    if (patch.map.clearSk) next.map.sk = "";
    else if (patch.map.sk) next.map.sk = text(patch.map.sk, 128, "安全密钥", true);
  }

  if (patch.policy && typeof patch.policy === "object") {
    const policy = patch.policy;
    if (policy.reportIntervalSec != null) {
      next.policy.reportIntervalSec = intIn(policy.reportIntervalSec, 60, 86400, "上报间隔");
    }
    if (policy.scheduledReport != null)
      next.policy.scheduledReport = Boolean(policy.scheduledReport);
    if (policy.batteryPercent != null) {
      next.policy.batteryPercent = intIn(policy.batteryPercent, 5, 50, "电量阈值");
    }
    if (policy.arrivalRadiusM != null) {
      next.policy.arrivalRadiusM = intIn(policy.arrivalRadiusM, 50, 50000, "任务到达半径");
    }
  }

  if (patch.brand && typeof patch.brand === "object") {
    if (patch.brand.name != null) next.brand.name = text(patch.brand.name, 20, "系统名称", true);
    if (patch.brand.title != null) next.brand.title = text(patch.brand.title, 40, "标题", false);
    if (patch.brand.logoDataUrl != null) next.brand.logoDataUrl = logoData(patch.brand.logoDataUrl);
  }

  if (patch.labels && typeof patch.labels === "object") {
    for (const key of LABEL_KEYS) {
      if (patch.labels[key] != null)
        next.labels[key] = text(patch.labels[key], 16, "显示名称", true);
    }
  }

  if (patch.security && typeof patch.security === "object") {
    const security = patch.security;
    if (security.idleMinutes != null) {
      next.security.idleMinutes = intIn(security.idleMinutes, 5, 240, "闲置退出");
    }
    if (security.passwordMin != null) {
      next.security.passwordMin = intIn(security.passwordMin, 6, 32, "密码最少位数");
    }
    if (security.lockAfter != null) {
      next.security.lockAfter = intIn(security.lockAfter, 3, 10, "失败锁定次数");
    }
  }

  if (patch.integration && typeof patch.integration === "object") {
    const integration = patch.integration;
    const enabled =
      integration.webhookEnabled == null
        ? next.integration.webhookEnabled
        : Boolean(integration.webhookEnabled);
    const url =
      integration.webhookUrl == null ? next.integration.webhookUrl : String(integration.webhookUrl);
    const trimmed = text(url, 300, "回调地址", false);
    if (trimmed) {
      let parsed;
      try {
        parsed = new URL(trimmed);
      } catch {
        throw new Error("回调地址不是有效的网址");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("回调地址只接受 http 或 https");
      }
    } else if (enabled) {
      throw new Error("启用回调时需要填写地址");
    }
    next.integration.webhookEnabled = enabled;
    next.integration.webhookUrl = trimmed;
  }

  return next;
}

export function publicProduct(raw) {
  const product = normalizeProduct(raw);
  return {
    ...clone(product),
    map: { tk: product.map.tk, sk: product.map.sk, skSet: product.map.sk.length > 0 },
  };
}

export function publicBrand(raw) {
  const brand = normalizeProduct(raw).brand;
  return { name: brand.name, title: brand.title, logoDataUrl: brand.logoDataUrl };
}

export function passwordMinOf(config) {
  return normalizeProduct(config?.product).security.passwordMin;
}
