/**
 * 任务流程：每类任务的步骤和每一步能推进到哪里。服务端校验、权限和页面进度条都用这里。
 *
 * 这里是服务端和网页共用的唯一一份（`server/src/settings/taskFlow.js` 只是转发到这里）。
 * 页面上的进度条步骤、「这张单结束了没有所以不用再轮询」以前各写一份枚举，
 * 「已检测」「已退回」后来才加到服务端，前端没跟上：进度条渲染成空白、已结束的单子还在 15 秒轮询。
 * 新增结束状态只改这里，两边一起生效。
 *
 * 组织简化（B1a/P6）后两类新建单据（kind 是权威来源，单号前缀只是显示）：
 * - 采样 TK-：采样＋送检合并成一张单。接收方固定唯一检测站，签收后逐台扫码开始检测。
 *   寄送方向 trip（R22）由箱子当前归属派生、只读，不再手选：
 *   - 单向（箱在分公司/总部）：本地采样后寄检测站。主路径 7 步：
 *     待采样→采样中→已封箱→在途→待签收→待检测→已检测(终态OK)。
 *   - 双向（箱在检测站、采样单位是分公司）：检测站先把箱子寄到采样分公司（首腿 待寄出→运送中→待采样，
 *     分公司确认到达时归属交采样单位），采样封箱后寄回检测站。主路径 9 步＝首腿 2 步＋单向 7 步。
 *   分支：已取消（最终待签收之前可取消）；已拒收（签收动作可选拒收→终态）；
 *   退回中→已退回（待检测/已检测可发起退回，退回目的地＝寄出方 fromOrg＝建单时箱归属：
 *   单向回原寄出分公司，双向回检测站）。
 *   新建合并单恒写 tripDerived=true＋派生 trip；旧数据（无 tripDerived 标记）只读兼容。
 * - 划拨 AL-：提交即生效，只有 已划拨/已撤销 两个终态，无物流步骤，只能走撤销端点、不走通用 transition。
 *
 * 只读保留的旧 kind（历史进度条仍要渲染、在途旧单仍能收尾，但不再新建）：
 * - 送检 IN-：9 状态，INSPECT_* 常量保留供迁移映射（LEGACY_*）引用；
 * - 调拨：direct 直接调拨与旧发货调拨，拒收可退回寄出单位。
 *
 * 送到检测站的单（task.inspect 为真）：签收后不直接结束，先到「待检测」，检测站每台箱子扫码
 * 「开始检测」，这台箱子的本次任务就结束、开箱次数从下一张单重新算；全部开始检测后整张单变「已检测」。
 */

/** 寄送方向：R22 起由箱当前归属派生（deriveTrip），只读展示；旧单的手选值只读兼容。 */
export const TRIPS = ["单向", "双向"];

/**
 * 派生寄送方向（R22，用户拍板「箱在分公司就是分公司寄出，在检测站就是检测站寄出」）：
 * 箱当前归属＝唯一检测站 且 采样单位≠检测站 → 双向（检测站寄出→分公司采样→寄回检测站）；
 * 其余（箱在分公司/总部/未分配）→ 单向（本地采样后寄检测站）。
 * 入参一律 String 归一；检测站未解析（空）时恒单向。
 */
export function deriveTrip(boxOrgId, stationOrgId, samplerOrgId) {
  const at = String(boxOrgId ?? "");
  const station = String(stationOrgId ?? "");
  return at && station && at === station && String(samplerOrgId ?? "") !== station
    ? "双向"
    : "单向";
}

/**
 * 新建单据的 kind 枚举（R23 三类型反转合并）：
 * - 采样＝仅本地采样（待采样→采样中→已封箱终态OK，箱留采样单位，无寄送/检测站步）；
 * - 送检＝仅寄送（箱已采样封箱在寄出方，待寄出→运送中→待签收→待检测→已检测＋拒收/退回/取消）；
 * - 采样后送检＝采样＋送检合并全流（原 P6 合并单，R22 方向派生沿用）；
 * - 划拨＝归属立即转移（走 createTransfer）。
 * 旧存储值「调拨」只读保留，不在其中。旧「送检」只读形态与新送检同流（INSPECT_*）。
 */
export const DOC_KINDS = ["采样", "送检", "采样后送检", "划拨"];

/** 走完流程结束的：老任务完成、旧调拨签收完、检测站全部开始检测、划拨提交即生效。 */
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
/** 退回后的返程两步。 */
export const RETURN_STEPS = ["退回中", "已退回"];

