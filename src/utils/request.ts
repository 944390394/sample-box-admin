import axios, { type InternalAxiosRequestConfig, type AxiosResponse } from "axios";
import qs from "qs";
import { reportDiagnostic } from "@/utils/diagnostics";

import { ApiCodeEnum } from "@/enums/api";
import { useUserStoreHook } from "@/stores/user";
import { usePermissionStoreHook } from "@/stores/permission";
import { AuthStorage, redirectToLogin } from "@/utils/auth";
import type { ApiResult } from "@/api/common";

declare module "axios" {
  interface AxiosRequestConfig {
    /** 为 true 时失败不弹全局提示，由调用方自己处理 */
    silent?: boolean;
    diagnosticStart?: number;
    authRetried?: boolean;
  }
}

// 防止同一请求在 token 刷新后重复进入重试，导致死循环
async function handleExpired(config: InternalAxiosRequestConfig | undefined, code: string) {
  if (code === ApiCodeEnum.REFRESH_TOKEN_INVALID || !config || config.authRetried) {
    await redirectToLogin("登录已过期，请重新登录");
    throw new Error("登录已过期，请重新登录");
  }
  config.authRetried = true;
  try {
    await useUserStoreHook().refreshTokenOnce();
    config.headers.set("Authorization", `Bearer ${AuthStorage.getAccessToken()}`);
  } catch {
    await redirectToLogin("登录已过期，请重新登录");
    throw new Error("登录已过期，请重新登录");
  }
  return http(config);
}

const http = axios.create({
  baseURL: import.meta.env.VITE_APP_BASE_API,
  timeout: 50000,
  headers: { "Content-Type": "application/json;charset=utf-8" },
  // 数组参数序列化为 ids=1&ids=2，而非 ids[]=1&ids[]=2
  paramsSerializer: (params) => qs.stringify(params, { arrayFormat: "repeat" }),
});

http.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    config.diagnosticStart = performance.now();
    const token = AuthStorage.getAccessToken();

    // 约定：调用方设置 Authorization 为 "no-auth" 即跳过 token 注入
    if (config.headers.Authorization === "no-auth") {
      delete config.headers.Authorization;
    } else if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    return config;
  },
  (error) => Promise.reject(error)
);

http.interceptors.response.use(
  (response: AxiosResponse<ApiResult>): AxiosResponse | any => {
    const { responseType } = response.config;
    const duration = performance.now() - (response.config.diagnosticStart || performance.now());
    if (duration >= 2000)
      reportDiagnostic({
        kind: "slow",
        message: "浏览器请求耗时超过2000ms（含网络传输）",
        duration,
        path: response.config.url,
        method: response.config.method,
        requestId: response.headers["x-request-id"],
      });

    // 二进制数据直接透传
    if (responseType === "blob" || responseType === "arraybuffer") {
      return response;
    }

    const { code, data, msg } = response.data;

    if (code === ApiCodeEnum.ACCESS_TOKEN_INVALID || code === ApiCodeEnum.REFRESH_TOKEN_INVALID)
      return handleExpired(response.config, code);

    if (code === ApiCodeEnum.SUCCESS) {
      return data;
    }

    reportDiagnostic({
      kind: "request_failed",
      message: msg || "系统出错",
      duration,
      path: response.config.url,
      method: response.config.method,
      requestId: response.headers["x-request-id"],
      code,
    });
    if (!response.config.silent)
      ElMessage.error(
        `${msg || "系统出错"}${response.headers["x-request-id"] ? `（请求编号 ${response.headers["x-request-id"]}）` : ""}`
      );
    return Promise.reject(new Error(msg || "系统出错"));
  },

  async (error) => {
    const { config, response } = error;
    const businessCode = response?.data?.code;
    if (
      businessCode === ApiCodeEnum.ACCESS_TOKEN_INVALID ||
      businessCode === ApiCodeEnum.REFRESH_TOKEN_INVALID
    )
      return handleExpired(config, businessCode);
    const requestId = response?.headers?.["x-request-id"];
    reportDiagnostic({
      kind: "request_failed",
      message: response?.data?.msg || error.message || "网络请求失败",
      duration: config?.diagnosticStart ? performance.now() - config.diagnosticStart : undefined,
      path: config?.url,
      method: config?.method,
      requestId,
      status: response?.status,
      code: error.code,
    });

    if (!response) {
      if (!config?.silent) ElMessage.error("网络连接失败");
      return Promise.reject(error);
    }

    const { code, msg } = response.data as ApiResult;

    // 须先改密：管理员要求或密码到期，跳到改密页
    if (code === "A0240") {
      if (!window.location.hash.startsWith("#/force-password"))
        window.location.hash = "#/force-password";
      return Promise.reject(new Error(msg || "请先修改密码"));
    }

    // 权限不足
    if (code === ApiCodeEnum.PERMISSION_DENIED) {
      const permissionStore = usePermissionStoreHook();
      await permissionStore.refreshPermissions();
      ElMessage.error(msg || "权限不足");
      return Promise.reject(new Error(msg || "权限不足"));
    }

    if (!config?.silent)
      ElMessage.error(`${msg || "请求失败"}${requestId ? `（请求编号 ${requestId}）` : ""}`);
    return Promise.reject(new Error(msg || "请求失败"));
  }
);

export default http;
