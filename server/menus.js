/** 关闭 mock 后，侧栏与前端菜单保持同一套分组。 */

function menu(path, component, name, title, icon, hidden = false, extra = {}) {
  return {
    path,
    component,
    name,
    meta: { title, icon, hidden, keepAlive: !hidden, alwaysShow: false, params: null, ...extra },
  };
}

function group(path, title, icon, redirect, children) {
  return {
    path,
    component: "Layout",
    redirect,
    name: path,
    meta: { title, icon, hidden: false, alwaysShow: true, params: null },
    children,
  };
}

export const menuRoutes = [
  group("/monitor", "监测", "el-icon-Odometer", "/monitor/home", [
    menu("home", "sample/home/index", "SampleHome", "状态首页", "el-icon-Odometer"),
    menu("screen", "sample/screen/index", "SampleScreen", "数据大屏", "el-icon-Monitor"),
    menu("alerts", "sample/alerts/index", "SampleAlerts", "异常告警", "el-icon-Bell"),
    menu("reports", "sample/reports/index", "SampleReports", "上报记录", "el-icon-List"),
    menu(
      "assistant",
      "sample/assistant/index",
      "SampleAssistant",
      "监测对话",
      "el-icon-ChatDotRound"
    ),
  ]),
  group("/task", "任务", "el-icon-Document", "/task/tasks", [
    menu("tasks", "sample/tasks/index", "SampleTasks", "任务单", "el-icon-Document"),
    menu("create", "sample/tasks/create", "SampleTaskCreate", "创建任务单", "el-icon-Plus", true),
    menu("receive", "sample/receive/index", "SampleReceive", "总部核验", "el-icon-Checked"),
  ]),
  group("/device", "设备", "el-icon-Box", "/device/boxes", [
    menu("boxes", "sample/boxes/index", "SampleBoxes", "采样箱", "el-icon-Box"),
    menu("boxes/:id", "sample/boxes/detail", "SampleBoxDetail", "采样箱详情", "el-icon-Box", true, {
      activeMenu: "/device/boxes",
    }),
    menu("commands", "sample/commands/index", "SampleCommands", "指令队列", "el-icon-Promotion"),
  ]),
  group("/system", "系统管理", "system", "/system/user", [
    menu("user", "system/user/index", "User", "用户管理", "el-icon-User"),
    menu("role", "system/role/index", "Role", "角色管理", "role"),
    menu("dept", "system/dept/index", "Dept", "部门管理", "el-icon-OfficeBuilding"),
  ]),
];

const boxPermNodes = [
  { value: 9101, label: "查看详情" },
  { value: 9102, label: "查看事件" },
  { value: 9103, label: "查看日志" },
  { value: 9104, label: "查看关联任务" },
  { value: 9105, label: "激活" },
  { value: 9106, label: "停用与恢复" },
];

export const menuOptions = menuRoutes.map((route, groupIndex) => ({
  value: groupIndex + 1,
  label: route.meta.title,
  children: route.children
    .filter((item) => !item.meta.hidden)
    .map((item, index) => {
      const node = { value: (groupIndex + 1) * 100 + index, label: item.meta.title };
      if (item.name === "SampleBoxes") node.children = boxPermNodes;
      return node;
    }),
}));
