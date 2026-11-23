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
 *   寄送方向 trip（R28/任务 #92）改回可选：单向/双向，默认单向；建单要求箱在寄出分公司
 *   （箱在检测站→拒，回分公司请用划拨）。方向语义由 body.tripMode 分流：
 *   - oneWay（单向）：本地采样后寄检测站，检测完箱留检测站。主路径 7 步：
 *     待采样→采样中→已封箱→在途→待签收→待检测→已检测(终态OK)。
 *   - return（双向，R28 新语义）：合并流＋寄回腿，主路径 11 步＝单向 7 步＋
 *     待寄回→寄回在途→待归还→已归还(终态OK)。已检测→待寄回→寄回在途→待归还 归检测站，
 *     待归还→已归还（签收归还）归寄出分公司：箱归属回 fromOrg＋保管人清空。
 *     已检测在 return 单里是中间态（占用保持到已归还，isEndedFor/activeTaskSql 例外）。
 *   - stationFirst（历史 R22 派生双向，067 打标）：箱在检测站、检测站先寄到采样分公司
 *     （首腿 待寄出→运送中→待采样，分公司确认到达时归属交采样单位），采样封箱后寄回检测站。
 *     主路径 9 步＝首腿 2 步＋单向 7 步。只读保留旧语义，新单不再产生。
 *   分支：已取消（最终待签收之前可取消）；已拒收（签收动作可选拒收→终态）；
 *   退回中→已退回（待检测/已检测可发起退回，退回目的地＝寄出方 fromOrg＝建单时箱归属）。
 *   新建合并单恒写 tripDerived=true＋tripMode；旧数据（无 tripDerived 标记）只读兼容。
 * - 划拨 AL-（R25 三态，任务 #71）：创建→待接受→（目标分公司管理员）接受→已完成；归属在接受时转移。
 *   接受前出口＝创建方取消（已取消）＋接收方拒收（已拒收，原因必填）；接受后不可撤销，只能重新划拨。
 *   待接受是进行中态（占用箱子，不在 ENDED）；已完成/已取消/已拒收是终态。无物流步骤，
 *   走专用 accept/cancel/reject/tracking 端点、不走通用 transition（nextOf 恒 []）。
 *   历史两态（R24 前）：已划拨→已完成（064 迁移映射，接受人不伪造）、已撤销只读保留——两者仍在 ENDED 当别名。
 *
 * 只读保留的旧 kind（历史进度条仍要渲染、在途旧单仍能收尾，但不再新建）：
 * - 送检 IN-：9 状态，INSPECT_* 常量保留供迁移映射（LEGACY_*）引用；
 * - 调拨：direct 直接调拨与旧发货调拨，拒收可退回寄出单位。
 *
 * 送到检测站的单（task.inspect 为真）：签收后不直接结束，先到「待检测」，检测站每台箱子扫码
 * 「开始检测」，这台箱子的本次任务就结束、开箱次数从下一张单重新算；全部开始检测后整张单变「已检测」。
 */

/** 寄送方向：R28 起寄送类（送检/采样后送检）建单可选，默认单向；旧单的手选/派生值只读兼容。 */
export const TRIPS = ["单向", "双向"];

/**
 * 方向语义分流（R28/任务 #92，body.tripMode）：
 * - oneWay：单向（检测完箱留检测站）；
 * - return：双向寄回腿（检测完寄回寄出分公司，分公司签收归还）；
 * - stationFirst：历史 R22 派生双向（检测站首腿寄出→分公司采样→寄回检测站），只读保留。
 * 067 给存量合并单打标：旧 trip=双向→stationFirst、旧单向→oneWay；新单恒写显式 tripMode。
 */
export const TRIP_MODES = ["oneWay", "return", "stationFirst"];

/**
 * 这张单的方向语义。显式 body.tripMode 优先（新单/067 回填）；
 * 无标记的存量合并单按 trip 推断：双向＝R22 派生的站首腿（stationFirst），其余＝oneWay。
 * 只对合并单/送检有意义；旧采样单（isLegacySample）走自己的旧流，不读本函数。
 */
export function tripModeOf(task) {
  if (TRIP_MODES.includes(task?.tripMode)) return task.tripMode;
  return isMergedSample(task) && task?.trip === "双向" ? "stationFirst" : "oneWay";
}

