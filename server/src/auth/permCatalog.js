/**
 * 全站权限目录（迁移 045 起）。规则：
 * - 一项只管一件事，名称和说明写清「能进哪页 / 能看到什么 / 能做什么」，不用「等」带过；
 * - 按页面分模块，每个模块分三段：enter 能进这页、see 能看到什么、do 能做什么，和菜单一一对应；
 * - needs 是前置：列出的任意一项有了，这一项才用得上。角色页勾选时自动补上第一项，取消前置时连带取消；
 * - 数字编号给旧的菜单权限树用：9101–9302 是早先发出去的，不能改；新项从各段空号往后排。
 *
 * 实际权限 =（角色权限之和）∩（从顶级到所在部门每一级的「权限上限」），见 boxAccess.resolveAccess。
 */

const TASK_ENTER = ["device:box:task"];
const BOX_ANY = ["device:box:list", "device:box:detail", "device:box:task"];
const BOX_DETAIL = ["device:box:detail"];

function item(id, code, label, hint, module, tier, needs) {
  return { id, code, label, hint, module, tier, ...(needs ? { needs } : {}) };
}

/** 模块：和左侧菜单对应，顺序就是角色页的顺序。 */
export const PERM_MODULES = [
  {
    key: "workbench",
    label: "工作台",
    hint: "工作台上显示哪几张卡片。卡片里有没有内容，还要看对应的查看权限",
  },
  { key: "task", label: "任务单", hint: "调拨、采样任务的查看、新建和每一步推进" },
  { key: "box", label: "采样箱", hint: "采样箱清单、详情、实时地图里能看到和能做的" },
  { key: "overview", label: "总览", hint: "集团总览和单位总览" },
  { key: "dept", label: "组织 · 部门", hint: "部门树的查看和维护" },
  { key: "user", label: "组织 · 人员", hint: "人员的查看和维护" },
  { key: "security", label: "账号安全", hint: "管别人账号的登录状态，每个动作单独授予" },
  {
    key: "grant",
    label: "授权",
    hint: "谁能决定别人有什么权限。能授哪几项还要看「可转授」和部门上限",
  },
  { key: "settings", label: "系统设置", hint: "系统设置页里每一块单独授予" },
  { key: "log", label: "日志", hint: "操作日志和系统日志" },
];

export const TIER_LABELS = { enter: "能进这页", see: "能看到什么", do: "能做什么" };

export const CARD_PERMS = [
  item(
    9701,
    "monitor:card:send",
    "「待寄出」卡片",
    "要我确认寄出的任务单",
    "workbench",
    "see",
    TASK_ENTER
  ),
  item(
    9702,
    "monitor:card:arrive",
    "「待确认到达」卡片",
    "箱子已寄出、需要我确认到达的任务单",
    "workbench",
    "see",
    TASK_ENTER
  ),
  item(
    9703,
    "monitor:card:sign",
    "「待签收」卡片",
    "需要我签收的任务单",
    "workbench",
    "see",
    TASK_ENTER
  ),
  item(
    9704,
    "monitor:card:return",
    "「待接收退回」卡片",
    "被对方拒收、正退回本单位的任务单",
    "workbench",
    "see",
    TASK_ENTER
  ),
  item(
    9705,
    "monitor:card:sampling",
    "「采样待推进」卡片",
    "需要我开始采样、封箱或寄回的采样单",
    "workbench",
    "see",
    TASK_ENTER
  ),
  item(
    9706,
    "monitor:card:inspect",
    "「待检测」卡片",
    "已签收、要逐台开始检测的任务单",
    "workbench",
    "see",
    TASK_ENTER
  ),
  item(
    9707,
    "monitor:card:overLimit",
    "「开箱超限」卡片",
    "任务期间开箱次数超过上限的任务单",
    "workbench",
    "see",
    TASK_ENTER
  ),
  item(
    9708,
    "monitor:card:pending",
    "「待激活」卡片",
    "新上电、还没核对激活的设备",
    "workbench",
    "see",
    ["device:box:activate"]
  ),
  item(9709, "monitor:card:alert", "「告警」卡片", "设备报了告警的采样箱", "workbench", "see", [
    "device:box:list",
  ]),
  item(
    9710,
    "monitor:card:offline",
    "「在途但离线」卡片",
    "在途、超过 3 个上报周期没上报的采样箱",
    "workbench",
    "see",
    ["device:box:list"]
  ),
  item(
    9711,
    "monitor:card:low",
    "「低电量」卡片",
    "可用电量低于 20% 的采样箱",
    "workbench",
    "see",
    ["device:box:power"]
  ),
  item(9712, "monitor:card:lid", "「开着盖」卡片", "箱盖开着的采样箱", "workbench", "see", [
    "device:box:lid",
  ]),
  item(
    9713,
    "monitor:card:feed",
    "「最近动态」",
    "任务流转和开关箱、上电记录",
    "workbench",
    "see",
    ["device:box:task", "device:box:event-lid", "device:box:event-boot"]
  ),
  item(
    9714,
    "monitor:card:myBoxes",
    "「我保管的箱子」卡片",
    "保管人是自己的采样箱",
    "workbench",
    "see",
    ["device:box:list"]
  ),
  item(
    9715,
    "monitor:card:myTasks",
    "「我经手的任务」卡片",
    "自己是寄出人、签收人或采样人的任务单",
    "workbench",
    "see",
    TASK_ENTER
  ),
];

