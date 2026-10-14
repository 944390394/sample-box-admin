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
};

export default SettingsAPI;
