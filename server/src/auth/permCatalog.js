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
    "需要我开始采样、封箱或寄出（寄往唯一检测站）的合并采样单",
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
    "任务详情里分公司（公司类型）采样现场开箱时请求的录像；检测站不设录像",
    "task",
    "see",
    TASK_ENTER
  ),
  item(
    9405,
    "task:camera",
    "查看监控画面",
    "任务详情「监控」里分公司采样现场的 1–8 路监控（检测站不设摄像头）",
    "task",
    "see",
    TASK_ENTER
  ),
  item(
    9410,
    "task:create:transfer",
    "新建划拨单",
    "批量把采样箱划拨给另一个公司：创建后待目标分公司管理员接受，接受时归属转移；接受前可取消/补填快递单号",
    "task",
    "do",
    TASK_ENTER
  ),
  item(
    9411,
    "task:create:sample",
    "新建采样任务",
    "分公司带箱子去计划地点采样（仅本地），或采样后封箱直寄唯一检测站（合并一张单）；送检单（仅寄送）另按「新建送检单」授权",
    "task",
    "do",
    TASK_ENTER
  ),
  item(
    9420,
    "task:create:inspect",
    "新建送检单",
    "把采样箱送唯一检测站（仅寄送、无采样段），签收后逐台开始检测；R21 起送检严格要本码，不再由「新建采样任务」兜底",
    "task",
    "do",
    TASK_ENTER
  ),
  // R24（#70）撤销划拨下线：原 item(9421, "task:transfer:revoke", "撤销划拨") 已从目录移除，
  // 角色页不再出现该勾选项，新角色也无法被授予。历史 9421 行与存量授权行留在库里不动
  //（不新增迁移），前端门与后端路由都不再读它，等同 inert。
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
    "唯一检测站逐台扫码开始检测，结束这台箱子的本次任务",
    "task",
    "do",
    TASK_ENTER
  ),
  item(
    9425,
    "task:sample-start",
    "开始采样",
    "分公司（采样单位）开始采样",
    "task",
    "do",
    TASK_ENTER
  ),
  item(9426, "task:seal", "封箱", "样品装好后封箱", "task", "do", TASK_ENTER),
  // R25（#71/064）划拨三态：接受划拨＝目标分公司管理员确认，接受时归属立即转移＋保管人清空。
  // 创建（task:create:transfer）仍归创建方；接受是接收方动作，单独授权（BRANCH_ADMIN 模板＋存量 064 补码）。
  item(
    9427,
    "task:transfer:accept",
    "接受划拨",
    "目标分公司管理员确认接受划拨单，接受时箱子归属立即转移到本公司（保管人清空）；接受后不可撤销",
    "task",
    "do",
    TASK_ENTER
  ),
  item(
    9422,
    "task:finish",
    "完成采样任务",
    "旧单向采样单封箱后结束任务（合并单不再有此步，历史权限码保留）",
    "task",
    "do",
    TASK_ENTER
  ),
  // 组织简化（B4a，B3 遗留③文案对齐）：合并单此码管「已封箱→在途」＝寄往唯一检测站，
  // 不再叫「寄回」（旧双向采样单寄回段只读兼容，码本身保留）。
  item(
    9423,
    "task:send-back",
    "寄出（寄检测站）",
    "合并采样单封箱后直寄唯一检测站；旧双向采样单此码管寄回段（历史语义只读保留）",
    "task",
    "do",
    TASK_ENTER
  ),
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
  // R13 公司级策略中心：公司默认策略（双频/灯/定位）单独一码，
  // 与全局语义的 device:box:policyDefault 分开（一项只管一件事）；数据范围闸门 manageOrgIds 只能改本公司。
  item(
    9148,
    "device:box:policyCompany",
    "修改公司默认策略",
    "设本公司箱子的非任务/任务期间上报策略、指示灯、卫星定位；只影响没有单箱、批量或任务设置的箱子，任务策略只作新建任务单的初始值。判定阈值另按「修改公司判定阈值」",
    "box",
    "do",
    ["device:box:policyRead"]
  ),
  // R21（062）：公司判定阈值从 policyCompany 拆出——阈值影响全公司低电/到达/离线判定，
  // 与上报节奏（idle/task 双频）是不同决策；对齐系统层 battery-reserve/arrive-radius 独立先例。
  item(
    9149,
    "device:box:policyCompanyJudge",
    "修改公司判定阈值",
    "设本公司电量预留、任务到达半径、建单后未上线宽限，留空继承系统默认；上报策略仍按「修改公司默认策略」",
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
  item(9511, "sys:dept:update", "编辑部门基本信息", "改名称、编码、上级部门、排序", "dept", "do", [
    "sys:dept:view",
  ]),
  // R26（061）：启停从 update 拆出，对齐人员 disable/enable 先例——停用影响建单/总览，与改资料分开授予
  item(
    9532,
    "sys:dept:disable",
    "停用部门",
    "停用后这个单位的箱子不能再建任务单，总览里不再列出这个单位",
    "dept",
    "do",
    ["sys:dept:view"]
  ),
  item(9533, "sys:dept:enable", "启用部门", "把停用的部门重新启用", "dept", "do", [
    "sys:dept:view",
  ]),
  item(
    9525,
    "sys:dept:type",
    "设置部门类型",
    "公司或检测站：分公司＝公司类型（自采）；检测站全局唯一、属总公司子树，送到这里的任务签收后要开始检测",
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
  item(
    9527,
    "sys:dept:camera",
    "配置监控通道",
    "分公司（公司类型）采样现场的 1–8 路监控通道；检测站禁配",
    "dept",
    "do",
    ["sys:dept:view"]
  ),
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
  item(9523, "sys:role:update", "编辑角色", "改名称、排序", "grant", "do", ["sys:role:view"]),
  // R26（061）：启停从 update 拆出——停用角色＝持有者随即失权（高影响），与改名/排序（展示口径）分开授予
  item(
    9534,
    "sys:role:disable",
    "停用角色",
    "停用后拥有它的人随即失去这个角色的权限",
    "grant",
    "do",
    ["sys:role:view"]
  ),
  item(9535, "sys:role:enable", "启用角色", "把停用的角色重新启用", "grant", "do", [
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
    "新箱子和没单独设策略的箱子用的上报周期、是否只在充电时上报、建单后未上线宽限；唯一检测站另按「设置唯一检测站」",
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
  // R21（062）：唯一检测站从 policyDefault 拆出——检测站配置是组织路由决策（影响全部任务流），
  // 与遥测节奏不同类；配置入口在采样箱›默认策略页「系统默认（全局兜底）」折叠区。
  item(
    9618,
    "sys:settings:station",
    "设置唯一检测站",
    "指定合并采样单接收方的唯一检测站；清空后按「总公司下恰一个启用检测站」自动认定",
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
  item(9608, "sys:oplog:export", "导出操作日志", "按当前数据范围导出操作日志 CSV", "log", "do", [
    "sys:oplog:read",
  ]),
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

/**
 * 迁移 061（R26 / 任务 #60）：部门/角色启停从各自的 update 拆出（P0 两项各拆两码，用户拍板）。
 * 老码保留（parts 含 old）：持 update 者自动获 disable+enable 并集，存量角色不丢能力；
 * 之后管理员可在角色页单独收回启停而保留资料编辑。对齐人员 sys:user:disable/enable（043/045）先例。
 */
export const SPLIT_061 = {
  "sys:dept:update": ["sys:dept:update", "sys:dept:disable", "sys:dept:enable"],
  "sys:role:update": ["sys:role:update", "sys:role:disable", "sys:role:enable"],
};

/**
 * 迁移 062（R21 / 任务 #64）：权限 P1 四项细化（用户全选）里的三组拆码，老码保留（parts 含 old）：
 * - policyCompany → +policyCompanyJudge：公司判定阈值三列从公司默认策略拆出（§3.3）；
 * - policyDefault → +sys:settings:station：唯一检测站从默认上报策略拆出（§3.5）；
 * - create:sample → +create:inspect：送检严格要「新建送检单」（去兜底，§3.4），存量持有者补并集，
 *   之后管理员可单独收回送检而保留采样。
 * 第四项「上报记录菜单门对齐」（§3.6）是菜单 gate 精化（some(log/event-*)），不是码拆分，不进拆分表。
 */
export const SPLIT_062 = {
  "device:box:policyCompany": ["device:box:policyCompany", "device:box:policyCompanyJudge"],
  "device:box:policyDefault": ["device:box:policyDefault", "sys:settings:station"],
  "task:create:sample": ["task:create:sample", "task:create:inspect"],
};

/**
 * 迁移 063（R23 / 任务 #66，D5 已拍板）：现场采样员最小任务入口的存量补码集。
 * 读（device:box:task，菜单/列表/详情门）＋开始采样＋封箱；数据范围仍仅本人保管（scope4 不变）。
 * 不是拆码（无老码→新码映射），故不进 upgradeCodes 拆分链；新库由 LEGACY_DEFAULTS.SAMPLER 覆盖，
 * 存量 SAMPLER 角色由 063 只补不删。工作台卡片随读码由 cardsFor 同补（保证存量==新库口径）。
 */
export const SAMPLER_ENTRY_063 = ["device:box:task", "task:sample-start", "task:seal"];

/**
 * 迁移 064（R25 / 任务 #71）：划拨三态的存量补码集——接受划拨（目标分公司管理员确认）。
 * 不是拆码（无老码→新码映射），故不进 upgradeCodes 拆分链；新库由 LEGACY_DEFAULTS.BRANCH_ADMIN 覆盖，
 * 存量 BRANCH_ADMIN 角色由 064 只补不删（063 同款）。创建/取消/拒收/补单号不另设码：
 * 创建沿用 task:create:transfer，取消/补单号按创建方身份门，拒收沿用 task:reject（接收方）。
 */
export const TRANSFER_ACCEPT_064 = ["task:transfer:accept"];

/**
 * 迁移 055（#26 D4）：新权限点补授权——持 sys:oplog:read 的角色/部门上限自动补 sys:oplog:export
 * （导出是读的延伸，拆开会让老角色点不到导出；同 053 模式，只补不删，幂等）。
 */
export const GRANT_055 = { "sys:oplog:read": ["sys:oplog:export"] };
/** 在 current 上套 GRANT_055：返回要补的码（不含已有的）。 */
export function grant055(current) {
  const have = new Set(current);
  const add = new Set();
  for (const [need, codes] of Object.entries(GRANT_055)) {
    if (!have.has(need)) continue;
    for (const code of codes) if (!have.has(code)) add.add(code);
  }
  return [...add];
}

/** 老码列表升级成现在的码：043、045、061、062 拆分，去掉卡片组，补逐张卡片，055 补导出码。新库默认值、模板都走这里。 */
export function upgradeCodes(codes) {
  let current = [...new Set(codes)];
  for (const table of [SPLIT_043, SPLIT_045, SPLIT_061, SPLIT_062]) {
    const { add, remove } = applySplits(current, table);
    current = current.filter((code) => !remove.includes(code)).concat(add);
  }
  current = current.filter((code) => !DROPPED_045.includes(code));
  return [...new Set([...current, ...cardsFor(current), ...grant055(current)])];
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
      // R13：公司策略中心前置（policyCompany 的 needs；存量库由 058 连前置一起补）
      "policyRead",
    ]),
    // 组织简化（B4a，B3 遗留②）：分公司内部调度岗建合并采样单是主路径，显式钉死建单码
    //（policyTask 经 045 拆分已含此码，这里显式列出防拆链变动；存量库由 056 幂等补码）。
    "task:create:sample",
    // R24（#70）撤销下线：调度员模板不再持有 task:transfer:revoke（原 R12 裁决「可撤自己建的划拨单」
    // 随功能一起退出）。调度员的 task:create:transfer 由 policyTask 拆分链带出（实测仍 true），
    // 所以调拨单页可见性不受影响，只是撤不动了。存量库由 057 补的授权行留在库里（inert），不新增迁移清理。
    // R13 公司策略中心：调度员可改本公司默认策略（manageOrgIds 闸门限本公司；存量库由 058 幂等补码）。
    "device:box:policyCompany",
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
    ...OLD([
      "list",
      "detail",
      "status",
      "location",
      "track",
      "event",
      "task",
      "assign",
      // R13：公司策略中心前置（policyCompany 的 needs；存量库由 058 连前置一起补）
      "policyRead",
    ]),
    // 组织简化（B4a/P11，B3 遗留②）：分公司自采建单是主路径——BRANCH_ADMIN 默认补
    // task:create:sample（存量库由 056 幂等补码步补齐，角色页保存过的以保存为准）。
    "task:create:sample",
    // R12 门禁裁决：调拨单仅划拨权限者可见；分公司管理员是划拨主责角色，补建单码
    //（存量库由 057 幂等补码；角色页保存过的以保存为准）。
    // R24（#70）撤销下线：本模板不再补 task:transfer:revoke，只留 task:create:transfer。
    "task:create:transfer",
    // R25（#71/064）划拨三态：分公司管理员是接受划拨主责角色（目标方确认），补接受码
    //（存量库由 064 幂等补码；角色页保存过的以保存为准）。
    "task:transfer:accept",
    // R13 公司策略中心：分公司管理员是本公司策略主责角色（存量库由 058 幂等补码；
    // manageOrgIds 闸门限本公司子树，总部管理员可改各分公司）。
    "device:box:policyCompany",
    "task:sign",
    "task:video",
    "sys:dept:view",
    "sys:user:view",
    "sys:user:write",
    "sys:user:role",
    "sys:user:security",
    // #26：本单位操作日志（scoped 由数据范围强制）
    "sys:oplog:read",
    "sys:oplog:export",
  ],
  // 组织简化（B1b/P3）：AGENCY_LEAD 废弃——存量持有者由迁移 056 改绑 BRANCH_ADMIN，
  // sys_role 14 停用不物理删；默认授权/模板不再含该项（权限码本身不删）。
  // R23（D5/任务 #66）：现场采样员最小任务入口＝读＋开始采样＋封箱，数据范围仍仅本人保管（scope4）。
  // 补 device:box:task（读，菜单/列表/详情门）＋task:sample-start＋task:seal；存量角色由 063 幂等补码。
  // 不给 send/sign/inspect/cancel/create/transfer 等码：寄出、签收、检测、取消、建单、划拨按钮不显示。
  SAMPLER: [
    ...OLD(["list", "detail", "status", "location", "track", "task"]),
    "task:sample-start",
    "task:seal",
  ],
  HOME_SWITCH: [],
};

/** 新库按角色编码写进去的默认授权。之后以角色页保存的为准。 */
export const DEFAULT_ROLE_PERMS = {
  ADMIN: ALL_PERMS.map((perm) => perm.code),
  ...Object.fromEntries(
    Object.entries(LEGACY_DEFAULTS).map(([code, list]) => [code, upgradeCodes(list)])
  ),
};
// #26/截图核对批2：现场采样员仅本人范围，不应有集团总览入口。旧 device:box:list 经升级
// 映射会扩出 monitor:overview，这里对 SAMPLER 显式剔除（存量库的收回见迁移 055c）。
DEFAULT_ROLE_PERMS.SAMPLER = DEFAULT_ROLE_PERMS.SAMPLER.filter(
  (code) => code !== "monitor:overview"
);

/** 角色页「常用模板」：一键套用后再改。suggestedScope 是建议数据范围（B4 范围选择器一键带入），与种子角色一致。 */
export const ROLE_TEMPLATES = [
  {
    key: "SAMPLER",
    label: "现场采样员",
    hint: "看自己保管的箱子：电量、箱盖、位置、轨迹；本人保管箱可开始采样、封箱（R23/D5）",
    suggestedScope: 4,
  },
  {
    key: "DISPATCH",
    label: "调度员",
    hint: "建采样任务（分公司内部调度）、推进流转、分配箱子",
    suggestedScope: 2,
  },
  {
    key: "VERIFY",
    label: "核验员",
    hint: "签收核验、看开关箱记录和任务期间上报",
    suggestedScope: 1,
  },
  {
    key: "DUTY",
    label: "值班员",
    hint: "盯告警、离线、低电量，看任务期间上报",
    suggestedScope: 1,
  },
  {
    key: "ASSET",
    label: "资产管理员",
    hint: "激活、改名、停用、分配、导出采样箱",
    suggestedScope: 1,
  },
  {
    key: "BRANCH_ADMIN",
    label: "分公司管理员",
    hint: "本单位的人员、账号安全、分配角色、操作日志，和日常任务",
    suggestedScope: 2,
  },
  {
    key: "LEADER",
    label: "只读领导",
    hint: "只看不改：箱子状态、任务、操作日志",
    suggestedScope: 1,
  },
].map((template) => ({ ...template, codes: DEFAULT_ROLE_PERMS[template.key] || [] }));

/* ---------------- 老迁移用的函数（保持原样） ---------------- */

/**
 * 迁移 029：补进已有角色的权限（当年的兼容规则）。现在新库没有老角色，这里只给更老的库升级用。
 * #26 B1：链尾追加 GRANT_055（持日志读补导出），与 upgradeCodes 同口径。
 */
export function upgradeRolePerms(code, current) {
  const have = new Set(current);
  const add = new Set();
  if (have.has("device:box:task")) add.add("task:sign").add("task:video");
  if (have.has("device:box:policyTask")) add.add("task:cancel");
  if (have.has("device:box:log")) add.add("task:log");
  for (const perm of grant055([...have, ...add])) add.add(perm);
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