export const TASK_PERMS = [
  item(
    9104,
    "device:box:task",
    "查看任务单",
    "进「任务单」列表和详情：数据范围内的任务，以及寄给本单位、从本单位寄出的任务",
    "task",
    "enter"
  ),
  item(
    9404,
    "task:log",
    "查看任务期间的上报记录",
    "任务详情「上报记录」里，任务期间所有箱子的上报",
    "task",
    "see",
    TASK_ENTER
  ),
  item(
    9403,
    "task:video",
    "查看开箱录像",
    "任务详情里采样机构开箱时请求的录像",
    "task",
    "see",
    TASK_ENTER
  ),
  item(
    9405,
    "task:camera",
    "查看监控画面",
    "任务详情「监控」里采样单位、接收单位的 1–8 路监控",
    "task",
    "see",
    TASK_ENTER
  ),
  item(
    9410,
    "task:create:transfer",
    "新建调拨任务",
    "把采样箱从一个单位送到另一个单位",
    "task",
    "do",
    TASK_ENTER
  ),
  item(
    9411,
    "task:create:sample",
    "新建采样任务",
    "让采样机构带箱子去计划地点采样",
    "task",
    "do",
    TASK_ENTER
  ),
  item(
    9412,
    "task:policy",
    "设置任务期间上报策略",
    "新建任务时设任务期间的上报周期和单箱策略",
    "task",
    "do",
    ["task:create:transfer", "task:create:sample"]
  ),
  item(9413, "task:send", "确认寄出", "寄出单位确认箱子已寄出", "task", "do", TASK_ENTER),
  item(9414, "task:arrive", "确认到达", "确认箱子已到收货单位或采样单位", "task", "do", TASK_ENTER),
  item(
    9401,
    "task:sign",
    "签收",
    "收货方核验通过后签收；指定了签收人时只有签收人能签",
    "task",
    "do",
    TASK_ENTER
  ),
  item(9415, "task:reject", "拒收", "拒收后任务结束，箱子仍属寄出单位", "task", "do", TASK_ENTER),
  item(
    9416,
    "task:reject-return",
    "拒收并退回",
    "拒收并把箱子退回寄出单位，任务加上返程",
    "task",
    "do",
    TASK_ENTER
  ),
  item(
    9417,
    "task:force-sign",
    "强制签收",
    "签收核验有异常、或不是指定签收人时仍然签收，要写原因",
    "task",
    "do",
    TASK_ENTER
  ),
  item(
    9418,
    "task:accept-return",
    "接收退回",
    "寄出单位收到被拒收退回的箱子",
    "task",
    "do",
    TASK_ENTER
  ),
  item(
    9419,
    "task:inspect",
    "开始检测",
    "检测站逐台扫码开始检测，结束这台箱子的本次任务",
    "task",
    "do",
    TASK_ENTER
  ),
  item(9420, "task:sample-start", "开始采样", "采样单位开始采样", "task", "do", TASK_ENTER),
  item(9421, "task:seal", "封箱", "样品装好后封箱", "task", "do", TASK_ENTER),
  item(9422, "task:finish", "完成采样任务", "单向采样单在封箱后结束任务", "task", "do", TASK_ENTER),
  item(9423, "task:send-back", "寄回", "双向采样单封箱后寄回寄出单位", "task", "do", TASK_ENTER),
  item(
    9402,
    "task:cancel",
    "取消任务",
    "取消还没结束的任务；调拨单只能由寄出单位取消",
    "task",
    "do",
    TASK_ENTER
  ),
  item(9424, "task:video-retry", "重试录像请求", "录像请求失败时重新请求视频平台", "task", "do", [
    "task:video",
  ]),
];

