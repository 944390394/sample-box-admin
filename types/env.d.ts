/// <reference types="vite/client" />

/**
 * Vite 环境变量类型定义
 */
interface ImportMetaEnv {
  readonly VITE_APP_PORT: string;
  readonly VITE_APP_BASE_API: string;
  readonly VITE_APP_API_URL: string;
  readonly VITE_APP_TITLE?: string;
  readonly VITE_APP_TENANT_ENABLED?: string;
  readonly VITE_MOCK_DEV_SERVER: string;
  /** 天地图浏览器端应用密钥 tk */
  readonly VITE_TIANDITU_TK?: string;
  /** 天地图浏览器端安全密钥，瓦片请求要带上 */
  readonly VITE_TIANDITU_SK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_INFO__: {
  pkg: {
    name: string;
    version: string;
  };
  buildTimestamp: number;
};
