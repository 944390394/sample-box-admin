/**
 * 任务状态的颜色和每类任务的步骤，列表和详情共用。
 *
 * 结束状态、步骤序列的唯一一份在 `shared/taskFlow.js`，服务端流程校验用的就是它，
 * 这里只做展示层的映射；以前前端自己抄了一份只有「调拨/采样」两步表的 fallback，
 * 送检（待检测/已检测）和拒收退回（退回中/已退回）都画不出来，进度条是空白。
 */
import {
  ENDED_OK,
  ENDED_VOID,
  INSPECT_STEPS,
  isEnded,
  isEndedFor,
  isLegacySample,
  isLocalSample,
  isMergedSample,
  RETURN_STEPS,
  SAMPLE_FLOW,
  SAMPLE_OUTBOUND_STEPS,
  stepsOf as flowStepsOf,
} from "../../../../shared/taskFlow.js";
import { TRANSFER_STATUS } from "../doc-flow";

/**
 * 任务状态 tag 色（详情头共用）。R22 批1/P1-3：kind 感知终态——仅本地采样单
 * 「已封箱」是终态OK（success），与 isEndedFor/endedToneFor 同口径；合并单同名状态仍进行中。
 * 参数收任务对象（status/kind/localOnly），不再只吃 status，避免列表与详情对「结没结束」给出相反答案。
 */
export function taskStatusType(task: { status?: string; kind?: string; localOnly?: boolean }) {
  const status = String(task?.status || "");
  if (isEndedFor(task)) return ENDED_VOID.includes(status) ? "info" : "success";
  if (["待寄出", "待签收", "待核验", "待检测", "退回中"].includes(status)) return "warning";
  return "primary";
}

/**
 * 这张单的步骤：优先用服务端给的，没给（老接口）时按同一份流程表推。
 * 参数写成 object 是因为调用方有三种形状：列表行（Record<string, unknown>）、
 * PolicyTask、任务详情里的 task，都只读 steps/kind/status/trip 这几项。
 */
export function stepsOf(task: object): string[] {
  const steps = (task as { steps?: unknown }).steps;
  return Array.isArray(steps) && steps.length
    ? (steps as string[])
    : (flowStepsOf(task as Record<string, unknown>) as string[]);
}

/** 已经结束、不用再刷新的单子。 */
export { isEnded };

/** R23 按 kind＋状态判终态：仅本地采样单已封箱也是终态（合并单同名状态仍中间态）。 */
export { isEndedFor };

/** 旧采样单（带 trip 或停旧态）只读兼容；新建合并单恒为 false。详情页区分合并流/旧流用。 */
export { isLegacySample };

/** R23 三类型判别：仅本地采样 / 合并（采样后送检＋旧别名）。 */
export { isLocalSample, isMergedSample };

/** 结束的单子页头配色：按流程走完是 done，中途作废是 error。 */
export function endedTone(status?: string) {
  return ENDED_OK.includes(String(status || "")) ? "done" : "error";
}

/** R23 kind 感知页头配色：仅本地采样单已封箱是终态OK（done），其余按 endedTone。 */
export function endedToneFor(task?: { status?: string; kind?: string; localOnly?: boolean }) {
  if (!task) return "error";
  if (isLocalSample(task) && task.status === "已封箱") return "done";
  return endedTone(task.status);
}

/** 旧采样单的手选寄送方式（组织简化后不再手选），仅历史单详情说明用。 */
export const TRIP_TEXT: Record<string, string> = {
  单向: "寄出单位把箱子寄到采样单位，采样封箱后任务完成，箱子留在采样单位。",
  双向: "寄出单位把箱子寄到采样单位，采样封箱后寄回寄出单位，核验签收后完成。",
};

/**
 * 合并采样单（P6）主路径说明：R22 起方向由箱子当前归属派生（只读，不手选）。
 * 单向＝箱在分公司/总部：本地采样后寄检测站；双向＝箱在检测站：检测站寄出→分公司采样→寄回检测站。
 */
export const MERGED_FLOW_TEXT =
  "方向按箱子归属自动派生（只读）：箱在分公司＝单向，本地采样封箱后直寄唯一检测站（待采样 → 采样中 → 已封箱 → 在途 → 待签收 → 待检测 → 已检测）；箱在检测站＝双向，检测站先寄箱到采样分公司（待寄出 → 运送中 → 待采样），采样封箱后寄回检测站。签收后逐台扫码开始检测；待检测/已检测可退回寄出方。";

/** 合并采样单派生方向的说明（R22，详情页/建单页共用）。 */
export const MERGED_TRIP_TEXT: Record<string, string> = {
  单向: "箱子在采样单位本地：采样封箱后寄唯一检测站，签收后箱子归检测站。",
  双向: "箱子在检测站：检测站先寄到采样分公司（分公司确认到达后箱子交采样单位），采样封箱后寄回检测站。",
};

/**
 * R23 三类型建单卡片元数据：label＝类型名，desc＝一句话用途，flow＝流预览小字。
 * 采样＝仅本地（已封箱终态、箱留采样单位）；送检＝仅寄送（接收方固定检测站）；
 * 采样后送检＝合并全流（方向按箱归属派生）。
 */