export const BOX_PERMS = [
  item(
    9107,
    "device:box:list",
    "查看采样箱清单",
    "进「采样箱」「实时地图」，看到数据范围内的箱子",
    "box",
    "enter"
  ),
  item(9101, "device:box:detail", "打开采样箱详情", "打开单台箱子的详情页", "box", "enter", [
    "device:box:list",
    "device:box:task",
  ]),
  item(
    9130,
    "device:box:power",
    "查看电量",
    "电压、可用电量、充放电循环次数和学到的电量曲线参数",
    "box",
    "see",
    BOX_ANY
  ),
  item(9131, "device:box:lid", "查看箱盖状态", "箱盖现在开着还是关着", "box", "see", BOX_ANY),
  item(
    9132,
    "device:box:opens",
    "查看开箱次数",
    "累计开箱次数和上次开箱时间",
    "box",
    "see",
    BOX_ANY
  ),
  item(9133, "device:box:signal", "查看信号强度", "4G 信号强度（CSQ）", "box", "see", BOX_ANY),
  item(
    9134,
    "device:box:charging",
    "查看充电状态",
    "是否在充电、上次拔掉充电器的时间",
    "box",
    "see",
    BOX_ANY
  ),
  item(
    9135,
    "device:box:power-log",
    "查看开机和掉电时间",
    "最近一次上电、上一次掉电的时间",
    "box",
    "see",
    BOX_ANY
  ),
  item(9136, "device:box:storage", "查看剩余存储", "设备本机闪存还剩多少", "box", "see", BOX_ANY),
  item(
    9109,
    "device:box:location",
    "查看当前位置",
    "最新的 GPS 和基站位置、地址，任务里离目标地址多远",
    "box",
    "see",
    BOX_ANY
  ),
  item(
    9123,
    "device:box:track",
    "查看历史轨迹",
    "详情「轨迹」里按 24 小时、7 天、30 天看全部行程；不勾时只能按任务看任务期间的轨迹",
    "box",
    "see",
    BOX_DETAIL
  ),
  item(
    9110,
    "device:box:battery",
    "查看电量曲线",
    "详情里的电量变化曲线",
    "box",
    "see",
    BOX_DETAIL
  ),
  item(
    9137,
    "device:box:event-lid",
    "查看开关箱记录",
    "每次开箱、关箱的时间，轨迹上标出开箱位置",
    "box",
    "see",
    ["device:box:detail", "device:box:task"]
  ),
  item(9138, "device:box:event-boot", "查看上电记录", "设备每次重启上电的时间", "box", "see", [
    "device:box:detail",
    "device:box:task",
  ]),
  item(9139, "device:box:event-charge", "查看充电记录", "插上、拔掉充电器的时间", "box", "see", [
    "device:box:detail",
    "device:box:task",
  ]),
  item(9103, "device:box:log", "查看上报记录", "每条上报的时间、类型和摘要", "box", "see", [
    "device:box:detail",
    "device:box:task",
  ]),
  item(9140, "device:box:raw", "查看上报原文", "点开一条上报看设备发来的原始内容", "box", "see", [
    "device:box:log",
    "task:log",
  ]),
  item(9141, "device:box:iccid", "查看 ICCID", "SIM 卡号", "box", "see", [
    "device:box:list",
    "device:box:detail",
  ]),
  item(9142, "device:box:imsi", "查看 IMSI", "SIM 卡的用户识别码", "box", "see", [
    "device:box:list",
    "device:box:detail",
  ]),
  item(9143, "device:box:firmware", "查看固件版本", "设备固件的版本号", "box", "see", [
    "device:box:list",
    "device:box:detail",
  ]),
  item(
    9114,
    "device:box:policyRead",
    "查看上报策略",
    "箱子当前用的上报周期、是否只在充电时上报，和下发状态",
    "box",
    "see",
    ["device:box:list", "device:box:detail"]
  ),
  item(
    9105,
    "device:box:activate",
    "激活新设备",
    "核对 IMEI 后把待激活的新设备投入使用",
    "box",
    "do",
    ["device:box:list", "device:box:detail"]
  ),
  item(
    9122,
    "device:box:rename",
    "修改采样箱名称",
    "改名称，不能和别的箱子重名；激活时起名也要这一项",
    "box",
    "do",
    ["device:box:list", "device:box:detail"]
  ),
  item(9144, "device:box:assign-org", "分配所属单位", "把箱子改归另一个单位", "box", "do", [
    "device:box:list",
    "device:box:detail",
  ]),
  item(9145, "device:box:assign-owner", "分配保管人", "指定或清空箱子的保管人", "box", "do", [
    "device:box:list",
    "device:box:detail",
  ]),
  item(9106, "device:box:disable", "停用采样箱", "停用后不能再建任务", "box", "do", [
    "device:box:list",
    "device:box:detail",
  ]),
  item(9146, "device:box:enable", "恢复采样箱", "把停用的箱子恢复成未使用", "box", "do", [
    "device:box:list",
    "device:box:detail",
  ]),
  item(
    9119,
    "device:box:delete",
    "删除采样箱档案",
    "只能删未使用或已停用的档案，设备下次上报会重新建档",
    "box",
    "do",
    ["device:box:list", "device:box:detail"]
  ),
  item(
    9147,
    "device:box:wipe",
    "远程抹除设备",
    "删除档案时让设备抹掉本机数据并重启（快速或完整）",
    "box",
    "do",
    ["device:box:delete"]
  ),
  item(
    9115,
    "device:box:policyWrite",
    "设置单箱上报策略",
    "给单台箱子单独设上报周期",
    "box",
    "do",
    ["device:box:policyRead"]
  ),
  item(
    9116,
    "device:box:policyBatch",
    "批量设置上报策略",
    "按筛选结果一次给多台箱子设上报周期",
    "box",
    "do",
    ["device:box:policyRead"]
  ),
  item(
    9113,
    "device:box:export",
    "导出采样箱清单",
    "把清单导出成表格，列按自己能看的内容裁剪",
    "box",
    "do",
    ["device:box:list"]
  ),
  item(
    9120,
    "device:box:logExport",
    "导出单箱上报记录",
    "导出单台箱子一段时间的上报记录",
    "box",
    "do",
    BOX_DETAIL
  ),
  item(
    9121,
    "device:box:dump",
    "读取设备本机日志",
    "让设备把本机记录传上来并下载，会耗设备 4G 流量",
    "box",
    "do",
    BOX_DETAIL
  ),
];

