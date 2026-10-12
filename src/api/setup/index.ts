import request from "@/utils/request";

export interface SetupForm {
  dialect: "sqlite" | "mysql";
  sqlitePath?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

export interface SetupStatus {
  installed: boolean;
  dialect?: string | null;
}

const SetupAPI = {
  status() {
    return request<unknown, SetupStatus>({
      url: "/api/v1/setup/status",
      method: "get",
      headers: { Authorization: "no-auth" },
    });
  },
  test(data: SetupForm) {
    return request({
      url: "/api/v1/setup/test",
      method: "post",
      data,
      headers: { Authorization: "no-auth" },
    });
  },
  install(data: SetupForm) {
    return request({
      url: "/api/v1/setup/install",
      method: "post",
      data,
      headers: { Authorization: "no-auth" },
    });
  },
};

export default SetupAPI;