/**
 * 派生寄送方向（R22 历史口径，仅供 059 迁移与未迁移库读时回算兜底；R28 新建单不再派生）：
 * 箱当前归属＝唯一检测站 且 采样单位≠检测站 → 双向（站首腿）；其余 → 单向。
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
 * - 划拨＝归属接受时转移（走 createTransfer→accept，R25 三态）。
 * 旧存储值「调拨」只读保留，不在其中。旧「送检」只读形态与新送检同流（INSPECT_*）。
 */
export const DOC_KINDS = ["采样", "送检", "采样后送检", "划拨"];

/** 走完流程结束的：老任务完成、旧调拨签收完、检测站全部开始检测、双向寄回分公司签收归还、划拨接受完成（已划拨＝历史别名）。 */
export const ENDED_OK = ["已完成", "已签收", "已检测", "已归还", "已划拨"];
/** 中途作废结束的（含划拨取消/拒收/历史撤销）。 */
export const ENDED_VOID = ["已取消", "已拒收", "已退回", "已撤销"];

export const ENDED = [...ENDED_OK, ...ENDED_VOID];
/**
 * SQL 里用：t.status NOT IN (ENDED_SQL)。划拨终态（已完成/已取消/已拒收＋历史已划拨/已撤销）必须在此，
 * 否则被划拨过的箱子永远选不上（功能级死锁）；待接受是进行中态、不在此——接受前箱子被这张单占用。
 */
export const ENDED_SQL = ENDED.map((s) => `'${s}'`).join(",");

/** 这张单是不是已经结束了：页面用它决定还显不显推进按钮、要不要继续轮询。 */
export function isEnded(status) {
  return ENDED.includes(String(status || ""));
}

/** 检测站的两步：签收后待检测，全部开始检测后已检测。 */
export const INSPECT_STEPS = ["待检测", "已检测"];
/** 退回后的返程两步。 */
export const RETURN_STEPS = ["退回中", "已退回"];
/**
 * 双向寄回腿（R28/任务 #92，tripMode=return）：已检测后检测站发起寄回→寄回在途→待归还，
 * 寄出分公司签收归还（已归还，终态OK：箱归属回 fromOrg＋保管人清空）。
 * 待寄回/寄回在途/待归还的动作门＝检测站；已归还签收门＝寄出分公司。
 */
export const RETURN_LEG_STEPS = ["待寄回", "寄回在途", "待归还", "已归还"];

/** 划拨无物流步骤：通用任务进度条不渲染（详情页用 TRANSFER_TRACK 三步条，R25）。 */
export const TRANSFER_STEPS = [];
/**
 * 划拨三态主路径（R25，任务 #71）：待接受→已完成。待接受是进行中态（占用箱子）；
 * 接受前出口见 TRANSFER_EXIT；历史已划拨/已撤销是只读别名（LEGACY_STATUS_MAP.划拨）。
 */
export const TRANSFER_FLOW = ["待接受", "已完成"];
/** 接受前支链出口（终态作废）：创建方取消→已取消；接收方拒收→已拒收（原因必填）。 */
export const TRANSFER_EXIT = ["已取消", "已拒收"];
/** 划拨详情三步条（显示用，非持久态）：创建划拨→接受划拨→已完成；终态末补支链格由页面按状态渲染。 */
export const TRANSFER_TRACK = ["创建划拨", "接受划拨", "已完成"];
/** 旧送检主路径 5 步（只读保留，供历史进度条与迁移映射引用；不再用于新单）。 */
export const INSPECT_FLOW = ["待寄出", "运送中", "待签收", "待检测", "已检测"];
/** 旧送检拒收并退回的返程路径（只读保留）。 */
export const INSPECT_RETURN_FLOW = ["待寄出", "运送中", "待签收", "退回中", "已退回"];
/** 送检双向（R28 tripMode=return）主路径 9 步＝仅寄送 5 步＋寄回腿 4 步。 */
export const INSPECT_RETURN_LEG_FLOW = [...INSPECT_FLOW, ...RETURN_LEG_STEPS];

/** 合并采样单主路径 7 步（P6，含首末态）：分公司自采→封箱→寄检测站→签收→逐台检测。 */
export const SAMPLE_FLOW = ["待采样", "采样中", "已封箱", "在途", "待签收", "待检测", "已检测"];
/**
 * 仅本地采样单主路径 3 步（R23）：待采样→采样中→已封箱（终态OK，箱留采样单位）。
 * 无寄送腿、无检测站步；已封箱即结束（不进全局 ENDED——合并单的同名状态仍是中间态）。
 */