export const OVERVIEW_PERMS = [
  item(
    9150,
    "monitor:overview",
    "查看总览",
    "进「总览」：各分公司、检测站的箱子数量和状态，单位总览里按日看任务",
    "overview",
    "enter",
    ["device:box:list"]
  ),
];

export const ORG_PERMS = [
  item(9501, "sys:dept:view", "查看部门", "进「部门」看组织结构和各部门资料", "dept", "enter"),
  item(9510, "sys:dept:create", "新增部门", "在部门树里加新部门", "dept", "do", ["sys:dept:view"]),
  item(
    9511,
    "sys:dept:update",
    "编辑部门基本信息",
    "改名称、编码、上级部门、排序，启用或停用",
    "dept",
    "do",
    ["sys:dept:view"]
  ),
  item(
    9525,
    "sys:dept:type",
    "设置部门类型",
    "公司或采样机构（采样机构就是检测站，送到这里的任务签收后要开始检测）",
    "dept",
    "do",
    ["sys:dept:view"]
  ),
  item(
    9526,
    "sys:dept:address",
    "设置部门地址和联系人",
    "地址、坐标、联系人和电话，会带进任务单的寄出、收货地址",
    "dept",
    "do",
    ["sys:dept:view"]
  ),
  item(9527, "sys:dept:camera", "配置监控通道", "采样机构的 1–8 路监控通道", "dept", "do", [
    "sys:dept:view",
  ]),
  item(
    9528,
    "sys:dept:leader",
    "指定部门负责人",
    "从已有人员里选负责人；顺手新建负责人账号还要「新增人员」",
    "dept",
    "do",
    ["sys:dept:view"]
  ),
  item(9512, "sys:dept:delete", "删除部门", "只能删没有下级部门、没有人员的部门", "dept", "do", [
    "sys:dept:view",
  ]),
  item(
    9503,
    "sys:user:view",
    "查看人员",
    "进「人员」看本部门及下级的人，和每个人的实际权限",
    "user",
    "enter"
  ),
  item(9513, "sys:user:create", "新增人员", "新建账号，系统生成初始密码", "user", "do", [
    "sys:user:view",
  ]),
  item(9514, "sys:user:update", "编辑人员资料", "改姓名、部门、手机、邮箱", "user", "do", [
    "sys:user:view",
  ]),
  item(9515, "sys:user:disable", "停用账号", "停用后对方已有的登录立即失效", "user", "do", [
    "sys:user:view",
  ]),
  item(9529, "sys:user:enable", "启用账号", "把停用的账号重新启用", "user", "do", [
    "sys:user:view",
  ]),
  item(9516, "sys:user:delete", "删除人员", "删除账号，不能恢复", "user", "do", ["sys:user:view"]),
  item(
    9517,
    "sys:user:reset-password",
    "重置密码",
    "生成随机密码，对方已有的登录全部失效",
    "security",
    "do",
    ["sys:user:view"]
  ),
  item(
    9518,
    "sys:user:force-password",
    "要求下次登录改密",
    "对方下次操作时必须先改密码",
    "security",
    "do",
    ["sys:user:view"]
  ),
  item(9519, "sys:user:unlock", "解锁账号", "输错密码被锁定的账号立即解锁", "security", "do", [
    "sys:user:view",
  ]),
  item(
    9520,
    "sys:user:kick",
    "强制下线",
    "对方所有设备上的登录立即失效，小程序的微信绑定也解除",
    "security",
    "do",
    ["sys:user:view"]
  ),
  item(
    9521,
    "sys:user:unbind-wechat",
    "解绑微信",
    "解掉小程序的微信绑定，之后要重新输账号密码",
    "security",
    "do",
    ["sys:user:view"]
  ),
  item(9506, "sys:role:view", "查看角色", "进「角色与权限」看各角色的权限", "grant", "enter"),
  item(
    9522,
    "sys:role:create",
    "新增角色",
    "新建角色；新角色先是「仅本人」、没有权限",
    "grant",
    "do",
    ["sys:role:view"]
  ),
  item(9523, "sys:role:update", "编辑角色", "改名称、排序，启用或停用", "grant", "do", [
    "sys:role:view",
  ]),
  item(9524, "sys:role:delete", "删除角色", "删除角色，拥有它的人随即失去这些权限", "grant", "do", [
    "sys:role:view",
  ]),
  item(
    9508,
    "sys:role:grant",
    "给角色分配权限",
    "勾选角色的权限和可转授；只能动自己「可转授」的项",
    "grant",
    "do",
    ["sys:role:view"]
  ),
  item(
    9530,
    "sys:role:scope",
    "设置角色数据范围",
    "全部数据、本单位及下级、本单位、仅本人；不能比自己的宽",
    "grant",
    "do",
    ["sys:role:view"]
  ),
  item(
    9509,
    "sys:user:role",
    "给人员分配角色",
    "决定一个人有哪些角色；只能分配权限都在自己「可转授」里、数据范围不比自己宽的角色",
    "grant",
    "do",
    ["sys:user:view"]
  ),
  item(
    9531,
    "sys:dept:limit",
    "设置部门权限上限",
    "规定一个部门的人最多能用哪些权限、最大数据范围；下级不能超过上级",
    "grant",
    "do",
    ["sys:dept:view"]
  ),
];

