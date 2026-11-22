/**
 * 单据类型/状态枚举的前端收口点：唯一事实源是 shared/taskFlow.js（服务端流程校验用的同一份，
 * server/src/settings/taskFlow.js 只是转发垫片）。这里直接 import 它并派生页面要用的状态数组，
 * 不再各页抄一份枚举（以前 data.ts 的 TransferStatus 还是旧物流六态，早已陈旧）。
 *
 * 三类单据（kind 是权威来源，单号前缀只是显示）：
 * - 采样 TK-：10 状态，trip 单向/双向/不寄送；
 * - 送检 IN-：9 状态，「已签收」不是持久状态（待签收上签收直接落待检测）；
 * - 划拨 AL-（R25 三态）：待接受→已完成＋接受前出口已取消/已拒收；历史已划拨/已撤销只读别名。
 * 旧存储值「调拨」只读保留，不在 DOC_KINDS 新建枚举内。
 */
import {
  DOC_KINDS,
  ENDED,
  ENDED_OK,
  ENDED_VOID,
  INSPECT_FLOW,
  INSPECT_RETURN_FLOW,
  isEnded,
  nextOf,
  prefixOf,
  signTargetOf,
  stepsOf,
} from "../../../shared/taskFlow.js";

export { DOC_KINDS, ENDED, ENDED_OK, ENDED_VOID, isEnded, nextOf, prefixOf, signTargetOf, stepsOf };

/** 划拨单持久状态（R25 三态）：待接受＋四终态＋历史已划拨别名（读兼容）。 */
export const TRANSFER_STATUS = [
  "待接受",
  "已完成",
  "已取消",
  "已拒收",
  "已撤销",
  "已划拨",
] as const;

/**
 * 送检单 9 个持久状态 = 主路径 ∪ 返程路径 ∪ {已拒收, 已取消}（去重）。
 * 从 shared/taskFlow.js 的两条 5 步流程派生，避免与服务端漂移；「已签收」不在其中（非持久态）。
 */
export const INSPECT_STATUS: string[] = Array.from(
  new Set([...INSPECT_FLOW, ...INSPECT_RETURN_FLOW, "已拒收", "已取消"])
);

/** 送检进行中 5 态（非终态）。 */
export const INSPECT_ACTIVE: string[] = INSPECT_STATUS.filter((s) => !isEnded(s));
/** 送检终态 4 态。 */
export const INSPECT_ENDED: string[] = INSPECT_STATUS.filter((s) => isEnded(s));

/** 单据类型标签色（R23 三态）：采样 success / 送检 warning / 采样后送检 primary / 划拨 primary。 */
export function kindTone(kind?: string): "success" | "primary" | "warning" | "info" {
  if (kind === "采样") return "success";
  if (kind === "送检") return "warning";
  if (kind === "采样后送检") return "primary";
  if (kind === "划拨") return "primary";
  return "info";
}

/**
 * R23 三态类型显示名：服务端 displayKind 优先；裸对象按 kind＋localOnly/inspect 推断——
 * 采样＋localOnly＝采样（仅本地）；采样＋inspect/合并别名＝采样后送检；其余按 kind。
 */
export function kindLabel(task?: {
  kind?: string;
  displayKind?: string;
  localOnly?: boolean;
  inspect?: boolean;
  tripDerived?: boolean;
}): string {
  if (!task) return "";
  if (task.displayKind) return task.displayKind;
  if (task.kind === "采样") {
    if (task.localOnly === true) return "采样";
    if (task.inspect === true || task.tripDerived === true) return "采样后送检";
    return "采样";
  }
  return task.kind || "";
}

/** 送检行首方向标签：退回中/已退回 是「退回」（warn），其余「送检」（info）。 */
export function inspectDir(status?: string): "送检" | "退回" {
  return status === "退回中" || status === "已退回" ? "退回" : "送检";
}
