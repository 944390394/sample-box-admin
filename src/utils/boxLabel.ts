/**
 * 采样箱称谓的统一口径（M-1）。
 *
 * 两件事叠在一起：
 * 1. 箱子编号现在就是 IMEI（独立代理键还没落地，见 reports/refactor-plans.md），所以页面上出现 `id`
 *    就等于出现设备标识；没有「设备标识」权限的角色（现场采样员、调度员默认如此）不该看到整串。
 * 2. 库里名称为空时服务端 toJSON 会把编号回显进 `name`（`name: this.name || this.id`），
 *    于是 `name || id` 这种写法在两种情况下都会写出整串 IMEI。
 *
 * 规则：名称一律走 boxName / realBoxName，设备标识一律走 imeiText，
 * 只有一句话的位置（弹窗抬头、提示、确认文案）走 boxTitle。
 * 这里只做纯字符串判断，不依赖 stores，公共组件和页面都能用。
 */

/** 称谓函数需要的几个字段，SampleBox / Partial<SampleBox> 都能传进来。 */
export interface BoxLabelSource {
  id?: string | null;
  name?: string | null;
  imei?: string | null;
  masked?: string[] | null;
}

/** 没有真实名称时的占位，不含任何设备标识。 */
export const UNNAMED_BOX = "未命名采样箱";

/** 15 位纯数字：按 IMEI 对待（现在的编号就是这个形态）。 */
export function isImeiLike(text?: string | null) {
  return /^\d{15}$/.test(String(text ?? "").trim());
}

/** 前 3 后 4、中间打码，和服务端 maskImei 同规则。只在本地手里只有整串编号时用。 */
export function maskImeiText(text?: string | null) {
  const value = String(text ?? "").trim();
  if (!value) return "";
  if (value.length < 8) return "****";
  return `${value.slice(0, 3)}${"*".repeat(value.length - 7)}${value.slice(-4)}`;
}

/**
 * 真实名称，没起名时是空串。
 * 编号回显出来的那种「名称」在这里会被判成没有名字，绝不能填进改名输入框。
 */
export function realBoxName(box?: BoxLabelSource | null) {
  const id = String(box?.id ?? "").trim();
  const name = String(box?.name ?? "").trim();
  return name && !(name === id && isImeiLike(id)) ? name : "";
}

/**
 * 页面上所有显示 IMEI 的地方都走这里。
 * - 服务端给了 imei：有「设备标识」权限是整串，没有是打码串，直接用；
 * - masked 里有 imei 或 identity（老接口没带 imei 字段）：不能拿 id 顶上——现在的 id 就是 IMEI，写「无权查看」；
 * - 两者都没有（本地示例数据、老缓存、只有编号的历史引用）：编号是 IMEI 就在本地打码，不是 IMEI 才退回编号。
 */
export function imeiText(box?: BoxLabelSource | null) {
  if (box?.imei) return box.imei;
  if (box?.masked?.includes("imei") || box?.masked?.includes("identity")) return "无权查看";
  const id = String(box?.id ?? "").trim();
  if (!id) return "—";
  return isImeiLike(id) ? maskImeiText(id) : id;
}

/**
 * 「名称」列。真实名称优先；老数据 BOX-001、业务编号 ZC-SZ-010 这类不是 IMEI 的编号照旧当名称显示；
 * 真的没名字时给不泄漏的占位，设备标识只在 imeiText 那一行按权限出现。
 */
export function boxName(box?: BoxLabelSource | null, fallback = UNNAMED_BOX) {
  const name = realBoxName(box);
  if (name) return name;
  const id = String(box?.id ?? "").trim();
  return id && !isImeiLike(id) ? id : fallback;
}

/**
 * 只有一句话的位置（弹窗抬头、提示文案、删除确认）：先认真实名称，
 * 没名字时用 imeiText，整串 IMEI 不会从这里漏出去。
 */
export function boxTitle(box?: BoxLabelSource | null) {
  const name = realBoxName(box);
  if (name) return name;
  const id = String(box?.id ?? "").trim();
  return id && !isImeiLike(id) ? id : imeiText(box);
}

/** 激活、改名输入框的提示：没有真名时只写文案，绝不把编号回显出来的 IMEI 念给用户。 */
export function boxNameHint(box?: BoxLabelSource | null) {
  const name = realBoxName(box);
  return name ? `不填用默认名称：${name}` : "名称（选填），不填保留现有名称";
}

/**
 * 下载文件名用的称谓：打码串里有星号，Windows 文件名不合法，所以这里不出现打码 IMEI；
 * 没名字就用不含标识的占位。
 */
export function boxFileName(box?: BoxLabelSource | null) {
  const name = boxName(box).replace(/[\\/:*?"<>|]/g, "_");
  return name || UNNAMED_BOX;
}