/** 划拨无物流步骤：进度条不渲染。 */
export const TRANSFER_STEPS = [];
/** 旧送检主路径 5 步（只读保留，供历史进度条与迁移映射引用；不再用于新单）。 */
export const INSPECT_FLOW = ["待寄出", "运送中", "待签收", "待检测", "已检测"];
/** 旧送检拒收并退回的返程路径（只读保留）。 */
export const INSPECT_RETURN_FLOW = ["待寄出", "运送中", "待签收", "退回中", "已退回"];

/** 合并采样单主路径 7 步（P6，含首末态）：分公司自采→封箱→寄检测站→签收→逐台检测。 */
export const SAMPLE_FLOW = ["待采样", "采样中", "已封箱", "在途", "待签收", "待检测", "已检测"];
/**
 * 仅本地采样单主路径 3 步（R23）：待采样→采样中→已封箱（终态OK，箱留采样单位）。
 * 无寄送腿、无检测站步；已封箱即结束（不进全局 ENDED——合并单的同名状态仍是中间态）。
 */
export const SAMPLE_LOCAL_FLOW = ["待采样", "采样中", "已封箱"];
/**
 * 合并采样单退回路径：待检测/已检测可发起退回，回寄出方 fromOrg（单向＝原寄出分公司，双向＝检测站）。
 * 进度条把检测段换成返程（已检测后退回的，检测事实在流转记录里）。
 */
export const SAMPLE_RETURN_FLOW = [
  "待采样",
  "采样中",
  "已封箱",
  "在途",
  "待签收",
  "待检测",
  "退回中",
  "已退回",
];

/**
 * 双向合并单首腿（R22）：检测站寄出→分公司确认到达（签收，归属交采样单位）→待采样。
 * 沿用旧双向采样单的腿形（待寄出→运送中→待采样），不引入第二个「待签收」——
 * 步条/签收核验/状态计数都按状态名键控，重复态会破坏 indexOf 渲染。
 */
export const SAMPLE_OUTBOUND_STEPS = ["待寄出", "运送中"];
/** 双向合并单主路径 9 步＝首腿 2 步＋单向 7 步。 */
export const SAMPLE_ROUND_FLOW = [...SAMPLE_OUTBOUND_STEPS, ...SAMPLE_FLOW];
/** 双向合并单退回路径＝首腿 2 步＋单向退回 8 步。 */
export const SAMPLE_ROUND_RETURN_FLOW = [...SAMPLE_OUTBOUND_STEPS, ...SAMPLE_RETURN_FLOW];

/**
 * 这张采样单是不是旧数据（只读兼容）。判别按 tripDerived 标记＋inspect（review-org M2＋R22）：
 * - R22 新建合并单恒写 tripDerived=true＋派生 trip——先认标记，带 trip 也不是旧单；
 * - 合并单建单恒写 inspect=true；056 映射后的旧送检 body.inspect 也恒 true——它们走合并流；
 * - 旧采样单建单从不写 inspect（恒 falsy）——无论有没有 trip、停在哪个状态都是旧单，
 *   包括无 trip 停共享态「在途」的单（旧流 待采样→采样中→已封箱→在途→待核验→已签收），
 *   以及 056 把 待核验→待检测、已签收/已完成→已检测 映射后的单（收尾仍按旧核验语义）。
 * - 无 tripDerived 标记而带 trip 的旧单恒旧（含旧双向送采样机构 inspect=true 的单，不能误判成合并单）。
 * 只用于读兼容（进度条/推进）；R22 新建合并单恒为 false。
 */
export function isLegacySample(task) {
  if (task.kind !== "采样") return false;
  // R23 仅本地采样单（localOnly 标记）走新本地流，不是旧单
  if (task.localOnly === true) return false;
  if (task.tripDerived === true) return false;
  if (TRIPS.includes(task.trip)) return true;
  return !task.inspect;
}

/**
 * R23 三类型判别（kind 权威，localOnly/inspect 区分采样子形态）：
 * - 仅本地采样：kind=采样 且 localOnly=true（建单/060 回填写入）；
 * - 合并（采样后送检）：kind=采样后送检；兼容旧合并别名 kind=采样＋inspect=true（无 localOnly、非 legacy）——
 *   旧客户端/存量测试以 kind=采样 建合并单，060 后存量归一为 采样后送检，别名仅读兼容；
 * - 仅送检：kind=送检（新送检与旧送检只读形态同流）。
 */