export const SAMPLE_LOCAL_FLOW = ["待采样", "采样中", "已封箱"];
/**
 * 合并采样单退回路径：待检测/已检测可发起退回，回寄出方 fromOrg（单向/新双向＝原寄出分公司，
 * 历史 stationFirst 双向＝检测站）。进度条把检测段换成返程（已检测后退回的，检测事实在流转记录里）。
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
 * 双向合并单（R28 tripMode=return）主路径 11 步＝单向 7 步＋寄回腿 4 步。
 * 已检测在此是中间态（箱仍占用，等检测站寄回）；已归还终态OK。
 */
export const SAMPLE_RETURN_LEG_FLOW = [...SAMPLE_FLOW, ...RETURN_LEG_STEPS];

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
 * 这张单（按 kind＋状态）是不是结束了。全局 ENDED 之外：
 * - 仅本地采样单的「已封箱」是终态OK（合并单的同名状态仍是中间态，不能进全局 ENDED，
 *   否则占用 SQL 会提前释放合并单的箱子）；
 * - 双向寄回单（tripMode=return）的「已检测」是中间态（箱等检测站寄回，占用保持到已归还），
 *   虽然同名状态在全局 ENDED 里（单向/送检/旧单仍是终态）。
 */
export function isEndedFor(task) {
  const status = String(task?.status || "");
  if (tripModeOf(task) === "return" && status === "已检测") return false;
  if (ENDED.includes(status)) return true;
  return isLocalSample(task) && status === "已封箱";
}

/**
 * 占用/进行中判定的 SQL 条件（别名默认 t）：全局 ENDED 之外，排除仅本地采样单已封箱终态、
 * 把双向寄回单（body.tripMode=return）的已检测算回进行中（与 isEndedFor 同口径）。
 * localOnly/tripMode 标记走 body LIKE（SQLite/MySQL 通用），合并别名（inspect=true、
 * 无 localOnly）不受影响。所有「箱子是否被未结束单占用」「进行中任务」查询统一用它。
 */
export function activeTaskSql(alias = "t") {
  return (
    `((${alias}.status NOT IN (${ENDED_SQL}) OR ` +
    `(${alias}.body LIKE '%"tripMode":"return"%' AND ${alias}.status = '已检测')) AND NOT (` +
    `${alias}.kind = '采样' AND ${alias}.status = '已封箱' AND ${alias}.body LIKE '%"localOnly":true%'))`
  );
}

/**
 * busy 查询里「这台箱子还被这张单攥着」的谓词（R28）：通常检测站开始检测后箱子不再算占用
 * （inspected_at 非空即放行下一张单）；但双向寄回单在 已检测→待寄回→寄回在途→待归还 期间
 * 箱子还在本单流程里（要寄回分公司），检测事实不解除占用，到已归还才释放。
 * 与 activeTaskSql 组合使用：`... AND ${activeTaskSql()} AND ${boxHeldSql()}`。
 */
