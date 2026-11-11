/** 任务状态的颜色和每类任务的步骤，列表和详情共用。 */
export function taskStatusType(status: string) {
  if (["已签收", "已完成", "已检测"].includes(status)) return "success";
  if (["已取消", "已拒收", "已退回"].includes(status)) return "info";
  if (["待签收", "待核验", "待检测", "退回中"].includes(status)) return "warning";
  return "primary";
}

export const TASK_STEPS: Record<string, string[]> = {
  调拨: ["待寄出", "运送中", "待签收", "已签收"],
  采样: ["待采样", "采样中", "已封箱", "在途", "待核验", "已签收"],
};

/** 这张单的步骤：服务端按类型和寄送方式给出，旧接口没给时按类型取。 */
export function stepsOf(task: { kind?: unknown; steps?: unknown }) {
  return Array.isArray(task.steps) && task.steps.length
    ? (task.steps as string[])
    : TASK_STEPS[String(task.kind)] || [];
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
