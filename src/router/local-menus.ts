import type { RouteRecordRaw } from "vue-router";
import { Layout } from "@/router";

/**
 * 划拨/送检独立页的前端本地菜单。
 *
 * 侧栏菜单 normally 由 server/menus.js 经 GET /menus/routes 下发；本批不改 server/**，
 * 所以这两个新页的菜单与路由在前端注入（permission store 生成动态路由时合并进去），
 * 按功能开关 enableTransferInspect + 权限 gating，插在「任务单」组之后，对齐批准基准的
 * NAV 顺序：工作台 → 任务单 → 调拨单 → 送检单 → 采样箱。
 *
 * 路由用绝对子路径（/sample/transfers、/sample/inspections），与页面内跳转/深链一致；
 * 送检详情复用任务详情页 /task/detail/:id（服务端菜单已有），这里不重复注册。
 */
const TransferList = () => import("@/views/sample/transfer/index.vue");
const TransferDetail = () => import("@/views/sample/transfer/detail.vue");
const InspectList = () => import("@/views/sample/inspect/index.vue");

export interface LocalMenuGate {
  /** 功能开关（服务端 box.enableTransferInspect）。 */
  enabled: boolean;
  /** 当前用户权限码集合。 */
  perms: string[];
}

export function buildLocalMenus(gate: LocalMenuGate): RouteRecordRaw[] {
  if (!gate.enabled) return [];
  const canView = gate.perms.includes("device:box:task");
  if (!canView) return [];
  const groups: RouteRecordRaw[] = [
    {
      path: "/transfer",
      component: Layout,
      redirect: "/sample/transfers",
      name: "SampleTransferGroup",
      meta: {
        title: "调拨单",
        icon: "el-icon-Sort",
        hidden: false,
        alwaysShow: false,
        params: undefined,
      },
      children: [
        {
          path: "/sample/transfers",
          component: TransferList,
          name: "SampleTransfers",
          meta: {
            title: "调拨单",
            icon: "el-icon-Sort",
            hidden: false,
            keepAlive: true,
            alwaysShow: false,
            params: undefined,
          },
        },
        {
          path: "/sample/transfers/:id",
          component: TransferDetail,
          name: "SampleTransferDetail",
          meta: {
            title: "划拨单详情",
            icon: "el-icon-Sort",
            hidden: true,
            keepAlive: false,
            activeMenu: "/sample/transfers",
            params: undefined,
          },
        },
      ],
    },
    {
      path: "/inspect",
      component: Layout,
      redirect: "/sample/inspections",
      name: "SampleInspectGroup",
      meta: {
        title: "送检单",
        icon: "el-icon-Checked",
        hidden: false,
        alwaysShow: false,
        params: undefined,
      },
      children: [
        {
          path: "/sample/inspections",
          component: InspectList,
          name: "SampleInspections",
          meta: {
            title: "送检单",
            icon: "el-icon-Checked",
            hidden: false,
            keepAlive: true,
            alwaysShow: false,
            params: undefined,
          },
        },
      ],
    },
  ];
  return groups;
}

/** 把本地菜单插到「任务单」组（/task）之后；找不到就追加到末尾。 */
export function mergeLocalMenus(
  serverRoutes: RouteRecordRaw[],
  local: RouteRecordRaw[]
): RouteRecordRaw[] {
  if (!local.length) return serverRoutes;
  const index = serverRoutes.findIndex((r) => r.path === "/task");
  const at = index >= 0 ? index + 1 : serverRoutes.length;
  return [...serverRoutes.slice(0, at), ...local, ...serverRoutes.slice(at)];
}