export function isLocalSample(task) {
  return task.kind === "采样" && task.localOnly === true;
}
export function isMergedSample(task) {
  if (task.kind === "采样后送检") return true;
  return (
    task.kind === "采样" &&
    task.localOnly !== true &&
    !isLegacySample(task) &&
    (task.inspect === true || task.tripDerived === true)
  );
}
export function isInspectKind(task) {
  return task.kind === "送检";
}

/**
 * 这张单（按 kind＋状态）是不是结束了。全局 ENDED 之外，仅本地采样单的「已封箱」是终态OK
 * （合并单的同名状态仍是中间态，不能进全局 ENDED，否则占用 SQL 会提前释放合并单的箱子）。
 */
export function isEndedFor(task) {
  const status = String(task?.status || "");
  if (ENDED.includes(status)) return true;
  return isLocalSample(task) && status === "已封箱";
}

/**
 * 占用/进行中判定的 SQL 条件（别名默认 t）：全局 ENDED 之外，排除仅本地采样单已封箱终态。
 * localOnly 标记走 body LIKE（与 isLocalSample 同口径，SQLite/MySQL 通用），合并别名（inspect=true、
 * 无 localOnly）不受影响。所有「箱子是否被未结束单占用」「进行中任务」查询统一用它。
 */
export function activeTaskSql(alias = "t") {
  return (
    `(${alias}.status NOT IN (${ENDED_SQL}) AND NOT (` +
    `${alias}.kind = '采样' AND ${alias}.status = '已封箱' AND ${alias}.body LIKE '%"localOnly":true%'))`
  );
}

/** 单号前缀（显示用，kind 才是类型权威来源）。送检 IN- 只读保留。 */
export function prefixOf(kind) {
  if (kind === "划拨") return "AL-";
  if (kind === "送检") return "IN-";
  return "TK-";
}

export function stepsOf(task) {
  if (task.kind === "划拨") return TRANSFER_STEPS;
  // 送检（R23 新建＋旧只读同流）：仅寄送，无采样段
  if (task.kind === "送检")
    return RETURN_STEPS.includes(task.status) ? INSPECT_RETURN_FLOW : INSPECT_FLOW;
  // 旧调拨（只读）
  if (task.kind === "调拨") {
    const head = task.direct ? ["待签收"] : ["待寄出", "运送中", "待签收"];
    const tail = task.inspect ? INSPECT_STEPS : ["已签收"];
    if (RETURN_STEPS.includes(task.status)) return [...head, ...RETURN_STEPS];
    return [...head, ...tail];
  }
  // R23 仅本地采样单：3 步，已封箱终态
  if (isLocalSample(task)) return SAMPLE_LOCAL_FLOW;
  // 旧采样单（inspect 恒 falsy 或带 trip）：按旧流渲染
  if (isLegacySample(task)) {
    if (["待执行", "执行中"].includes(task.status)) return ["待执行", "执行中", "已完成"];
    const tail = task.inspect ? INSPECT_STEPS : ["已签收"];
    const sampling = ["待采样", "采样中", "已封箱"];
    if (task.trip === "单向") return ["待寄出", "运送中", ...sampling, "已完成"];
    const back = ["在途", "待核验", ...tail];
    if (task.trip === "双向") return ["待寄出", "运送中", ...sampling, ...back];
    // 056 映射后的旧无 trip 单（待核验→待检测、已签收/已完成→已检测）：
    // 旧流步骤里没有这两个状态，按合并流渲染检测段（终态语义已对齐，M2）。
    if (INSPECT_STEPS.includes(task.status)) return SAMPLE_FLOW;
    return [...sampling, ...back];
  }
  // 合并采样单（采样后送检；旧合并别名 kind=采样＋inspect 也走这里）：R22 双向带首腿，单向 7 步
  const base = RETURN_STEPS.includes(task.status) ? SAMPLE_RETURN_FLOW : SAMPLE_FLOW;
  return task.trip === "双向" ? [...SAMPLE_OUTBOUND_STEPS, ...base] : base;
}

/** 签收推进到哪一步：合并采样单/送检/送检测站的到「待检测」，旧调拨/旧采样到「已签收」。 */
export function signTargetOf(task) {
  if (isMergedSample(task)) return "待检测";
  return task.kind === "送检" || task.inspect ? "待检测" : "已签收";
}

/** 新建时的第一步；划拨提交即生效，唯一持久结果态是已划拨。 */
export function initialOf(task) {
  if (task.kind === "划拨") return "已划拨";
  return stepsOf(task)[0];
}

