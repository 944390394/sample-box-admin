import request from "@/utils/request";

export interface DatabaseSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  passwordSet: boolean;
  /** 已配置标识（布尔，不含密码本体）；老服务端没有此键时回落 passwordSet。 */
  hasDbPassword?: boolean;
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
  /** 已配置标识（布尔，不含密钥本体）；老服务端没有此键时回落 tk/sk 是否有值。 */
  hasKey?: boolean;
  hasSecret?: boolean;
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
  /** 划拨/送检功能常开（组织简化后无开关）：服务端恒 true，旧客户端写入被忽略；键保留兼容。 */
  enableTransferInspect?: boolean;
  /** 建单后未上线的离线宽限，秒（B3/#18）：默认 3600。设置页以分钟展示（1–1440）。 */
  taskOfflineGraceSec?: number;
  /**
   * 唯一检测站部门 id（组织简化 P5）：合并采样单接收方固定为它。
   * 空串＝未配置（服务端按「总公司下恰一个启用检测站」自动认定）；
   * 保存走 saveBox，服务端 assertStationSavable 校验存在/启用/类型/总公司子树/全局唯一。
   */
  stationDeptId?: string;
  /**
   * 唯一检测站自动认定结果（只读，GET/saveBox 回读下发）：配置未指定且服务端自动认定成功时
   * {id,name}，否则 null；配置已指定时恒 null。老服务端没有此键（undefined），前端不显示提示。
   */
  stationAuto?: { id: string; name: string } | null;
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
    /** R21（062）：唯一检测站从 box（policyDefault）拆出；老服务端无此键 */
    station?: boolean;
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
  /** 已配置标识（布尔，不含密码本体）；老服务端没有此键时回落 passwordSet。 */
  hasPassword?: boolean;
  password?: string;
  fromName: string;
  fromAddress: string;
}

export interface VideoSettings {
  enabled: boolean;
  url: string;
  token?: string;
  tokenSet?: boolean;
  /** 已配置标识（布尔，不含令牌本体）；老服务端没有此键时回落 tokenSet。 */
  hasToken?: boolean;
  timeoutMs: number;
}

/** 系统名称和图标：网页、小程序都用。logo 是图片 data URL，空串表示用自带的默认图标。 */
export interface BrandingSettings {
  title: string;
  slogan: string;
  logo: string;
}

/** 微信小程序：AppSecret 只写不读，appSecretSet/hasAppSecret 表示已设置。 */
export interface WechatSettings {
  appId: string;
  appSecret?: string;
  appSecretSet?: boolean;
  /** 已配置标识（布尔，不含秘密本体）；老服务端没有此键时回落 appSecretSet。 */
  hasAppSecret?: boolean;
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
