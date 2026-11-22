import type { RouteRecordRaw } from "vue-router";
import { Layout } from "@/router";

/**
 * 划拨独立页的前端本地菜单＋送检旧链接重定向。
 *
 * 侧栏菜单 normally 由 server/menus.js 经 GET /menus/routes 下发；划拨页的菜单与路由
 * 在前端注入（permission store 生成动态路由时合并进去），插在「任务单」组之后，
 * 对齐批准基准的 NAV 顺序：工作台 → 任务单 → 调拨单 → 采样箱。
 *
 * R12 门禁（R24 收紧）：调拨单只有划拨建单权限的人才能看到——gate = task:create:transfer 单码，
 * 与服务端 transfers/transferDetail handler 及 menus.js 预览镜像同一口径。task:transfer:revoke
 * 随撤销功能下线退出门禁（撤销是调度员在这页唯一的动作，码留着也点不到东西）。功能常开（组织简化后无开关），
 * 不再看 enableTransferInspect；旧 gate device:box:task 太宽（值守/核验/只读领导都有），已收紧。
 *
 * 组织简化（P9）：采样＋送检合并成一张 TK 单，送检独立页退役。旧链接 /sample/inspections
 * 保留一条隐藏重定向到 /task/tasks（防旧书签/深链 404），不再注入侧栏菜单。
 * 路由用绝对子路径（/sample/transfers），与页面内跳转/深链一致；
 * 划拨详情复用 /sample/transfers/:id，任务详情复用服务端菜单已有的 /task/detail/:id。
 */
const TransferList = () => import("@/views/sample/transfer/index.vue");
const TransferDetail = () => import("@/views/sample/transfer/detail.vue");

/** 调拨单可见权限：R24 撤销下线后只看「新建划拨」（与服务端 handler、菜单预览镜像同口径）。 */
export const TRANSFER_VIEW_PERMS = ["task:create:transfer"];

export interface LocalMenuGate {
  /** 当前用户权限码集合。 */
  perms: string[];
}

export function buildLocalMenus(gate: LocalMenuGate): RouteRecordRaw[] {
  const groups: RouteRecordRaw[] = [
    // 送检单退役重定向：恒存在（不受权限影响），隐藏不进侧栏，旧链接落到任务单页。
    {
      path: "/sample/inspections",
      redirect: "/task/tasks",
      name: "SampleInspectionsRedirect",
      meta: { title: "送检单", hidden: true },
    } as RouteRecordRaw,
  ];
  const canView = TRANSFER_VIEW_PERMS.some((code) => gate.perms.includes(code));
  if (canView) {
    groups.push({
      path: "/transfer",
      component: Layout,
      redirect: "/sample/transfers",
      name: "SampleTransferGroup",
      meta: {
        title: "调拨单",
        icon: "el-icon-Sort",
        hidden: false,
        alwaysShow: false,
        perm: TRANSFER_VIEW_PERMS,
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
            perm: TRANSFER_VIEW_PERMS,
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
            perm: TRANSFER_VIEW_PERMS,
            params: undefined,
          },
        },
      ],
    });
  }
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