export const SYS_PERMS = [
  item(
    9601,
    "sys:settings:view",
    "查看系统设置",
    "进「系统设置」只看不改；地图密钥不显示",
    "settings",
    "enter"
  ),
  item(9602, "sys:settings:map", "修改地图密钥", "天地图服务密钥", "settings", "do", [
    "sys:settings:view",
  ]),
  item(
    9610,
    "sys:settings:branding",
    "修改系统名称和图标",
    "系统名称、标语和图标",
    "settings",
    "do",
    ["sys:settings:view"]
  ),
  item(
    9603,
    "sys:settings:labels",
    "修改显示文字",
    "生命周期、上报类型、箱盖、充电、在线、指示灯、指标卡的显示名称",
    "settings",
    "do",
    ["sys:settings:view"]
  ),
  item(
    9604,
    "sys:settings:db",
    "修改数据库连接",
    "改连接会迁移并重启服务，改错会导致系统不可用",
    "settings",
    "do",
    ["sys:settings:view"]
  ),
  item(
    9611,
    "sys:settings:password",
    "修改密码规则",
    "最短长度、必须包含的字符类别、有效天数",
    "settings",
    "do",
    ["sys:settings:view"]
  ),
  item(
    9612,
    "sys:settings:lockout",
    "修改登录失败锁定",
    "连续输错几次锁定、锁定多少分钟",
    "settings",
    "do",
    ["sys:settings:view"]
  ),
  item(
    9613,
    "sys:settings:smtp",
    "配置邮件服务",
    "SMTP 服务器、账号、发件人，发测试邮件",
    "settings",
    "do",
    ["sys:settings:view"]
  ),
  item(
    9614,
    "sys:settings:video",
    "配置视频平台",
    "视频平台地址、令牌、超时，测试连接",
    "settings",
    "do",
    ["sys:settings:view"]
  ),
  item(
    9615,
    "sys:settings:wechat",
    "配置微信小程序",
    "小程序 AppID 和 AppSecret",
    "settings",
    "do",
    ["sys:settings:view"]
  ),
  item(
    9118,
    "device:box:policyDefault",
    "修改默认上报策略",
    "新箱子和没单独设策略的箱子用的上报周期、是否只在充电时上报",
    "settings",
    "do",
    ["sys:settings:view"]
  ),
  item(
    9616,
    "sys:settings:battery-reserve",
    "修改电量预留比例",
    "可用电量扣掉的预留比例，也决定低电量的判断",
    "settings",
    "do",
    ["sys:settings:view"]
  ),
  item(
    9617,
    "sys:settings:arrive-radius",
    "修改到达判定半径",
    "离目标地址多近算到达",
    "settings",
    "do",
    ["sys:settings:view"]
  ),
];

