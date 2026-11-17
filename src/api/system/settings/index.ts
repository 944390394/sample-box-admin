import request from "@/utils/request";

export interface DatabaseSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  passwordSet: boolean;
}

export interface DatabaseInput {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
}

export interface MapSettings {
  tk: string;
  sk: string;
}

export interface MapInput {
  tk: string;
  sk?: string;
}

export interface BoxSettings {
  reportPeriodSec: number;
  reportOnlyWhenCharging: boolean;
  batteryReserve: number;
  /** 任务里箱子离目的地多近算到达，米 */
  arriveRadiusM?: number;
}

export interface TcpSettings {
  mode: string;
  address: string;
  port: number | null;
  hint: string;
  adminUrl: string;
  listening: boolean;
  version: string;
  certExpiresAt: string;
  database: DatabaseSettings | null;
  map: MapSettings;
  box: BoxSettings;
  labels?: Record<string, Record<string, string>>;
  security: SecuritySettings | null;
  smtp: SmtpSettings | null;
  video: VideoSettings | null;
  wechat?: WechatSettings | null;
  branding?: BrandingSettings;
  /** 当前用户能改哪些分区。 */
  can?: {
    map: boolean;
    labels: boolean;
    db: boolean;
    security: boolean;
    integration: boolean;
    box: boolean;
  };
}

/** 密码策略和登录锁定。classes：letter 字母、digit 数字、symbol 符号。 */
export interface SecuritySettings {
  minLength: number;
  classes: ("letter" | "digit" | "symbol")[];
  expireDays: number;
  lockThreshold: number;
  lockMinutes: number;
}

export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  secure: "none" | "ssl" | "starttls";
  user: string;
  passwordSet?: boolean;
  password?: string;
  fromName: string;
  fromAddress: string;
}

export interface VideoSettings {
  enabled: boolean;
  url: string;
  token?: string;
  tokenSet?: boolean;
  timeoutMs: number;
}

/** 系统名称和图标：网页、小程序都用。logo 是图片 data URL，空串表示用自带的默认图标。 */
export interface BrandingSettings {
  title: string;
  slogan: string;
  logo: string;
}

/** 微信小程序：AppSecret 只写不读，appSecretSet 表示已设置。 */
export interface WechatSettings {
  appId: string;
  appSecret?: string;
  appSecretSet?: boolean;
}

const SettingsAPI = {
  get() {
    return request<unknown, TcpSettings>({
      url: "/api/v1/system/settings",
      method: "get",
    });
  },
  saveDatabase(data: DatabaseInput) {
    return request<unknown, DatabaseSettings>({
      url: "/api/v1/system/settings/database",
      method: "put",
      data,
    });
  },
  saveMap(data: MapInput) {
    return request<unknown, MapSettings>({
      url: "/api/v1/system/settings/map",
      method: "put",
      data,
    });
  },
  saveBox(data: BoxSettings) {
    return request<unknown, BoxSettings>({
      url: "/api/v1/system/settings/box",
      method: "put",
      data,
    });
  },
  saveSecurity(data: SecuritySettings) {
    return request<unknown, SecuritySettings>({
      url: "/api/v1/system/settings/security",
      method: "put",
      data,
    });
  },
  saveSmtp(data: SmtpSettings) {
    return request<unknown, SmtpSettings>({
      url: "/api/v1/system/settings/smtp",
      method: "put",
      data,
    });
  },
  /** 带 to 发一封测试信，不带只验证连接和登录。 */
  testSmtp(data: SmtpSettings & { to?: string }) {
    return request<unknown, { sent: boolean }>({
      url: "/api/v1/system/settings/smtp/test",
      method: "post",
      data,
    });
  },
  saveVideo(data: VideoSettings) {
    return request<unknown, VideoSettings>({
      url: "/api/v1/system/settings/video",
      method: "put",
      data,
    });
  },
  /** 系统名称和图标，不用登录也能读（登录页要用）。 */
  branding() {
    return request<unknown, BrandingSettings>({ url: "/api/v1/branding", method: "get" });
  },
  saveBranding(data: Partial<BrandingSettings>) {
    return request<unknown, BrandingSettings>({
      url: "/api/v1/system/settings/branding",
      method: "put",
      data,
    });
  },
  saveWechat(data: WechatSettings) {
    return request<unknown, WechatSettings>({
      url: "/api/v1/system/settings/wechat",
      method: "put",
      data,
    });
  },
  testVideo(data: VideoSettings) {
    return request<unknown, { status: string; detail: string }>({
      url: "/api/v1/system/settings/video/test",
      method: "post",
      data,
    });
  },
  /** 密码规则说明，改密页和人员表单用。 */
  securityRule() {
    return request<unknown, { rule: string; policy: SecuritySettings }>({
      url: "/api/v1/system/settings/security-rule",
      method: "get",
    });
  },
  /** 所有登录用户都能读，只含显示名称。 */
  labels() {
    return request<unknown, Record<string, Record<string, string>>>({
      url: "/api/v1/system/labels",
      method: "get",
    });
  },
  saveLabels(data: Record<string, Record<string, string>>) {
    return request<unknown, Record<string, Record<string, string>>>({
      url: "/api/v1/system/settings/labels",
      method: "put",
      data,
    });
  },
};

export default SettingsAPI;
