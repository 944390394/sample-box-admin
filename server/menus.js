/**
 * 侧栏菜单。真实模式和 mock 共用这一份。
 * 工作台、任务单、采样箱、实时地图是一级菜单（分组只有一个可见子项、alwaysShow 为假时侧栏直接显示子项）；
 * 组织、系统是分组。meta.perm 列出能看到这一项的权限码，任意一个即可，没写的人人可见。
 */

import { boxPermTree, viewPermTree, LOG_PERMS } from "./src/auth/permCatalog.js";

function menu(path, component, name, title, icon, hidden = false, extra = {}) {
  return {
    path,
    component,
    name,
    meta: { title, icon, hidden, keepAlive: !hidden, alwaysShow: false, params: null, ...extra },
  };
}

function group(path, title, icon, redirect, children, alwaysShow = true) {
  return {
    path,
    component: "Layout",
    redirect,
    name: path,
    meta: { title, icon, hidden: false, alwaysShow, params: null },
    children,
  };
}

const TASK = ["device:box:task"];
/** 系统设置页：有任意一块的查看或修改权限就能进。 */
export const SETTINGS = [
  "sys:settings:view",
  "sys:settings:map",
  "sys:settings:branding",
  "sys:settings:labels",
  "sys:settings:db",
  "sys:settings:password",
  "sys:settings:lockout",
  "sys:settings:smtp",
  "sys:settings:video",
  "sys:settings:wechat",
  "device:box:policyDefault",
  "sys:settings:battery-reserve",
  "sys:settings:arrive-radius",
];
const BOX = ["device:box:list"];

export const menuRoutes = [
  group(
    "/monitor",
    "工作台",
    "el-icon-Odometer",
    "/monitor/home",
    [
      menu("home", "sample/home/index", "SampleHome", "工作台", "el-icon-Odometer", false, {
        affix: true,
      }),
    ],
    false
  ),
  // 总览：集团看各分公司、检测站，点进去是单位总览；只能看到一个单位的人直接进自己的单位
  group(
    "/overview",
    "总览",
    "el-icon-DataBoard",
    "/monitor/overview",
    [
      menu(
        "/monitor/overview",
        "sample/overview/index",
        "SampleOverview",
        "总览",
        "el-icon-DataBoard",
        false,
        { perm: ["monitor:overview"] }
      ),
      menu(
        "/monitor/overview/:orgId",
        "sample/overview/unit",
        "SampleOverviewUnit",
        "单位总览",
        "el-icon-DataBoard",
        true,
        { activeMenu: "/monitor/overview", perm: ["monitor:overview"] }
      ),
    ],
    false
  ),
  group(
    "/task",
    "任务单",
    "el-icon-Document",
    "/task/tasks",
    [
      menu("tasks", "sample/tasks/index", "SampleTasks", "任务单", "el-icon-Document", false, {
        perm: TASK,
      }),
      menu(
        "create",
        "sample/tasks/create",
        "SampleTaskCreate",
        "创建任务单",
        "el-icon-Plus",
        true,
        { activeMenu: "/task/tasks", perm: ["task:create:transfer", "task:create:sample"] }
      ),
      menu(
        "detail/:id",
        "sample/tasks/detail",
        "SampleTaskDetail",
        "任务详情",
        "el-icon-Document",
        true,
        { activeMenu: "/task/tasks", perm: TASK }
      ),
    ],
    false
  ),
  group(
    "/device",
    "采样箱",
    "el-icon-Box",
    "/device/boxes",
    [
      menu("boxes", "sample/boxes/index", "SampleBoxes", "采样箱", "el-icon-Box", false, {
        perm: BOX,
      }),
      menu(
        "boxes/:id",
        "sample/boxes/detail",
        "SampleBoxDetail",
        "采样箱详情",
        "el-icon-Box",
        true,
        { activeMenu: "/device/boxes", perm: ["device:box:detail"] }
      ),
      // USB 串口读取：数据直接从插在电脑上的箱子读，不经过服务器。入口在采样箱列表页头
      menu(
        "serial",
        "sample/serial/index",
        "SampleSerial",
        "USB 串口读取",
        "el-icon-Connection",
        true,
        { activeMenu: "/device/boxes", perm: BOX }
      ),
    ],
    false
  ),
  group(
    "/live",
    "实时地图",
    "el-icon-MapLocation",
    "/monitor/screen",
    [
      menu(
        "/monitor/screen",
        "sample/screen/index",
        "SampleScreen",
        "实时地图",
        "el-icon-MapLocation",
        false,
        { perm: BOX }
      ),
    ],
    false
  ),
  group("/organization", "组织管理", "el-icon-OfficeBuilding", "/system/dept", [
    menu("/system/dept", "system/dept/index", "Dept", "部门", "el-icon-OfficeBuilding", false, {
      perm: [
        "sys:dept:view",
        "sys:dept:create",
        "sys:dept:update",
        "sys:dept:type",
        "sys:dept:address",
        "sys:dept:camera",
        "sys:dept:leader",
        "sys:dept:delete",
      ],
    }),
    menu("/system/user", "system/user/index", "User", "人员", "el-icon-User", false, {
      perm: [
        "sys:user:view",
        "sys:user:create",
        "sys:user:update",
        "sys:user:disable",
        "sys:user:enable",
        "sys:user:delete",
      ],
    }),
    menu("/system/role", "system/role/index", "Role", "角色与权限", "role", false, {
      perm: [
        "sys:role:view",
        "sys:role:create",
        "sys:role:update",
        "sys:role:delete",
        "sys:role:grant",
        "sys:role:scope",
      ],
    }),
  ]),
  group("/system", "系统管理", "el-icon-Setting", "/system/settings", [
    menu(
      "settings",
      "system/settings/index",
      "SystemSettings",
      "系统设置",
      "el-icon-Setting",
      false,
      {
        perm: SETTINGS,
      }
    ),
    menu(
      "/system/operation-log",
      "system/operation-log/index",
      "OperationLog",
      "操作日志",
      "el-icon-Document",
      false,
      { perm: ["sys:oplog:read"] }
    ),
    menu(
      "/system/runtime-log",
      "system/runtime-log/index",
      "SystemRuntimeLog",
      "系统日志",
      "el-icon-Warning",
      false,
      { perm: ["sys:runtime-log:read"] }
    ),
  ]),
];