export const LOG_PERMS = [
  item(
    9607,
    "sys:oplog:read",
    "查看操作日志",
    "谁在什么时候做了什么操作，以及操作统计",
    "log",
    "enter"
  ),
  item(9301, "sys:runtime-log:read", "查看系统日志", "服务端运行日志，排查故障用", "log", "enter"),
  item(9302, "sys:runtime-log:detail", "查看脱敏堆栈", "系统日志里的脱敏错误堆栈", "log", "see", [
    "sys:runtime-log:read",
  ]),
];

export const ALL_PERMS = [
  ...CARD_PERMS,
  ...TASK_PERMS,
  ...BOX_PERMS,
  ...OVERVIEW_PERMS,
  ...ORG_PERMS,
  ...SYS_PERMS,
  ...LOG_PERMS,
];

const byId = new Map(ALL_PERMS.map((perm) => [perm.id, perm.code]));
const byCode = new Map(ALL_PERMS.map((perm) => [perm.code, perm]));

export function permCodeOf(id) {
  return byId.get(Number(id)) || null;
}
export function permIdOf(code) {
  return byCode.get(code)?.id ?? null;
}
/** 权限码的中文名，提示「不能授予哪几项」时用。不认识的码原样返回。 */
export function permLabelOf(code) {
  return byCode.get(code)?.label || code;
}
export function permOf(code) {
  return byCode.get(code) || null;
}

/** 角色页用：按模块、三段排好。 */
export const PERM_GROUPS = PERM_MODULES.map((module) => ({
  key: module.key,
  label: module.label,
  hint: module.hint,
  items: ALL_PERMS.filter((perm) => perm.module === module.key),
}));

/* ---------------- 拆分和升级 ---------------- */

/** 在 current 上套一张拆分表：老码换成新码。返回 { add, remove }。老码在新码里时保留。 */
export function applySplits(current, table) {
  const have = new Set(current);
  const add = new Set();
  const remove = [];
  for (const [old, parts] of Object.entries(table)) {
    if (!have.has(old)) continue;
    if (!parts.includes(old)) remove.push(old);
    for (const code of parts) if (!have.has(code)) add.add(code);
  }
  return { add: [...add], remove };
}

/** 迁移 043：合在一起的老码 → 拆开后的码。 */
export const SPLIT_043 = {
  "sys:dept:write": ["sys:dept:create", "sys:dept:update", "sys:dept:delete"],
  "sys:user:write": ["sys:user:create", "sys:user:update", "sys:user:disable", "sys:user:delete"],
  "sys:user:security": [
    "sys:user:reset-password",
    "sys:user:force-password",
    "sys:user:unlock",
    "sys:user:kick",
    "sys:user:unbind-wechat",
  ],
  "sys:role:write": ["sys:role:create", "sys:role:update", "sys:role:delete"],
};
export const USER_SECURITY_PERMS = SPLIT_043["sys:user:security"];
export function split043(current) {
  return applySplits(current, SPLIT_043);
}

const TASK_STEPS = [
  "task:arrive",
  "task:sample-start",
  "task:seal",
  "task:finish",
  "task:send-back",
  "task:accept-return",
];