export function boxHeldSql(taskAlias = "t", linkAlias = "m") {
  return (
    `(${linkAlias}.inspected_at IS NULL OR ` +
    `(${taskAlias}.body LIKE '%"tripMode":"return"%' AND ` +
    `${taskAlias}.status IN ('已检测','待寄回','寄回在途','待归还')))`
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
  // 送检（R23 新建＋旧只读同流）：仅寄送，无采样段；R28 双向（return）带寄回腿
  if (task.kind === "送检") {
    if (RETURN_STEPS.includes(task.status)) return INSPECT_RETURN_FLOW;
    return tripModeOf(task) === "return" ? INSPECT_RETURN_LEG_FLOW : INSPECT_FLOW;
  }
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
  // 合并采样单（采样后送检；旧合并别名 kind=采样＋inspect 也走这里）：按 tripMode 分流（R28）——
  // stationFirst（历史 R22 派生双向）带首腿；return（新双向）带寄回腿；oneWay 7 步。
  const base = RETURN_STEPS.includes(task.status) ? SAMPLE_RETURN_FLOW : SAMPLE_FLOW;
  const mode = tripModeOf(task);
  if (mode === "stationFirst") return [...SAMPLE_OUTBOUND_STEPS, ...base];
  if (mode === "return" && !RETURN_STEPS.includes(task.status)) return SAMPLE_RETURN_LEG_FLOW;
  return base;
}

/** 签收推进到哪一步：合并采样单/送检/送检测站的到「待检测」，旧调拨/旧采样到「已签收」。 */
export function signTargetOf(task) {
  if (isMergedSample(task)) return "待检测";
  return task.kind === "送检" || task.inspect ? "待检测" : "已签收";
}

/** 新建时的第一步；划拨创建后待目标分公司管理员接受（R25），接受才落已完成。 */
export function initialOf(task) {
  if (task.kind === "划拨") return "待接受";
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
 * 送检双向寄回（R28 tripMode=return）：已检测不再是终态，检测站发起寄回；
 * 寄回腿途中不能取消（箱子正在回寄出分公司）。
 */
const INSPECT_RETURN_LEG_NEXT = {
  ...INSPECT_NEXT,
  已检测: ["待寄回"],
  待寄回: ["寄回在途"],
  寄回在途: ["待归还"],
  待归还: ["已归还"],
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
 * 双向合并单（R22 历史站首腿，tripMode=stationFirst）：首腿 待寄出→运送中→待采样
 * （分公司确认到达＝签收，归属交采样单位），之后与单向完全一致。首腿也在最终待签收之前，可取消。
 */
const SAMPLE_ROUND_NEXT = {
  待寄出: ["运送中", "已取消"],
  运送中: ["待采样", "已取消"],
  ...SAMPLE_NEXT,
};

/**
 * 双向合并单寄回腿（R28 tripMode=return）：已检测后检测站发起寄回（仍可改走退回），
 * 待寄回→寄回在途→待归还 归检测站，待归还→已归还（签收归还）归寄出分公司。
 * 寄回腿途中不能取消；已归还终态OK（归属回 fromOrg＋保管人清空）。
 */
const SAMPLE_RETURN_LEG_NEXT = {
  ...SAMPLE_NEXT,
  已检测: ["待寄回", "退回中"],
  待寄回: ["寄回在途"],
  寄回在途: ["待归还"],
  待归还: ["已归还"],
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
 * 从 status 能推进到哪些状态。划拨恒为 []（R25 走专用 accept/cancel/reject/tracking 端点，不走通用 transition）。
 * 合并采样单按 tripMode 分流（R28）：return＝SAMPLE_RETURN_LEG_NEXT、stationFirst＝SAMPLE_ROUND_NEXT、
 * oneWay＝SAMPLE_NEXT；送检 return 带寄回腿；旧送检/调拨/采样按各自旧流（读兼容）。
 */
export function nextOf(task, status) {
  if (task.kind === "划拨") return [];
  if (task.kind === "送检") {
    if (tripModeOf(task) === "return") return INSPECT_RETURN_LEG_NEXT[status] || [];
    return ENDED.includes(status) ? [] : INSPECT_NEXT[status] || [];
  }
  // R23 仅本地采样单：已封箱终态，之前可取消
  if (isLocalSample(task)) return SAMPLE_LOCAL_NEXT[status] || [];
  if (isMergedSample(task)) {
    const mode = tripModeOf(task);
    const map =
      mode === "return"
        ? SAMPLE_RETURN_LEG_NEXT
        : mode === "stationFirst"
          ? SAMPLE_ROUND_NEXT
          : SAMPLE_NEXT;
    return map[status] || [];
  }
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
 * - 划拨（R25/064）：历史已划拨→已完成（接受时转移语义对齐；接受人/接受时间不伪造，迁移打 legacyTransfer 标）。
 *   已撤销只读保留（同名）。终态语义保持：ENDED_OK→ENDED_OK、ENDED_VOID→ENDED_VOID。
 */
export const LEGACY_STATUS_MAP = {
  送检: { 待寄出: "已封箱", 运送中: "在途" },
  采样: { 待核验: "待检测", 已签收: "已检测", 已完成: "已检测" },
  划拨: { 已划拨: "已完成" },
};

/** 迁移用：把旧 kind 映射到新 kind（映射外同名）。 */
export function migrateKind(kind) {
  return LEGACY_KIND_MAP[kind] ?? kind;
}

/** 迁移用：把旧 kind 下的旧状态映射到新状态（映射外同名）。 */
export function migrateStatus(kind, status) {
  return LEGACY_STATUS_MAP[kind]?.[status] ?? status;
}

/**
 * 划拨状态读兼容（R25）：历史「已划拨」显示为「已完成」（064 已把存量映射掉，这里兜未迁移的读路径）；
 * 其余状态同名。列表/详情/计数归一用它，避免历史单与新单两套词表。
 */
export function transferStatusOf(status) {
  return migrateStatus("划拨", String(status ?? ""));
}
