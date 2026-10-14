import request from "@/utils/request";

export interface TcpSettings {
  mode: string;
  address: string;
  port: number | null;
  hint: string;
  adminUrl: string;
  listening: boolean;
  version: string;
  certExpiresAt: string;
}

const SettingsAPI = {
  get() {
    return request<unknown, TcpSettings>({
      url: "/api/v1/system/settings",
      method: "get",
    });
  },
};

export default SettingsAPI;