/** 迁移 045：一项管几件事的码 → 一件事一项。 */
export const SPLIT_045 = {
  "device:box:status": [
    "device:box:power",
    "device:box:lid",
    "device:box:opens",
    "device:box:signal",
    "device:box:charging",
    "device:box:power-log",
    "device:box:storage",
  ],
  "device:box:identity": ["device:box:iccid", "device:box:imsi", "device:box:firmware"],
  "device:box:event": ["device:box:event-lid", "device:box:event-boot", "device:box:event-charge"],
  "device:box:log": ["device:box:log", "device:box:raw"],
  "device:box:assign": ["device:box:assign-org", "device:box:assign-owner"],
  "device:box:disable": ["device:box:disable", "device:box:enable"],
  "device:box:delete": ["device:box:delete", "device:box:wipe"],
  "device:box:list": ["device:box:list", "monitor:overview"],
  "device:box:policyTask": [
    "task:create:transfer",
    "task:create:sample",
    "task:policy",
    "task:send",
    ...TASK_STEPS,
  ],
  "task:sign": [
    "task:sign",
    "task:reject",
    "task:reject-return",
    "task:force-sign",
    "task:inspect",
    ...TASK_STEPS,
  ],
  "task:video": ["task:video", "task:camera", "task:video-retry"],
  "device:box:policyDefault": [
    "device:box:policyDefault",
    "sys:settings:battery-reserve",
    "sys:settings:arrive-radius",
  ],
  "sys:dept:create": [
    "sys:dept:create",
    "sys:dept:type",
    "sys:dept:address",
    "sys:dept:camera",
    "sys:dept:leader",
  ],
  "sys:dept:update": [
    "sys:dept:update",
    "sys:dept:type",
    "sys:dept:address",
    "sys:dept:camera",
    "sys:dept:leader",
  ],
  "sys:user:disable": ["sys:user:disable", "sys:user:enable"],
  "sys:role:grant": ["sys:role:grant", "sys:role:scope"],
  "sys:settings:labels": ["sys:settings:labels", "sys:settings:branding"],
  "sys:settings:security": ["sys:settings:password", "sys:settings:lockout"],
  "sys:settings:integration": ["sys:settings:smtp", "sys:settings:video", "sys:settings:wechat"],
};
/** 迁移 045 去掉的码：工作台卡片组（只管排序，不控制内容），换成逐张卡片。 */
export const DROPPED_045 = [
  "monitor:view:asset",
  "monitor:view:duty",
  "monitor:view:verify",
  "monitor:view:dispatch",
  "monitor:view:field",
  "monitor:view:leader",
  "monitor:home:switch",
];

/** 以前工作台卡片有没有，只看有没有看里面内容的权限。升级时按这个补上逐张卡片，工作台显示不变。 */
export function cardsFor(codes) {
  const have = new Set(codes);
  const cards = [];
  if (have.has("device:box:task"))
    cards.push(
      "monitor:card:send",
      "monitor:card:arrive",
      "monitor:card:sign",
      "monitor:card:return",
      "monitor:card:sampling",
      "monitor:card:inspect",
      "monitor:card:overLimit",
      "monitor:card:myTasks",
      "monitor:card:feed"
    );
  if (have.has("device:box:list"))
    cards.push("monitor:card:alert", "monitor:card:offline", "monitor:card:myBoxes");
  if (have.has("device:box:power")) cards.push("monitor:card:low");
  if (have.has("device:box:lid")) cards.push("monitor:card:lid");
  if (have.has("device:box:activate")) cards.push("monitor:card:pending");
  if (have.has("device:box:event-lid") || have.has("device:box:event-boot"))
    cards.push("monitor:card:feed");
  return [...new Set(cards)].filter((code) => !have.has(code));
}

/** 老码列表升级成现在的码：043、045 拆分，去掉卡片组，补逐张卡片。新库默认值、模板都走这里。 */
export function upgradeCodes(codes) {
  let current = [...new Set(codes)];
  for (const table of [SPLIT_043, SPLIT_045]) {
    const { add, remove } = applySplits(current, table);
    current = current.filter((code) => !remove.includes(code)).concat(add);
  }
  current = current.filter((code) => !DROPPED_045.includes(code));
  return [...new Set([...current, ...cardsFor(current)])];
}

/**
 * 可转授（类似数据库授权的 WITH GRANT OPTION）：角色上的每项权限另有一个开关，
 * 开了的，拥有这个角色的人才能把这项权限授给别的角色、或把含这项权限的角色分给别人。
 * 新库和升级时：有「给角色分配权限」或「给人员分配角色」的角色，自己的权限全部可转授。
 */
export function grantsAll(codes) {
  const have = new Set(codes);
  return have.has("sys:role:grant") || have.has("sys:user:role");
}

/* ---------------- 默认角色和模板 ---------------- */