/** 按权限裁剪：子项没权限就去掉，分组里一个可见子项都不剩就整组去掉。 */
export function menusFor(perms) {
  const allowed = (item) => !item.meta?.perm || item.meta.perm.some((code) => perms.has(code));
  return menuRoutes
    .map((route) => ({ ...route, children: route.children.filter(allowed) }))
    .filter((route) => route.children.some((item) => !item.meta.hidden));
}

/**
 * 旧角色页权限树用的菜单编号。按路由名写死，挪分组、加菜单都不会撞号。
 * 菜单编号本身不入库，入库的只有权限码。
 */
const MENU_IDS = {
  SampleHome: 100,
  SampleOverview: 102,
  SampleOverviewUnit: 103,
  SampleTasks: 200,
  SampleBoxes: 300,
  SampleScreen: 101,
  Dept: 403,
  User: 400,
  Role: 402,
  SystemSettings: 401,
  OperationLog: 404,
  SystemRuntimeLog: 405,
};
export const menuOptions = menuRoutes.map((route, groupIndex) => ({
  value: groupIndex + 1,
  label: route.meta.title,
  children: route.children
    .filter((item) => !item.meta.hidden)
    .map((item) => {
      const node = { value: MENU_IDS[item.name] ?? 900 + groupIndex, label: item.meta.title };
      if (item.name === "SampleBoxes") node.children = boxPermTree();
      if (item.name === "SampleHome") node.children = viewPermTree();
      if (item.name === "SystemRuntimeLog")
        node.children = LOG_PERMS.map((perm) => ({
          value: perm.id,
          label: perm.label,
          code: perm.code,
        }));
      return node;
    }),
}));
