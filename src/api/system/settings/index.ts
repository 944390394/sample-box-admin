import request from "@/utils/request";

export interface TcpSettings {
  address: string;
  port: number;
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
