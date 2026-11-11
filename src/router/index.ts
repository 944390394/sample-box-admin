import type { App } from "vue";
import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";

export const Layout = () => import("@/layouts/index.vue");

// 静态路由
export const constantRoutes: RouteRecordRaw[] = [
  {
    path: "/redirect",
    component: Layout,
    meta: { hidden: true },
    children: [
      {
        path: "/redirect/:path(.*)",
        component: () => import("@/views/redirect.vue"),
      },
    ],
  },

  {
    path: "/login",
    component: () => import("@/views/login/index.vue"),
    meta: { hidden: true },
  },

  {
    path: "/force-password",
    component: () => import("@/views/login/ForcePassword.vue"),
    meta: { hidden: true },
  },

  // 旧页面并进了新页面：上报记录、调试记录都在采样箱详情的「上报记录」里
  { path: "/monitor/reports", redirect: "/device/boxes", meta: { hidden: true } },
  {
    path: "/device/boxes/:id/debug",
    redirect: (to) => ({ path: `/device/boxes/${String(to.params.id)}`, query: { tab: "log" } }),
    meta: { hidden: true },
  },

  {
    path: "/setup",
    component: () => import("@/views/setup/index.vue"),
    meta: { hidden: true },
  },

  {
    path: "/",
    name: "/",
    component: Layout,
    // 进系统直接到工作台
    redirect: "/monitor/home",
    children: [
      {
        path: "401",
        component: () => import("@/views/error/401.vue"),
        meta: { hidden: true },
      },
      {
        path: "404",
        component: () => import("@/views/error/404.vue"),
        meta: { hidden: true },
      },
      {
        path: "profile",
        name: "Profile",
        component: () => import("@/views/profile/index.vue"),
        meta: { title: "个人中心", icon: "user", hidden: true },
      },
    ],
  },
];

/**
 * 创建路由
 */
const router = createRouter({
  history: createWebHashHistory(),
  routes: constantRoutes,
  // 刷新时，滚动条位置还原
  scrollBehavior: () => ({ left: 0, top: 0 }),
});

// 全局注册 router
export function setupRouter(app: App<Element>) {
  app.use(router);
}

export default router;
