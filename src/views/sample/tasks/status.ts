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
  stepsOf as flowStepsOf,
} from "../../../../shared/taskFlow.js";

export function taskStatusType(status: string) {
  if (ENDED_OK.includes(status)) return "success";
  if (ENDED_VOID.includes(status)) return "info";
  if (["待签收", "待核验", "待检测", "退回中"].includes(status)) return "warning";
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

/** 结束的单子页头配色：按流程走完是 done，中途作废是 error。 */
export function endedTone(status?: string) {
  return ENDED_OK.includes(String(status || "")) ? "done" : "error";
}

/** 采样单的寄送方式，建单页和详情页的说明共用。 */
export const TRIP_TEXT: Record<string, string> = {
  单向: "寄出单位把箱子寄到采样单位，采样封箱后任务完成，箱子留在采样单位。",
  双向: "寄出单位把箱子寄到采样单位，采样封箱后寄回寄出单位，核验签收后完成。",
};

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
  在途: "寄回",
  待核验: "到达核验点",
  // 带寄送的采样单：箱子寄到采样单位
  待采样: "确认到达",
  // 不是指定签收人的人代签，服务端记成「已签收」
  强制签收: "强制签收",
  // 送检测站的单：签收后待检测，检测站逐台扫码开始检测，也可以整张单一起
  待检测: "签收",
  已检测: "全部开始检测",
  // 调拨单拒收时选退回：返程，寄出方收到后接收
  退回中: "拒收并退回",
  已退回: "接收退回",
};

/** 推进后要写原因的动作。 */
export const NEEDS_REASON: Record<string, string> = {
  已拒收: "拒收原因",
  退回中: "拒收原因",
  强制签收: "强制签收的原因，如签收人不在、开箱次数不对但样品完好",
};