const OLD = (names) => names.map((name) => `device:box:${name}`);
/** 默认角色按老码写，经 upgradeCodes 换成现在的码，和老库升级后的结果一致。 */
const LEGACY_DEFAULTS = {
  ASSET: [
    ...OLD([
      "list",
      "detail",
      "status",
      "location",
      "track",
      "battery",
      "identity",
      "event",
      "log",
      "task",
      "activate",
      "rename",
      "disable",
      "assign",
      "export",
    ]),
    "sys:dept:view",
  ],
  DUTY: [
    ...OLD(["list", "detail", "status", "location", "track", "battery", "event", "task"]),
    "task:sign",
    "task:log",
  ],
  VERIFY: [
    ...OLD(["list", "detail", "status", "location", "track", "event", "task"]),
    "task:sign",
    "task:log",
  ],
  DISPATCH: [
    ...OLD([
      "list",
      "detail",
      "status",
      "location",
      "track",
      "battery",
      "event",
      "task",
      "assign",
      "policyTask",
    ]),
    "task:sign",
    "task:cancel",
    "task:video",
  ],
  LEADER: [
    ...OLD(["list", "detail", "status", "location", "track", "event", "task", "export"]),
    "task:video",
    "sys:oplog:read",
    "sys:dept:view",
    "sys:user:view",
  ],
  BRANCH_ADMIN: [
    ...OLD(["list", "detail", "status", "location", "track", "event", "task", "assign"]),
    "task:sign",
    "task:video",
    "sys:dept:view",
    "sys:user:view",
    "sys:user:write",
    "sys:user:role",
    "sys:user:security",
  ],
  AGENCY_LEAD: [
    ...OLD(["list", "detail", "status", "location", "track", "event", "task"]),
    "task:sign",
    "task:video",
    "sys:user:view",
  ],
  SAMPLER: [...OLD(["list", "detail", "status", "location", "track"])],
  HOME_SWITCH: [],
};

/** 新库按角色编码写进去的默认授权。之后以角色页保存的为准。 */
export const DEFAULT_ROLE_PERMS = {
  ADMIN: ALL_PERMS.map((perm) => perm.code),
  ...Object.fromEntries(
    Object.entries(LEGACY_DEFAULTS).map(([code, list]) => [code, upgradeCodes(list)])
  ),
};

/** 角色页「常用模板」：一键套用后再改。 */
export const ROLE_TEMPLATES = [
  { key: "SAMPLER", label: "现场采样员", hint: "看自己保管的箱子：电量、箱盖、位置、轨迹" },
  { key: "DISPATCH", label: "调度员", hint: "建调拨和采样任务、推进流转、分配箱子" },
  { key: "VERIFY", label: "核验员", hint: "签收核验、看开关箱记录和任务期间上报" },
  { key: "DUTY", label: "值班员", hint: "盯告警、离线、低电量，看任务期间上报" },
  { key: "ASSET", label: "资产管理员", hint: "激活、改名、停用、分配、导出采样箱" },
  { key: "AGENCY_LEAD", label: "机构负责人", hint: "采样机构的签收、采样推进和开箱录像" },
  {
    key: "BRANCH_ADMIN",
    label: "分公司管理员",
    hint: "本单位的人员、账号安全、分配角色，和日常任务",
  },
  { key: "LEADER", label: "只读领导", hint: "只看不改：箱子状态、任务、操作日志" },
].map((template) => ({ ...template, codes: DEFAULT_ROLE_PERMS[template.key] || [] }));

/* ---------------- 老迁移用的函数（保持原样） ---------------- */

/**
 * 迁移 029：补进已有角色的权限（当年的兼容规则）。现在新库没有老角色，这里只给更老的库升级用。
 */
export function upgradeRolePerms(code, current) {
  const have = new Set(current);
  const add = new Set();
  if (have.has("device:box:task")) add.add("task:sign").add("task:video");
  if (have.has("device:box:policyTask")) add.add("task:cancel");
  if (have.has("device:box:log")) add.add("task:log");
  return [...add].filter((perm) => !have.has(perm));
}

/** 迁移 039：位置拆出历史轨迹、编辑角色拆出分配权限、编辑人员拆出分配角色。 */
export function splitPerms(current) {
  const have = new Set(current);
  const add = [];
  if (have.has("device:box:location")) add.push("device:box:track");
  if (have.has("sys:role:write")) add.push("sys:role:grant");
  if (have.has("sys:user:write")) add.push("sys:user:role");
  return add.filter((perm) => !have.has(perm));
}

/* ---------------- 旧菜单权限树 ---------------- */

/** 旧角色页权限树里采样箱节点下的分组（按三段）。 */
export function boxPermTree() {
  return [
    { value: 9190, key: "enter", label: TIER_LABELS.enter },
    { value: 9191, key: "see", label: TIER_LABELS.see },
    { value: 9192, key: "do", label: TIER_LABELS.do },
  ].map((group) => ({
    value: group.value,
    label: group.label,
    children: BOX_PERMS.filter((perm) => perm.tier === group.key).map((perm) => ({
      value: perm.id,
      label: perm.label,
      code: perm.code,
    })),
  }));
}

export function viewPermTree() {
  return CARD_PERMS.map((perm) => ({ value: perm.id, label: perm.label, code: perm.code }));
}
