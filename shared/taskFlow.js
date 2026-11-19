/**
 * 任务流程：每类任务的步骤和每一步能推进到哪里。服务端校验、权限和页面进度条都用这里。
 *
 * 这里是服务端和网页共用的唯一一份（`server/src/settings/taskFlow.js` 只是转发到这里）。
 * 页面上的进度条步骤、「这张单结束了没有所以不用再轮询」以前各写一份枚举，
 * 「已检测」「已退回」后来才加到服务端，前端没跟上：进度条渲染成空白、已结束的单子还在 15 秒轮询。
 * 新增结束状态只改这里，两边一起生效。
 *
 * 三类单据（kind 是权威来源，单号前缀只是显示）：
 * - 采样 TK-：寄送方式 trip 单向/双向/不填，10 状态，不改；
 * - 送检 IN-：9 状态，「已签收」不是持久状态（待签收上签收直接落待检测）；
 * - 划拨 AL-：提交即生效，只有 已划拨/已撤销 两个终态，无物流步骤，只能走撤销端点、不走通用 transition。
 * 旧存储值「调拨」只读保留（历史进度条仍要渲染），不在 DOC_KINDS 枚举内。
 *
 * 采样单的寄送方式 trip：
 * - 单向：寄出单位把箱子寄到采样单位，到达后采样、封箱，任务完成，不寄回；
 * - 双向：寄去、采样、封箱后寄回寄出单位，核验签收；
 * - 不填（旧单）：箱子已在采样单位，直接采样，封箱后寄回核验。
 *
 * 送到检测站的单（建单时签收方是「采样机构」类型的单位——采样机构就是检测站，task.inspect 为真）：
 * 签收后不直接结束，先到「待检测」，检测站每台箱子扫码「开始检测」，这台箱子的本次任务就结束、
 * 开箱次数从下一张单重新算；全部开始检测后整张单变「已检测」。
 *
 * 调拨单（legacy，只读）：
 * - direct 为真：不定位、不发货，建单后直接待签收，接收单位签收后箱子归过去；
 * - 没有 direct（旧单）：待寄出 → 运送中 → 待签收。
 * 拒收时可以选「退回寄出单位」：不结束，加一段返程——退回中 → 已退回。
 */
export const TRIPS = ["单向", "双向"];

/** 新建单据的 kind 枚举；旧存储值「调拨」只读保留，不在其中。 */
export const DOC_KINDS = ["采样", "送检", "划拨"];

/** 走完流程结束的：调拨/采样签收完、老任务完成、检测站全部开始检测、划拨提交即生效。 */
export const ENDED_OK = ["已完成", "已签收", "已检测", "已划拨"];
/** 中途作废结束的（含划拨撤销）。 */
export const ENDED_VOID = ["已取消", "已拒收", "已退回", "已撤销"];

export const ENDED = [...ENDED_OK, ...ENDED_VOID];
/** SQL 里用：t.status NOT IN (ENDED_SQL)。划拨两态必须在此，否则被划拨过的箱子永远选不上（功能级死锁）。 */
export const ENDED_SQL = ENDED.map((s) => `'${s}'`).join(",");

/** 这张单是不是已经结束了：页面用它决定还显不显推进按钮、要不要继续轮询。 */
export function isEnded(status) {
  return ENDED.includes(String(status || ""));
}

/** 检测站的两步：签收后待检测，全部开始检测后已检测。 */
export const INSPECT_STEPS = ["待检测", "已检测"];
/** 拒收并退回后的返程两步。 */
export const RETURN_STEPS = ["退回中", "已退回"];

/** 划拨无物流步骤：进度条不渲染。 */
export const TRANSFER_STEPS = [];
/** 送检主路径 5 步（含首末态）。 */
export const INSPECT_FLOW = ["待寄出", "运送中", "待签收", "待检测", "已检测"];
/** 送检拒收并退回的返程路径。 */
export const INSPECT_RETURN_FLOW = ["待寄出", "运送中", "待签收", "退回中", "已退回"];

/** 单号前缀（显示用，kind 才是类型权威来源）。 */
export function prefixOf(kind) {
  if (kind === "划拨") return "AL-";
  if (kind === "送检") return "IN-";
  return "TK-";
}

export function stepsOf(task) {
  if (task.kind === "划拨") return TRANSFER_STEPS;
  if (task.kind === "送检")
    return RETURN_STEPS.includes(task.status) ? INSPECT_RETURN_FLOW : INSPECT_FLOW;
  const tail = task.inspect ? INSPECT_STEPS : ["已签收"];
  if (task.kind === "调拨") {
    // 直接调拨没有寄出、运送；旧单和带地址的调用仍走发货
    const head = task.direct ? ["待签收"] : ["待寄出", "运送中", "待签收"];
    // 拒收并退回：签收那一步之后换成返程
    if (RETURN_STEPS.includes(task.status)) return [...head, ...RETURN_STEPS];
    return [...head, ...tail];
  }
  // 早期的通用任务只有这三步，按状态认出来
  if (["待执行", "执行中"].includes(task.status)) return ["待执行", "执行中", "已完成"];
  const sampling = ["待采样", "采样中", "已封箱"];
  if (task.trip === "单向") return ["待寄出", "运送中", ...sampling, "已完成"];
  const back = ["在途", "待核验", ...tail];
  if (task.trip === "双向") return ["待寄出", "运送中", ...sampling, ...back];
  return [...sampling, ...back];
}

/** 签收推进到哪一步：送检/送检测站的到「待检测」，其余到「已签收」。 */
export function signTargetOf(task) {
  return task.kind === "送检" || task.inspect ? "待检测" : "已签收";
}

/** 新建时的第一步；划拨提交即生效，唯一持久结果态是已划拨。 */
export function initialOf(task) {
  if (task.kind === "划拨") return "已划拨";
  return stepsOf(task)[0];
}

/** 送检各状态的推进集合（检测站开始检测走 inspect 端点，不占 nextOf）。 */
const INSPECT_NEXT = {
  待寄出: ["运送中", "已取消"],
  运送中: ["待签收", "已取消"],
  待签收: ["待检测", "已拒收", "退回中", "已取消"],
  待检测: ["已检测", "已取消"],
  退回中: ["已退回"], // 退回途中不能取消
};

/**
 * 从 status 能推进到哪些状态：流程里的下一步，加上签收那一步的拒收和任何时候的取消。
 * 拒收：调拨单在待签收时（可以选退回寄出单位）；采样单在待核验时（拒收即样品作废，比如开箱超限）。
 * 划拨恒为 []：只能走撤销端点，不能走通用 transition。
 */
export function nextOf(task, status) {
  if (task.kind === "划拨") return [];
  if (ENDED.includes(status)) return [];
  if (task.kind === "送检") return INSPECT_NEXT[status] || [];
  const steps = stepsOf({ ...task, status });
  const index = steps.indexOf(status);
  if (index < 0 || index === steps.length - 1) return [];
  const next = [steps[index + 1]];
  if (
    (task.kind === "调拨" && status === "待签收") ||
    (task.kind === "采样" && status === "待核验")
  )
    next.push("已拒收");
  if (task.kind === "调拨" && status === "待签收") next.push("退回中");
  // 退回途中不能取消：箱子正在回寄出单位，只能等寄出方接收
  if (status === "退回中") return next;
  next.push("已取消");
  return next;
}
