/**
 * 全站统一的状态颜色。页面不再各自写 if/else 判断颜色，统一从这里取 el-tag 的 type。
 */
export type Tone = "success" | "primary" | "warning" | "danger" | "info";

/** 采样箱生命周期。 */
export function lifeTone(life?: string): Tone {
  if (life === "未使用") return "success";
  if (life === "在途") return "primary";
  if (life === "待激活") return "warning";
  return "info";
}

/** 任务状态（采样/送检/划拨共用；口径对齐 shared/taskFlow.js 的终态集合）。 */
export function taskTone(status?: string): Tone {
  // 划拨：已划拨 ok / 已撤销 neutral（设计基准 README.md:94）
  if (status === "已划拨") return "success";
  if (status === "已撤销") return "info";
  if (["已签收", "已完成", "已检测"].includes(status || "")) return "success";
  if (["已取消", "已拒收", "已退回"].includes(status || "")) return "info";
  if (["待检测", "退回中", "待签收", "待核验"].includes(status || "")) return "warning";
  return "primary";
}

/** 划拨单状态色：已划拨 success / 已撤销 info（neutral）。 */
export function transferTone(status?: string): Tone {
  return status === "已划拨" ? "success" : "info";
}

/** 录像请求状态。 */
export function videoTone(status?: string): Tone {
  if (status === "已完成") return "success";
  if (status === "失败") return "danger";
  if (status === "平台未接入") return "info";
  return "primary";
}

/** 上报类型：开箱红、关箱绿、上电蓝、充电黄、定时灰。 */
export function kindTone(kind?: string): Tone {
  if (kind === "pad") return "danger";
  if (kind === "shut") return "success";
  if (kind === "boot") return "primary";
  if (kind === "chg") return "warning";
  return "info";
}

/** 电量百分比的颜色。 */
export function batteryColor(percent: number) {
  return percent < 20 ? "#dc2626" : percent < 50 ? "#ea580c" : "#16a34a";
}
