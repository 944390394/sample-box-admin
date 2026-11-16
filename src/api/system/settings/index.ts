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

export interface ProductMap {
  tk: string;
  sk: string;
  skSet: boolean;
  clearSk?: boolean;
}

export interface ProductPolicy {
  reportIntervalSec: number;
  scheduledReport: boolean;
  batteryPercent: number;
  arrivalRadiusM: number;
}

export interface ProductBrand {
  name: string;
  title: string;
  logoDataUrl: string;
}

export interface ProductLabels {
  lifePending: string;
  lifeIdle: string;
  uplinkBoot: string;
  uplinkTimer: string;
  lidOpen: string;
  lidShut: string;
  chargeIdle: string;
  chargeOn: string;
  online: string;
  offline: string;
  ledMcu: string;
  ledModem: string;
}

export interface ProductSecurity {
  idleMinutes: number;
  passwordMin: number;
  lockAfter: number;
}

export interface ProductIntegration {
  webhookEnabled: boolean;
  webhookUrl: string;
}

export interface ProductSettings {
  map: ProductMap;
  policy: ProductPolicy;
  brand: ProductBrand;
  labels: ProductLabels;
  security: ProductSecurity;
  integration: ProductIntegration;
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
  database: DatabaseSettings;
  product: ProductSettings;
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
  saveProduct(data: Partial<ProductSettings>) {
    return request<unknown, ProductSettings>({
      url: "/api/v1/system/settings/product",
      method: "put",
      data,
    });
  },
  brand() {
    return request<unknown, ProductBrand>({
      url: "/api/v1/system/brand",
      method: "get",
      headers: { Authorization: "no-auth" },
      silent: true,
    });
  },
};

export default SettingsAPI;
