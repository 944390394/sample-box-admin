/**
 * 任务流程：每类任务的步骤和每一步能推进到哪里。服务端校验、权限和页面进度条都用这里。
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
 * 调拨单拒收时可以选「退回寄出单位」：不结束，加一段返程——退回中 → 已退回，寄出方扫码只能「接收退回」。
 */
export const TRIPS = ["单向", "双向"];

export const ENDED = ["已完成", "已签收", "已拒收", "已取消", "已检测", "已退回"];
/** SQL 里用：t.status NOT IN (ENDED_SQL)。 */
export const ENDED_SQL = ENDED.map((s) => `'${s}'`).join(",");

/** 检测站的两步：签收后待检测，全部开始检测后已检测。 */
export const INSPECT_STEPS = ["待检测", "已检测"];
/** 拒收并退回后的返程两步。 */
export const RETURN_STEPS = ["退回中", "已退回"];

export function stepsOf(task) {
  const tail = task.inspect ? INSPECT_STEPS : ["已签收"];
  if (task.kind === "调拨") {
    // 拒收并退回：签收那一步之后换成返程
    if (RETURN_STEPS.includes(task.status)) return ["待寄出", "运送中", "待签收", ...RETURN_STEPS];
    return ["待寄出", "运送中", "待签收", ...tail];
  }
  // 早期的通用任务只有这三步，按状态认出来
  if (["待执行", "执行中"].includes(task.status)) return ["待执行", "执行中", "已完成"];
  const sampling = ["待采样", "采样中", "已封箱"];
  if (task.trip === "单向") return ["待寄出", "运送中", ...sampling, "已完成"];
  const back = ["在途", "待核验", ...tail];
  if (task.trip === "双向") return ["待寄出", "运送中", ...sampling, ...back];
  return [...sampling, ...back];
}

/** 签收推进到哪一步：送检测站的到「待检测」，其余到「已签收」。 */
export function signTargetOf(task) {
  return task.inspect ? "待检测" : "已签收";
}

/** 新建时的第一步。 */
export function initialOf(task) {
  return stepsOf(task)[0];
}

/**
 * 从 status 能推进到哪些状态：流程里的下一步，加上签收那一步的拒收和任何时候的取消。
 * 拒收：调拨单在待签收时（可以选退回寄出单位）；采样单在待核验时（拒收即样品作废，比如开箱超限）。
 */
export function nextOf(task, status) {
  if (ENDED.includes(status)) return [];
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