/** 旧送检各状态的推进集合（只读保留；检测站开始检测走 inspect 端点，不占 nextOf）。 */
const INSPECT_NEXT = {
  待寄出: ["运送中", "已取消"],
  运送中: ["待签收", "已取消"],
  待签收: ["待检测", "已拒收", "退回中", "已取消"],
  待检测: ["已检测", "已取消"],
  退回中: ["已退回"], // 退回途中不能取消
};

/**
 * 合并采样单各状态的推进集合（P6）。
 * 已取消只在待签收之前（待采样/采样中/已封箱/在途）；待签收只能签收或拒收；
 * 待检测/已检测可发起退回（已检测是终态OK，但仍允许退回，故单列）；退回途中不能取消。
 */
const SAMPLE_NEXT = {
  待采样: ["采样中", "已取消"],
  采样中: ["已封箱", "已取消"],
  已封箱: ["在途", "已取消"],
  在途: ["待签收", "已取消"],
  待签收: ["待检测", "已拒收"],
  待检测: ["已检测", "退回中"],
  已检测: ["退回中"],
  退回中: ["已退回"],
};

/**
 * 双向合并单（R22）：首腿 待寄出→运送中→待采样（分公司确认到达＝签收，归属交采样单位），
 * 之后与单向完全一致。首腿也在最终待签收之前，可取消。
 */
const SAMPLE_ROUND_NEXT = {
  待寄出: ["运送中", "已取消"],
  运送中: ["待采样", "已取消"],
  ...SAMPLE_NEXT,
};

/**
 * 仅本地采样单（R23）：待采样→采样中→已封箱（终态OK）。已封箱之前可取消；
 * 已封箱即结束（无寄送/检测站步），不再推进。
 */
const SAMPLE_LOCAL_NEXT = {
  待采样: ["采样中", "已取消"],
  采样中: ["已封箱", "已取消"],
  已封箱: [],
};

/**
 * 从 status 能推进到哪些状态。划拨恒为 []（只能走撤销端点）。
 * 合并采样单按 SAMPLE_NEXT（双向带首腿 SAMPLE_ROUND_NEXT）；旧送检/调拨/采样按各自旧流（读兼容）。
 */
export function nextOf(task, status) {
  if (task.kind === "划拨") return [];
  if (task.kind === "送检") return ENDED.includes(status) ? [] : INSPECT_NEXT[status] || [];
  // R23 仅本地采样单：已封箱终态，之前可取消
  if (isLocalSample(task)) return SAMPLE_LOCAL_NEXT[status] || [];
  if (isMergedSample(task))
    return (task.trip === "双向" ? SAMPLE_ROUND_NEXT : SAMPLE_NEXT)[status] || [];
  if (ENDED.includes(status)) return [];
  // 056 映射后的旧无 trip 采样单（待核验→待检测，M2）：收尾按旧核验语义——
  // 推进到已检测（已签收的映射像）、可拒收/取消；不进合并单的新退回分支（无检测站交接事实）。
  if (task.kind === "采样" && !task.trip && !task.inspect && status === "待检测")
    return ["已检测", "已拒收", "已取消"];
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

/**
 * 存量单据迁移映射（P7，供 B1b 迁移 056_org_simplify 引用）。
 * kind：送检并入采样；采样/调拨/划拨 不变（调拨只读保留）。映射外按同名（identity）。
 */
export const LEGACY_KIND_MAP = { 送检: "采样" };

/**
 * 状态映射（按旧 kind 分组）：未列出的状态同名保留。
 * - 送检：待寄出→已封箱、运送中→在途，其余同名（待签收/待检测/已检测/已拒收/已取消/退回中/已退回）。
 * - 旧采样：待核验→待检测、已签收→已检测、已完成→已检测（终态语义对齐），其余同名。
 * 终态语义保持：ENDED_OK→ENDED_OK、ENDED_VOID→ENDED_VOID（已签收/已完成 归并到 已检测）。
 */
export const LEGACY_STATUS_MAP = {
  送检: { 待寄出: "已封箱", 运送中: "在途" },
  采样: { 待核验: "待检测", 已签收: "已检测", 已完成: "已检测" },
};

/** 迁移用：把旧 kind 映射到新 kind（映射外同名）。 */
export function migrateKind(kind) {
  return LEGACY_KIND_MAP[kind] ?? kind;
}

/** 迁移用：把旧 kind 下的旧状态映射到新状态（映射外同名）。 */
export function migrateStatus(kind, status) {
  return LEGACY_STATUS_MAP[kind]?.[status] ?? status;
}
