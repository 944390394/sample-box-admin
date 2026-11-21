import "vue-router";

declare module "vue-router" {
  /**
   * 项目路由元信息扩展
   */
  interface RouteMeta {
    title?: string;
    type?: string;
    icon?: string;
    hidden?: boolean;
    alwaysShow?: boolean;
    affix?: boolean;
    keepAlive?: boolean;
    breadcrumb?: boolean;
    activeMenu?: string;
    params?: Record<string, unknown>;
    externalUrl?: string;
    roles?: string[];
    /** 可见权限码（任一即可）：服务端菜单裁剪与本地注入菜单同口径声明。 */
    perm?: string[];
  }
}
