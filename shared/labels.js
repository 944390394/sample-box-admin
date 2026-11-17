/**
 * 页面上可以改的显示名称。键是数据库里的值或接口参数，不能改；只改显示文字。
 * 服务端校验和网页默认值都读这一份。
 */

export const LABEL_MAX = 8;

export const LABEL_GROUPS = [
  {
    key: "life",
    title: "生命周期",
    items: [
      { key: "待激活", label: "待激活" },
      { key: "未使用", label: "未使用" },
      { key: "在途", label: "在途" },
      { key: "停用", label: "停用" },
    ],
  },
  {
    key: "kind",
    title: "上报类型",
    items: [
      { key: "boot", label: "上电" },
      { key: "timer", label: "定时" },
      { key: "pad", label: "开箱" },
      { key: "shut", label: "关箱" },
      { key: "chg", label: "充电" },
      { key: "chgs", label: "充电状态" },
    ],
  },
  {
    key: "lid",
    title: "箱盖状态",
    items: [
      { key: "open", label: "开着" },
      { key: "closed", label: "关着" },
    ],
  },
  {
    key: "charge",
    title: "充电状态",
    items: [
      { key: "none", label: "未充电" },
      { key: "charging", label: "充电中" },
      { key: "full", label: "已充满" },
    ],
  },
  {
    key: "online",
    title: "在线状态",
    items: [
      { key: "online", label: "在线" },
      { key: "offline", label: "离线" },
      { key: "waitEvent", label: "等待事件上报" },
    ],
  },
  {
    key: "led",
    title: "指示灯",
    items: [
      { key: "stm", label: "STM 指示灯" },
      { key: "module", label: "4G 模块指示灯" },
    ],
  },
  {
    key: "tile",
    title: "状态卡标题",
    hint: "离线时自动在前面加「最后」",
    items: [
      { key: "battery", label: "可用电量" },
      { key: "lid", label: "箱盖" },
      { key: "signal", label: "信号" },
      { key: "place", label: "位置" },
    ],
  },
];

/** { life: { 待激活: "待激活", ... }, kind: {...}, ... } */
export function defaultLabels() {
  const result = {};
  for (const group of LABEL_GROUPS) {
    result[group.key] = {};
    for (const item of group.items) result[group.key][item.key] = item.label;
  }
  return result;
}

/** 按白名单取值：不认识的键丢掉，空值或过长回到默认。 */
export function normalizeLabels(input) {
  const source = input && typeof input === "object" ? input : {};
  const result = defaultLabels();
  for (const group of LABEL_GROUPS) {
    const given =
      source[group.key] && typeof source[group.key] === "object" ? source[group.key] : {};
    for (const item of group.items) {
      const text = typeof given[item.key] === "string" ? given[item.key].trim() : "";
      if (text && text.length <= LABEL_MAX) result[group.key][item.key] = text;
    }
  }
  return result;
}
