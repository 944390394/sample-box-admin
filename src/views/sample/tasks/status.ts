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
  isEnded,
  isEndedFor,
  isLegacySample,
  isLocalSample,
  isMergedSample,
  stepsOf as flowStepsOf,
} from "../../../../shared/taskFlow.js";

export function taskStatusType(status: string) {
  if (ENDED_OK.includes(status)) return "success";
  if (ENDED_VOID.includes(status)) return "info";
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
