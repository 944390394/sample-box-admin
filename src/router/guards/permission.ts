import { createRouterMatcher } from "vue-router";
import type { RouteRecordRaw } from "vue-router";
import NProgress from "@/plugins/nprogress";
import router from "@/router";
import SetupAPI from "@/api/setup";
import { usePermissionStore, useUserStore } from "@/stores";
import { useTenantStoreHook } from "@/stores/tenant";
import { isTenantEnabled } from "@/utils/tenant";
import { loadLabels } from "@/utils/labels";

const mockOn = import.meta.env.VITE_MOCK_DEV_SERVER === "true";
let setupInstalled: boolean | null = null;

/** 安装完成后放行，避免守卫仍认为数据库未安装。 */
export function markSetupInstalled(installed = true) {
  setupInstalled = installed;
}

/**
 * 路由权限守卫
 *
 * 处理登录验证、动态路由生成、404检测等
 */
export function setupPermissionGuard() {
  const whiteList = ["/login", "/setup"];

  router.beforeEach(async (to, _from) => {
    NProgress.start();

    try {
      if (!mockOn) {
        if (setupInstalled === null) {
          try {
            setupInstalled = (await SetupAPI.status()).installed;
          } catch {
            // 请求失败不能判定为未安装，下次导航重新检查。
            setupInstalled = null;
          }
        }
        if (setupInstalled === false && to.path !== "/setup") {
          NProgress.done();
          return "/setup";
        }
        if (setupInstalled && to.path === "/setup") {
          NProgress.done();
          return useUserStore().isLoggedIn() ? "/" : "/login";
        }
      }

      const isLoggedIn = useUserStore().isLoggedIn();

      // 未登录处理
      if (!isLoggedIn) {
        if (whiteList.includes(to.path)) {
          return;
        }
        NProgress.done();
        return `/login?redirect=${encodeURIComponent(to.fullPath)}`;
      }

      // 已登录访问登录页，重定向到首页
      if (to.path === "/login") {
        return { path: "/" };
      }

      const permissionStore = usePermissionStore();
      const userStore = useUserStore();

      // 须先改密的账号只能停在改密页
      if (to.path === "/force-password") return;
      if (!userStore.userInfo?.roles?.length) await userStore.getUserInfo();
      if (userStore.userInfo?.passwordChange) {
        NProgress.done();
        return "/force-password";
      }

      // 动态路由生成
      if (!permissionStore.isRouteGenerated) {
        await ensureRoutesGenerated();
        return { ...to, replace: true };
      }

      // 路由 404 检查
      if (to.matched.length === 0) {
        // 从登录页跳转且目标路径无效，回退首页（避免不同用户权限不同导致的 404）
        if (_from.path === "/login") {
          return { path: "/", replace: true };
        }
        return "/404";
      }

      // 动态标题
      const title = (to.params.title as string) || (to.query.title as string);
      if (title) {
        to.meta.title = title;
      }
    } catch (error) {
      console.error("Route guard error:", error);
      await useUserStore().resetAllState();
      NProgress.done();
      return "/login";
    }
  });

  router.afterEach(() => {
    NProgress.done();
  });
}

/** 初始化多租户上下文，未启用或失败时静默跳过 */
async function initTenantContext(): Promise<void> {
  if (!isTenantEnabled()) return;

  try {
    await useTenantStoreHook().loadTenant();
  } catch {
    // 静默失败，不影响主流程
  }
}

/**
 * 按当前登录角色生成并注册动态路由（幂等）。
 * 守卫首次导航与登录落地校验共用这一份，保证用户信息、标签、租户上下文
 * 与路由注册的先后顺序只有一处定义。
 */
export async function ensureRoutesGenerated(): Promise<void> {
  const permissionStore = usePermissionStore();
  const userStore = useUserStore();
  if (permissionStore.isRouteGenerated) return;
  if (!userStore.userInfo?.roles?.length) {
    await userStore.getUserInfo();
  }
  void loadLabels();

  // 加载用户租户列表（VITE_APP_TENANT_ENABLED=true 时生效）
  await initTenantContext();

  const dynamicRoutes = await permissionStore.generateRoutes();
  dynamicRoutes.forEach((route: RouteRecordRaw) => {
    router.addRoute(route);
  });
}

/** 登录落地兜底地址：工作台。 */
const LOGIN_FALLBACK = "/monitor/home";

/**
 * 登录成功后的落地地址清洗。
 * 退出登录会把上一角色的当前页带进 redirect（如领导的 /system/user），
 * 换角色登录后该地址可能不在新角色的路由表里：直接 push 会 no-match
 * （VUE_ROUTER_R0004），不可路由地址还会留在 history.back 里，把页头
 * 「返回」的 router.back() 带进死胡同。这里先按新角色生成路由，再校验
 * 目标可达（能匹配到已注册路由＝菜单/权限允许），不可达回落工作台。
 * 探测用路由器同款匹配器工厂而不是 router.resolve，避免对不可达地址
 * 触发 no-match 警告；干净流程（redirect 可路由）原样落地。
 */
export async function resolveLoginRedirect(redirect: unknown): Promise<string> {
  const raw = typeof redirect === "string" ? redirect.trim() : "";
  if (!raw) return LOGIN_FALLBACK;
  let target: string;
  try {
    target = decodeURIComponent(raw).trim();
  } catch {
    return LOGIN_FALLBACK;
  }
  // 只接受站内绝对路径；外链与协议相对地址（//host）一律回落
  if (!target.startsWith("/") || target.startsWith("//")) return LOGIN_FALLBACK;
  try {
    await ensureRoutesGenerated();
    const path = target.split("#")[0].split("?")[0];
    // getRoutes() 返回规范化记录，喂回匹配器工厂时按原始记录类型适配
    const matcher = createRouterMatcher(router.getRoutes() as unknown as RouteRecordRaw[], {});
    const { matched } = matcher.resolve(
      { path },
      { name: undefined, path: "/", params: {}, matched: [], meta: {} }
    );
    return matched.length > 0 ? target : LOGIN_FALLBACK;
  } catch {
    // 路由生成/校验失败不挡登录：先落工作台，守卫会重试或兜底
    return LOGIN_FALLBACK;
  }
}
