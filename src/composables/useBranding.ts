import SettingsAPI, { type BrandingSettings } from "@/api/system/settings";
import defaultLogo from "@/assets/images/logo.png";
import { appConfig } from "@/settings";

/**
 * 系统名称和图标（系统设置 › 名称与图标）。登录页、侧栏、浏览器标签都从这里取；
 * 第一次用到时从服务端读一次，读不到就用打包时的默认名称和图标。保存设置后调 applyBranding 立即生效。
 */
const state = reactive<BrandingSettings>({ title: appConfig.title, slogan: "", logo: "" });
let loading: Promise<void> | null = null;

export function applyBranding(next: Partial<BrandingSettings>) {
  Object.assign(state, next);
  document.title = state.title;
}

export function useBranding() {
  if (!loading) {
    loading = SettingsAPI.branding()
      .then((data) => applyBranding(data))
      .catch(() => undefined);
  }
  return {
    branding: readonly(state),
    logoUrl: computed(() => state.logo || defaultLogo),
  };
}