export const KIND_META: { kind: string; label: string; desc: string; flow: string }[] = [
  {
    kind: "采样",
    label: "采样",
    desc: "只在本地采样，封箱后任务结束，箱子留在采样单位，不寄送检测站。",
    flow: "待采样 → 采样中 → 已封箱（结束）",
  },
  {
    kind: "送检",
    label: "送检",
    desc: "箱子已采样封箱，只寄送到唯一检测站检测；寄出方按箱子当前归属带出。",
    flow: "待寄出 → 运送中 → 待签收 → 待检测 → 已检测",
  },
  {
    kind: "采样后送检",
    label: "采样后送检",
    desc: "先本地采样封箱，再寄唯一检测站检测；方向按箱子归属自动派生（只读）。",
    flow: "待采样 → 采样中 → 已封箱 → 在途 → 待签收 → 待检测 → 已检测",
  },
];

/** 推进按钮上的文字，和服务端流转记录的动作名一致。 */
export const TASK_ACTIONS: Record<string, string> = {
  执行中: "开始执行",
  已完成: "完成",
  运送中: "确认寄出",
  待签收: "确认到达",
  已签收: "签收",
  已拒收: "拒收",
  已取消: "取消任务",
  采样中: "开始采样",
  已封箱: "封箱",
  // 合并单：封箱后寄往唯一检测站（旧采样单此处为寄回，文案统一为确认寄出）
  在途: "确认寄出",
  待核验: "到达核验点",
  // 带寄送的采样单：箱子寄到采样单位
  待采样: "确认到达",
  // 不是指定签收人的人代签，服务端记成「已签收」
  强制签收: "强制签收",
  // 送检测站的单：签收后待检测，检测站逐台扫码开始检测，也可以整张单一起
  待检测: "签收",
  已检测: "全部开始检测",
  // 返程：待检测/已检测（合并单）或待签收（旧调拨/送检）发起「拒收并退回」；
  // 退回中态由寄出方确认箱子已寄回，按钮叫「确认退回」（服务端流转记录仍记「接收退回」）
  退回中: "拒收并退回",
  已退回: "确认退回",
};

/** 推进后要写原因的动作。 */
export const NEEDS_REASON: Record<string, string> = {
  已拒收: "拒收原因",
  // 服务端对退回中同样强制要原因（「请填写退回原因」）；合并单从待检测/已检测直接发起退回
  退回中: "退回原因，如样品不合格、开箱超限",
  强制签收: "强制签收的原因，如签收人不在、开箱次数不对但样品完好",
};

/**
 * 状态多选下拉词表（批4/D2）：16 态分组与服务端 counts 同源（counts 键即状态名）。
 * 从 shared/taskFlow.js 流程常量派生，不另抄枚举；服务端 STATUS_KEYS 白名单同一份词汇。
 * 历史态＝056 映射前的旧终态（只读兼容，存量行仍可筛）。
 */
export const STATUS_GROUPS: { title: string; historical?: boolean; statuses: string[] }[] = [
  { title: "采样段", statuses: SAMPLE_FLOW.slice(0, 3) },
  { title: "寄送段", statuses: [...SAMPLE_OUTBOUND_STEPS, ...SAMPLE_FLOW.slice(3, 5)] },
  { title: "检测段", statuses: [...INSPECT_STEPS] },
  { title: "退回段", statuses: [...RETURN_STEPS] },
  { title: "作废终态", statuses: ENDED_VOID.filter((s) => s !== "已退回" && s !== "已撤销") },
  { title: "历史态（只读）", historical: true, statuses: ["待核验", "已签收", "已完成"] },
];

/** 划拨/调拨状态（R25 三态：类型选划拨时状态下拉切换口径）。 */
export const TRANSFER_STATUS_GROUP: { title: string; historical?: boolean; statuses: string[] } = {
  title: "划拨三态",
  statuses: [...TRANSFER_STATUS],
};

/** 具体状态全集（16＋划拨两态）：地址栏 status 多选 chips 与非法值判定用；伪态（进行中/已结束/签收）不在其中。 */
export const STATUS_FILTER_KEYS: string[] = [
  ...STATUS_GROUPS.flatMap((g) => g.statuses),
  ...TRANSFER_STATUS,
];

/** 类型下拉切换状态词表：划拨/调拨＝两态；其余＝16 态。 */
export function statusGroupsFor(kind?: string) {
  return kind === "划拨" || kind === "调拨" ? [TRANSFER_STATUS_GROUP] : STATUS_GROUPS;
}

/**
 * 类型下拉选项（批4/P2-1/P2-2）：默认三类（不传 kind，服务端白名单口径）；
 * 划拨主入口仍在调拨单，这里只读筛；历史调拨只读收尾入口（P2-2 预防性修）。
 */
export const KIND_FILTER_OPTIONS: { value: string; label: string; desc: string }[] = [
  { value: "", label: "三类（默认）", desc: "采样／送检／采样后送检" },
  { value: "采样", label: "采样", desc: "仅本地 · 3 步 · 封箱即结束" },
  { value: "送检", label: "送检", desc: "仅寄送 · 接收方固定唯一检测站" },
  { value: "采样后送检", label: "采样后送检", desc: "合并全流 · 方向按箱归属派生" },
  { value: "划拨", label: "划拨", desc: "三态接受时转移 · 无物流（主入口在调拨单）" },
  { value: "调拨", label: "调拨（历史只读）", desc: "迁移前旧单 · 只读收尾" },
];
