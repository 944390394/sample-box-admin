import { filterEvents, limits } from "./SampleController.js";
import { BOX, canSee, flagAllowed, historicalScopeSql, scopeSql } from "../auth/boxAccess.js";
import {
  POLICY_PERMS as P,
  rootOrgId,
  supportsDispatch,
  validatePolicy,
  transferBlock,
} from "../settings/ReportPolicy.js";
import {
  companyBoxIds,
  companyJudgmentFor,
  companyLimits,
  companyOrgOfTask,
  companyTaskFor,
  boxReserve,
  readCompanyPolicy,
  saveCompanyPolicy,
  systemJudgmentDefaults,
  validateCompanyNumbers,
  withCompanyBattery,
} from "../settings/companyPolicy.js";
import { audit } from "../log/audit.js";
import {
  currentBoxSettings,
  resolveStation,
  stationDeptId,
  transferInspectEnabled,
} from "../settings/boxConfig.js";
import { effectiveDeptLocation, hasCoords, readPlace } from "../geo/place.js";
import { companyTool } from "../settings/boxCompany.js";
import { taskTrack, taskWindow } from "../settings/taskTrack.js";
import {
  maskBox,
  maskImei,
  maskUplink,
  identityGranted,
  boxNameCell,
  canMatchImei,
} from "../auth/boxAccess.js";
import { readCameras } from "../settings/deptCameras.js";
import { receiveCheck } from "../settings/receiveCheck.js";
import {
  badRequest,
  conflict,
  noPermission,
  notConfigured,
  notVisible,
} from "../domain/AppError.js";
import { logSystem } from "../log/systemLog.js";
// R24（#70）划拨二次确认：口令比对用登录同一套 hash 口径（scrypt，salt:hex），不另造一套。
import { verifyPassword } from "../../auth.js";
import { buildDeptTree, collectDeptIds } from "../../../shared/org.js";
import { ESCAPE_SQL, likePattern } from "../store/sqlText.js";

/** 任务相关的新权限码，见 permCatalog TASK_PERMS。 */
const T = {
  createTransfer: "task:create:transfer",
  // R25（#71/064）划拨三态：接受划拨＝目标分公司管理员确认（manageOrgIds 门＋本码）。
  transferAccept: "task:transfer:accept",
  createSample: "task:create:sample",
  createInspect: "task:create:inspect",
  // R24（#70）撤销下线：本码已从 permCatalog 的 item 与角色模板里移除，不再授予、不再进任何门。
  // 存量角色授权行（053/057 补的）留在库里当历史数据（inert），不新增迁移清理。
  // 只剩已下线的 revokeTransfer 方法体还在读它，保住那组归属退回回归用例的单码语义。
  transferRevoke: "task:transfer:revoke",
  policy: "task:policy",
  send: "task:send",
  arrive: "task:arrive",
  sign: "task:sign",
  reject: "task:reject",
  rejectReturn: "task:reject-return",
  forceSign: "task:force-sign",
  acceptReturn: "task:accept-return",
  inspect: "task:inspect",
  sampleStart: "task:sample-start",
  seal: "task:seal",
  finish: "task:finish",
  sendBack: "task:send-back",
  cancel: "task:cancel",
  video: "task:video",
  camera: "task:camera",
  videoRetry: "task:video-retry",
  log: "task:log",
};
import {
  MOVING,
  boxDistances,
  distanceSnapshot,
  openCounts,
  overOpenLimit,
  sealOpenCounts,
  targetOf,
  taskRadiusOf,
} from "../settings/taskPlaces.js";

import {
  activeTaskSql,
  boxHeldSql,
  deriveTrip,
  ENDED,
  ENDED_OK,
  ENDED_VOID,
  isEndedFor,
  isLocalSample,
  isMergedSample,
  nextOf,
  RETURN_LEG_STEPS,
  RETURN_STEPS,
  SAMPLE_FLOW,
  SAMPLE_OUTBOUND_STEPS,
  signTargetOf,
  stepsOf,
  transferStatusOf,
  TRIPS,
  tripModeOf,
} from "../settings/taskFlow.js";

/** 签收人以外的人代签：流转里记成「已签收」，动作名记「强制签收」。 */
const FORCE_SIGN = "强制签收";

function inScope(ctx, orgId) {
  const scope = ctx.access?.scope;
  return !scope || scope.all || scope.orgIds.includes(String(orgId ?? ""));
}

/**
 * 这个部门是不是那个单位本身、或在它下面（科室、班组）。
 * 建单时选的寄出人、签收人必须是那个单位里的人：
 * 只校验「账号存在且未停用」的话，建单方可以把签收人写成任意单位的任意用户，
 * 那张单对这个用户不可见（读 404），他却能凭 signerId 走签收、把箱子归属改到自己名下。
 */
function deptUnder(depts, deptId, orgId) {
  if (orgId == null || orgId === "") return true;
  const tree = buildDeptTree(depts);
  const ids = collectDeptIds(tree, String(orgId)) || [];
  // 没分配部门的人归总公司（根单位），与读路径 userScopeSql 承认 NULL dept 的口径一致，别误拒
  const rootId = String(tree[0]?.id ?? "1");
  const effective = deptId == null || deptId === "" ? rootId : String(deptId);
  return ids.includes(effective);
}

/**
 * 单位 id 优先；旧调用只写单位名时，名字能唯一对上一个部门才认，对不上返回空表示校验不了。
 * 校验寄出人、签收人属于哪一方时用，避免因为老数据没有 orgId 就直接放行。
 */
function resolveOrgId(depts, orgId, orgName) {
  const id = String(orgId ?? "");
  if (id) return id;
  const name = String(orgName ?? "").trim();
  if (!name) return "";
  const hits = depts.filter((row) => String(row.name).trim() === name);
  return hits.length === 1 ? String(hits[0].id) : "";
}

/** 当前用户是不是调拨单指定的签收人。 */
function isSigner(ctx, task) {
  return Boolean(task.signerId) && String(ctx.user?.id ?? "") === String(task.signerId);
}

function actorOf(ctx) {
  return { id: ctx.user?.id, name: ctx.user?.nickname || ctx.user?.username || "" };
}

function isSystemAdmin(ctx) {
  const roles = ctx.access?.roles || ctx.user?.roles || [];
  return (
    roles.some((role) => (typeof role === "string" ? role : role?.code) === "ADMIN") ||
    Boolean(ctx.access?.scope?.all)
  );
}

/**
 * 系统管理员（角色口径，R-b）：数据范围=全部≠系统管理员——值班/核验等全部范围角色不是 ADMIN。
 * 角色列表存在时只认 ADMIN（不再用 scope.all 兜底，否则 DUTY 全部范围被当成管理员）；
 * 内部/手工构造的 access 无角色列表时回落 scope.all（生产 resolveAccess 恒填角色，空角色＝无权限到不了写动作）。
 */
function isAdminRole(ctx) {
  const roles = ctx.access?.roles || ctx.user?.roles || [];
  const codes = roles.map((role) => (typeof role === "string" ? role : role?.code)).filter(Boolean);
  if (codes.length) return codes.includes("ADMIN");
  return Boolean(ctx.access?.scope?.all);
}

/**
 * 参与方门（写动作，R-b）：数据范围=全部不等于参与方。采样/寄出/接收单位要落在管理范围
 * （manageOrgIds）里、或系统管理员（ADMIN）才认；全部范围的非 ADMIN 角色（如检测站值守 DUTY）
 * 不能推进他单位的采样/检测步。读可见性仍走 inScope（orgIds 含祖先与全部），这里只收写动作的参与方判定。
 * 手工构造的 scope 可能没有 manageOrgIds（如单测），退回 orgIds（与 orgScopeSql manage 口径同族）。
 * 本函数保持严格口径不放宽；#69 的本人保管窄放宽只作用于采样段动作，见 selfCustodyHit。
 */
function inPartyScope(ctx, orgId) {
  const scope = ctx.access?.scope;
  if (!scope) return true;
  if (scope.all) return isAdminRole(ctx);
  const ids = scope.manageOrgIds ?? scope.orgIds;
  return ids.includes(String(orgId ?? ""));
}

/**
 * #69 窄放宽（D5 采样员自助链，用户拍板「窄放宽本人保管」）：本人保管命中判定。
 * scope4（仅本人）的 resolveScope 只填 ownerIds、manageOrgIds=[]，R22 严格参与方门把纯本人采样员
 * 挡在本地采样步外（#66 §0 实证）。这里认「任务绑定箱全部是当前本人保管（box.owner_id∈ownerIds）」，
 * 仅由采样段动作（待采样→采样中→已封箱，含 localOnly 与合并单采样段）调用；
 * 寄出/确认到达/签收/开始检测/拒收/退回/取消等他角色步不调用，仍走 inPartyScope（manageOrgIds/ADMIN）。
 * 空箱单不命中（fail-closed）；owned=null（未加载/全范围/无 ownerIds）恒不命中——
 * 全部范围非 ADMIN（DUTY）的 scope.all 在 #selfOwnedBoxIds 即返回 null，R22 越权修保持。
 */
function selfCustodyHit(owned, task) {
  const ids = task.boxIds || [];
  return Boolean(owned && owned.size && ids.length) && ids.every((id) => owned.has(String(id)));
}

/** 所有策略写入都再次校验目标设备范围；批量操作不接受客户端声称的权限。 */
export class ReportPolicyController {
  constructor(boxes, policies) {
    this.boxes = boxes;
    this.policies = policies;
    this.db = policies.db;
  }
  require(ctx, perm) {
    if (!ctx.access?.perms?.has(perm)) throw noPermission("没有这项操作权限");
  }
  async targets(ctx, ids) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 10000 ||
      ids.some((id) => typeof id !== "string" || id.length > 64)
    )
      throw badRequest("请选择 1–10000 台采样箱");
    const unique = [...new Set(ids)],
      result = [];
    for (let i = 0; i < unique.length; i += 200) {
      const part = unique.slice(i, i + 200);
      const rows = await this.db.all(
        `SELECT * FROM sample_box WHERE id IN (${part.map(() => "?").join(",")})`,
        part
      );
      // 不存在和不在范围内给同一个 404：不给「这台箱子存不存在」的线索，也不再把内部文案原文回给客户端
      if (
        rows.length !== part.length ||
        rows.some(
          (b) =>
            !canSee(ctx.access, {
              orgId: String(b.org_id ?? ""),
              ownerId: String(b.owner_id ?? ""),
            })
        )
      )
        throw notVisible("部分采样箱不存在或不在你的管理范围内，请刷新选择");
      result.push(...rows);
    }
    return result;
  }
  async read(ctx) {
    this.require(ctx, P.read);
    const [box] = await this.targets(ctx, [ctx.params.id]);
    ctx.ok(await this.policies.get(box));
  }
  /**
   * R28（#95）单箱/批量策略入口范围守卫：补码（068）让分公司管理员持 policyWrite/policyBatch 后，
   * 非 ADMIN 的目标箱 org 必须落在 manageOrgIds（本公司子树）内，任一越权整单拒 403
   *（沿划拨整单拒先例，不静默过滤）；ADMIN 全范围不变。与 inPartyScope 参与方门同口径
   *（scope.all 只认 ADMIN；手工构造 scope 无 manageOrgIds 退回 orgIds）。targets() 的 canSee 只是
   * 读可见（orgIds 含祖先），写动作另收 manage 口径——否则读范围宽于管理范围的角色可越权改他司箱。
   */
  #policyScopeGuard(ctx, boxes) {
    if (boxes.some((b) => !inPartyScope(ctx, b.org_id)))
      throw noPermission("只能设置本公司范围内的采样箱策略");
  }
  async save(ctx) {
    this.require(ctx, P.single);
    const [box] = await this.targets(ctx, [ctx.params.id]);
    this.#policyScopeGuard(ctx, [box]);
    const policy = validatePolicy(ctx.body.policy);
    await this.policies.save([ctx.params.id], "single", policy);
    await this.log(ctx, policy ? "设置单箱上报策略" : "恢复上报策略继承", ctx.params.id);
    ctx.ok({ saved: true });
  }
  async preview(ctx) {
    this.require(ctx, P.batch);
    let ids = ctx.body.ids;
    if (ctx.body.filter) {
      this.require(ctx, BOX.list);
      const filter = ctx.body.filter;
      if (
        (filter.q && (typeof filter.q !== "string" || filter.q.length > 100)) ||
        (filter.life && !["待激活", "未使用", "在途", "停用"].includes(filter.life)) ||
        (filter.flag && !["alert", "offline", "low", "lid", "ready"].includes(filter.flag))
      )
        throw badRequest("筛选条件不正确");
      if (filter.flag && !flagAllowed(filter.flag, ctx.access.perms))
        this.require(ctx, filter.flag === "lid" ? BOX.lid : BOX.power);
      if (Object.keys(filter).some((k) => !["q", "life", "flag"].includes(k)))
        throw badRequest("筛选条件不正确");
      const rows = [];
      // 只分页读取当前状态表，冻结本次目标，提交时不会扩大到新匹配的箱子。
      const lim = await companyLimits(this.db, limits());
      for (let page = 1; page <= 101; page++) {
        const result = await this.boxes.page({
          ...filter,
          page,
          pageSize: 100,
          limits: lim,
          scope: ctx.access.scope,
          matchImei: identityGranted(ctx.access.perms),
        });
        if (result.total > 10000)
          throw badRequest("单次最多设置 10000 台，请缩小筛选范围后分批操作");
        rows.push(...result.list.map((b) => b.id));
        if (rows.length >= result.total) break;
      }
      ids = rows;
    }
    const boxes = await this.targets(ctx, ids);
    // 批量预览同为 P.batch 写流入口：与 batch 同口径范围守卫，越权早拒同文案（不等保存才拒）。
    this.#policyScopeGuard(ctx, boxes);
    let overridden = 0;
    for (const box of boxes) {
      const p = await this.policies.get(box);
      if (
        (p.taskId && supportsDispatch(box.firmware)) ||
        ["单箱设置", "任务内单箱", "任务统一"].includes(p.effective.source)
      )
        overridden++;
    }
    ctx.ok({ ids: boxes.map((b) => b.id), total: boxes.length, overridden });
  }
  async batch(ctx) {
    this.require(ctx, P.batch);
    const boxes = await this.targets(ctx, ctx.body.ids);
    this.#policyScopeGuard(ctx, boxes);
    const policy = validatePolicy(ctx.body.policy);
    await this.policies.save(
      boxes.map((b) => b.id),
      "batch",
      policy
    );
    await this.log(
      ctx,
      `批量${policy ? "设置" : "清除"}上报策略（${boxes.length}台）`,
      boxes
        .slice(0, 3)
        .map((b) => b.id)
        .join(",")
    );
    ctx.ok({ saved: boxes.length });
  }

  /**
   * R13 公司策略中心的目标公司校验（GET/PUT 共用）：
   * 存在＋启用＋type=公司（检测站拒绝，沿划拨 P8 文案口径）；
   * 读闸门＝policyRead＋view 口径（orgIds，含祖先）；写闸门＝policyCompany 或 policyCompanyJudge
   * 任一（R21/062 阈值拆码：仅持阈值码也能保存阈值变更，改了哪块在 companyPolicySave 里再各查各码）
   * ＋manage 口径（manageOrgIds 不含祖先——分公司管理员天然只能改本公司，总部管理员 all 可改各分公司）。
   */
  async #companyTarget(ctx, { write = false } = {}) {
    const orgId = String(ctx.params.id ?? "").slice(0, 32);
    if (!orgId) throw badRequest("请选择公司");
    if (write) {
      const perms = ctx.access?.perms;
      if (!perms?.has(P.company) && !perms?.has(P.companyJudge))
        throw noPermission("没有这项操作权限");
    } else {
      this.require(ctx, P.read);
    }
    const dept = await this.db.get("SELECT id, name, type, status FROM sys_dept WHERE id=?", [
      orgId,
    ]);
    if (!dept || Number(dept.status) !== 1) throw badRequest("公司不存在或已停用");
    if (dept.type !== "公司")
      throw badRequest(
        dept.type === "检测站"
          ? "检测站不参与公司策略，请改选分公司或总部"
          : "公司策略目标必须是公司类型（分公司或总部）"
      );
    // 公司层按顶级公司解析（companyOf）：下级部门即使 type=公司 也不收策略，
    // 避免存一份永远读不到的死配置（如分公司下的调度室）。
    const depts = await this.db.all("SELECT id, parent_id, sort, name FROM sys_dept");
    if (companyTool(depts).companyOf(orgId) !== orgId)
      throw badRequest("公司策略按顶级公司（分公司或总部）设置，请选择公司本身，不要选下级部门");
    const scope = ctx.access?.scope;
    if (write) {
      if (scope && !scope.all && !(scope.manageOrgIds ?? []).includes(orgId))
        throw noPermission("只能修改本公司的默认策略");
    } else if (scope && !scope.all && !scope.orgIds.includes(orgId)) {
      throw notVisible("公司不存在或不在你的管理范围内");
    }
    return dept;
  }

  /** GET /api/v1/depts/:id/policy：公司策略读模型＋系统默认（继承态灰字）＋可写标识＋影响台数。 */
  async companyPolicyRead(ctx) {
    const dept = await this.#companyTarget(ctx);
    const policy = await readCompanyPolicy(this.db, dept.id);
    const scope = ctx.access?.scope;
    const inManage = !scope || scope.all || (scope.manageOrgIds ?? []).includes(String(dept.id));
    const canWrite = Boolean(ctx.access?.perms?.has(P.company)) && inManage;
    // R21（062）：阈值三列单独可写标识（码＋同一 manage 闸门），前端阈值控件按它锁定
    const canJudge = Boolean(ctx.access?.perms?.has(P.companyJudge)) && inManage;
    const boxCount = (await companyBoxIds(this.db, String(dept.id))).length;
    ctx.ok({
      orgId: String(dept.id),
      orgName: dept.name,
      ...policy,
      system: systemJudgmentDefaults(),
      can: { write: canWrite, judge: canJudge },
      boxCount,
    });
  }

  /**
   * PUT /api/v1/depts/:id/policy：保存公司策略（idle/task 完整策略或 null＝整层继承；
   * 判定阈值三列 null＝继承系统默认）。事务内保存＋refresh 该公司全部箱子（含检测站里
   * 由该公司寄出的箱子），提交后沿既有 policy 下发＋ACK 通道推送（不新建命令队列）。
   * R21（062）字段级授权（saveBox/saveSecurity 同款「改了哪块查哪码」）：
   * idle/task 变更查 policyCompany；阈值三列变更查 policyCompanyJudge；未变更的回显值不查。
   * 审计（PM 裁决）：orgId 记目标公司，detail={before,after,affectedBoxCount}；先写库后审计。
   */
  async companyPolicySave(ctx) {
    const dept = await this.#companyTarget(ctx, { write: true });
    const body = ctx.body || {};
    const idle = body.idle == null ? null : validatePolicy(body.idle);
    const task = body.task == null ? null : validatePolicy(body.task);
    const numbers = validateCompanyNumbers(body);
    const before = await readCompanyPolicy(this.db, dept.id);
    // 库里策略带 revision 戳、可选键有无不一：两边都过 validatePolicy 归一后再比，避免回显误判「变更」
    const samePolicy = (a, b) =>
      JSON.stringify(a == null ? null : validatePolicy(a)) ===
      JSON.stringify(b == null ? null : validatePolicy(b));
    if (!samePolicy(idle, before.idle) || !samePolicy(task, before.task))
      this.require(ctx, P.company);
    if (
      numbers.batteryReserve !== before.batteryReserve ||
      numbers.arriveRadiusM !== before.arriveRadiusM ||
      numbers.taskOfflineGraceSec !== before.taskOfflineGraceSec
    ) {
      if (!ctx.access?.perms?.has(P.companyJudge))
        throw noPermission("没有「修改公司判定阈值」权限");
    }
    const after = { idle, task, ...numbers };
    const ids = await companyBoxIds(this.db, String(dept.id));
    let meta;
    await this.db.transaction(async (tx) => {
      meta = await saveCompanyPolicy(tx, dept.id, after, actorOf(ctx));
      await this.policies.refresh(ids, tx);
    });
    this.policies.onPolicyChanged?.(ids);
    this.boxes.summaryCache?.clear();
    await audit(this.db, {
      orgId: String(dept.id),
      orgName: dept.name,
      actorId: String(ctx.user.id),
      actorName: ctx.user.nickname || ctx.user.username,
      action: "修改公司策略",
      targetType: "company-policy",
      targetId: String(dept.id),
      result: "成功",
      ip: ctx.ip || "",
      detail: { before, after, affectedBoxCount: ids.length },
    });
    ctx.ok(
      {
        orgId: String(dept.id),
        orgName: dept.name,
        ...after,
        ...meta,
        system: systemJudgmentDefaults(),
        can: {
          write: Boolean(ctx.access?.perms?.has(P.company)),
          judge: Boolean(ctx.access?.perms?.has(P.companyJudge)),
        },
        boxCount: ids.length,
        affectedBoxCount: ids.length,
      },
      `已保存，${ids.length} 台箱子的策略已触发刷新`
    );
  }
  async createTask(ctx) {
    const input = ctx.body;
    // 划拨提交即生效，必须走 /sample/transfers；通用建单端点不收（§6.1）
    if (input?.kind === "划拨") throw conflict("划拨单没有物流步骤，请使用划拨接口提交");
    if (input?.kind === "调拨") throw badRequest("调拨单已停用：请用采样单（寄检测站）或划拨单");
    // R23 三类型：采样（仅本地）/送检（仅寄送）/采样后送检（合并全流）。
    // 旧客户端 kind=采样（不带 localOnly）＝合并别名，读兼容；新本地采样显式 localOnly=true。
    const kind = input?.kind;
    if (!["采样", "送检", "采样后送检"].includes(kind)) throw badRequest("请填写任务名称和类型");
    const inspectKind = kind === "送检";
    const localOnly = kind === "采样" && input.localOnly === true;
    // 权限码：采样/采样后送检＝新建采样任务；送检＝严格要「新建送检单」（R21/062 去兜底：
    // 存量 create:sample 持有者由 062 补 create:inspect 并集，之后管理员可单独收回送检）。
    if (inspectKind) {
      this.require(ctx, T.createInspect);
    } else {
      this.require(ctx, T.createSample);
    }
    // 任务期间的上报策略、单箱例外单独授权
    if (input?.policy != null || Object.keys(input?.overrides || {}).length)
      this.require(ctx, T.policy);
    const boxes = await this.targets(ctx, input.boxIds);
    if (boxes.length > 100) throw badRequest("一张任务单最多绑定 100 台箱子");
    if (boxes.some((b) => b.life === "停用")) throw badRequest("停用的箱子不能绑定任务");
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120)
      throw badRequest("请填写任务名称和类型");
    if (
      input.overrides != null &&
      (typeof input.overrides !== "object" || Array.isArray(input.overrides))
    )
      throw badRequest("单箱策略格式不正确");
    const overrides = {};
    for (const [id, value] of Object.entries(input.overrides || {})) {
      if (!boxes.some((b) => b.id === id)) throw badRequest("单箱策略必须属于任务绑定的箱子");
      overrides[id] = validatePolicy(value);
    }
    const metadata = {};
    for (const key of [
      "fromOrg",
      "toOrg",
      "sender",
      "signer",
      "place",
      "people",
      "note",
      "sample",
    ]) {
      if (input[key] != null && (typeof input[key] !== "string" || input[key].length > 1000))
        throw badRequest("任务字段格式不正确");
      metadata[key] = input[key] || "";
    }
    // parentId 给 deptUnder 用：寄出人、签收人要在对应单位的部门树里找
    const depts = await this.db.all(
      "SELECT id,parent_id AS parentId,name,code,sort,status,type FROM sys_dept"
    );
    const deptOf = (id) =>
      id == null || id === "" ? null : depts.find((row) => String(row.id) === String(id)) || null;
    // 箱归属归一：未分配（org_id 空）＝总公司根；同一任务单的箱子须同归属（混归属整单拒，三 kind 共用）
    const rootId = rootOrgId(depts);
    const boxOrgs = [...new Set(boxes.map((b) => String(b.org_id ?? "") || rootId))];
    if (boxOrgs.length > 1)
      throw badRequest("同一任务单的箱子须同归属，请按归属拆分任务单（跨公司批量请用划拨）");
    const from = deptOf(boxOrgs[0]);
    if (!from) throw badRequest("箱子归属单位不存在，请刷新后重试");
    if (Number(from.status) !== 1) throw badRequest("箱子归属单位已停用，请先调整箱子归属");
    if (from.type !== "公司" && from.type !== "检测站")
      throw badRequest("箱子归属单位类型不支持建单，请先调整箱子归属");
    // 寄出方＝箱当前归属（只读派生，三 kind 共用；本地采样＝采样单位，送检＝寄出方，合并单向＝寄出分公司）
    metadata.fromOrgId = String(from.id);
    metadata.fromOrg = from.name;
    metadata.fromPlace = readPlace(input.fromPlace);
    metadata.placeAt = readPlace(input.placeAt);
    if (metadata.placeAt?.address && !metadata.place) metadata.place = metadata.placeAt.address;
    // #88 寄出地址必填（与建单页 step3 同口径）：寄送类（送检/采样后送检，含旧合并别名）公司地址
    // 已设置视为已填——建单页恒把最终地址（公司或自定义）放进 fromPlace 下发。新口径请求显式携带
    // fromPlace 字段却为空（公司未设置且自定义也空）→ 400。旧客户端/小程序不带该字段＝旧口径，
    // 保留兼容（与 localOnly 显式标记同源），不强制 legacy 路径；本地采样无寄送腿，不要求。
    if (!localOnly && input.fromPlace !== undefined && !metadata.fromPlace)
      throw badRequest("请设置寄出地址：选用公司地址或自定义");
    metadata.createdBy = actorOf(ctx).name;
    // 任务期间每台箱子最多开几次箱，不填不限
    if (input.maxOpens != null && input.maxOpens !== "") {
      const max = Number(input.maxOpens);
      if (!Number.isInteger(max) || max < 0 || max > 999)
        throw badRequest("开箱次数上限要在 0 到 999 之间");
      metadata.maxOpens = max;
    }
    // 寄出人/签收人归属校验：必须是那一方单位（含下级部门）里的人
    const checkPerson = async (idKey, nameKey, label, orgId, orgName) => {
      if (input[idKey] == null || input[idKey] === "") return;
      const user = await this.db.get(
        "SELECT id,nickname,dept_id AS deptId FROM sys_user WHERE id=? AND status=1",
        [String(input[idKey])]
      );
      if (!user) throw badRequest("寄出人或签收人不存在或已停用");
      const resolved = resolveOrgId(depts, orgId, orgName);
      if (!resolved)
        throw badRequest(`${label}的所属单位无法确认，请补全单位信息或改用单位选择后再建单`);
      if (!deptUnder(depts, user.deptId, resolved))
        throw badRequest(
          `${label}必须是${orgName || "该单位"}的人员，请重新选择或先调整人员所属部门`
        );
      metadata[idKey] = String(user.id);
      metadata[nameKey] = user.nickname;
    };

    let domainKind;
    if (localOnly) {
      // 仅本地采样：采样单位＝箱当前归属（只读），无寄送腿/检测站/签收人；已封箱终态、箱留采样单位
      if (from.type !== "公司") throw badRequest("采样单位必须是分公司（公司类型）");
      if (!inScope(ctx, from.id) && !isSystemAdmin(ctx))
        throw badRequest("采样单位不在你的管理范围内");
      metadata.orgId = String(from.id);
      metadata.org = from.name;
      metadata.inspect = false;
      metadata.localOnly = true;
      // 开箱录像只给分公司采样现场（from.type=公司 已校验）
      if (input.recordVideo) metadata.recordVideo = true;
      domainKind = "采样";
    } else {
      // 送检 / 采样后送检：接收方固定唯一检测站（P5/P10，resolveStation 配置优先→DB 恰一个自动认定）
      const station = await resolveStation(this.db);
      if (!station)
        throw notConfigured(
          stationDeptId()
            ? "配置的唯一检测站不存在、已停用或不是总公司下的检测站，请在系统设置重新指定"
            : "请先在系统设置指定唯一检测站"
        );
      if (
        input.toOrgId != null &&
        String(input.toOrgId) !== "" &&
        String(input.toOrgId) !== String(station.id)
      )
        throw badRequest("任务单接收方固定为唯一检测站，不能寄给总部或其他分公司");
      metadata.toOrgId = String(station.id);
      metadata.toOrg = station.name;
      metadata.toPlace = readPlace(input.toPlace);
      metadata.inspect = true;
      // R28（任务 #92）：寄送类建单要求箱在寄出方（分公司/总部）——箱在检测站整单拒，
      // 回分公司请用划拨（旧 R22 站首腿双向不再新建，存量 stationFirst 单只读收尾）。
      if (String(from.id) === String(station.id)) throw badRequest("箱在检测站：回分公司请用划拨");
      // R28：寄送方向用户可选（单向/双向，默认单向）；双向＝检测完寄回分公司（tripMode=return）
      const trip = input.trip == null || input.trip === "" ? "单向" : input.trip;
      if (!TRIPS.includes(trip)) throw badRequest("寄送方向只能是单向或双向");
      metadata.trip = trip;
      metadata.tripMode = trip === "双向" ? "return" : "oneWay";
      if (inspectKind) {
        // 送检：仅寄送（箱已采样封箱在寄出方），无采样段；orgId＝寄出方（公司策略/来源归属用）
        metadata.orgId = String(from.id);
        metadata.org = from.name;
        if (!inScope(ctx, from.id) && !isSystemAdmin(ctx))
          throw badRequest("寄出方不在你的管理范围内");
        await checkPerson("senderId", "sender", "寄出人", metadata.fromOrgId, metadata.fromOrg);
        await checkPerson("signerId", "signer", "签收人", metadata.toOrgId, metadata.toOrg);
        if (!metadata.sender || !metadata.signer) throw badRequest("请填写寄出人和签收人");
        domainKind = "送检";
      } else {
        // 采样后送检（含旧客户端 kind=采样 合并别名）：采样单位可选分公司，方向用户可选（R28，默认单向）
        let samplerId = String(input.orgId ?? "") || String(input.fromOrgId ?? "");
        if (samplerId === String(station.id) && input.trip && input.fromOrgId)
          samplerId = String(input.fromOrgId);
        const sampler = deptOf(samplerId);
        if (!sampler) throw badRequest("请选择采样单位（分公司）");
        if (String(sampler.id) === String(station.id)) throw badRequest("采样单位不能是检测站");
        if (sampler.type !== "公司") throw badRequest("采样单位必须是分公司（公司类型）");
        // #87：采样单位（客户端 orgId/fromOrgId）必须在建单方范围内——原 OR 口径（采样单位或寄出方
        // 任一在范围即过）让分公司管理员拿自己的箱把采样单位写成兄弟公司（越权建单洞）。
        // 寄出方＝箱当前归属，已被 targets() 的箱子范围门把住，无需再 OR；管理员全量不受限。
        if (!inScope(ctx, sampler.id) && !isSystemAdmin(ctx))
          throw noPermission("采样单位不在你的管理范围内");
        metadata.orgId = String(sampler.id);
        metadata.org = sampler.name;
        // trip/tripMode 已在上方按用户选择写入；tripDerived 标记沿用（legacy 判别：带标记＝新单）
        metadata.tripDerived = true;
        // 开箱录像只给分公司采样现场；检测站恒禁（录音⑥）。gate 按采样单位（双向寄出方是检测站）
        if (input.recordVideo) {
          if (sampler.type !== "公司" || String(sampler.id) === String(station.id))
            throw badRequest("只有分公司（公司类型）采样时才能要求开箱录像，检测站不设录像");
          metadata.recordVideo = true;
        }
        await checkPerson("senderId", "sender", "寄出人", metadata.fromOrgId, metadata.fromOrg);
        await checkPerson("signerId", "signer", "签收人", metadata.toOrgId, metadata.toOrg);
        if (!metadata.fromOrg || !metadata.toOrg) throw badRequest("请填写寄出方与检测站");
        if (!metadata.sender || !metadata.signer) throw badRequest("请填写寄出人和签收人");
        // 旧客户端 kind=采样 合并别名存储仍 kind=采样（读兼容）；新客户端显式 采样后送检
        domainKind = kind === "采样" ? "采样" : "采样后送检";
      }
    }
    const id = await this.policies.createTask(
      {
        ...metadata,
        name: input.name.trim(),
        kind: domainKind,
        fromOrgId: metadata.fromOrgId,
        toOrgId: metadata.toOrgId,
        orgId: metadata.orgId,
        boxIds: boxes.map((b) => b.id),
        policy: validatePolicy(input.policy),
        overrides,
      },
      actorOf(ctx)
    );
    await this.log(ctx, "创建任务单", id);
    ctx.ok({ id });
  }

  /**
   * 能看到的任务：绑定的箱子都在自己范围内（按历史快照），
   * 或者自己是调拨单的寄出、接收单位——接收方看不到寄出方的箱子，也要能签收。
   * 采样单位同样是参与方：单向采样单的采样单位只记在 body.orgId（from/to 列为空），
   * 箱子快照又属寄出单位，不认 body.orgId 的话采样单位在总览里看得到这张单、
   * 任务列表却为空、点进详情 404（R4）。与 OverviewController.#tasks、#abilities 同口径。
   */
  #visible(ctx) {
    const scope = ctx.access.scope;
    if (!scope || scope.all) return { sql: "", params: [] };
    const historical = historicalScopeSql(scope);
    const orgIds = scope.orgIds;
    const own = orgIds.length
      ? ` OR t.from_org_id IN (${orgIds.map(() => "?").join(",")}) OR t.to_org_id IN (${orgIds.map(() => "?").join(",")})`
      : "";
    const samplingIds = orgIds.filter(Boolean);
    const sampling = samplingIds.length
      ? ` OR (${samplingIds.map(() => `t.body LIKE ? ${ESCAPE_SQL}`).join(" OR ")})`
      : "";
    // 一台箱子都不挂的单（箱子被解绑或删除）不算「范围内」：只按寄出、接收、采样单位认参与方，
    // 否则 NOT EXISTS 恒真会把这张单对所有人放出去。
    return {
      sql: `((EXISTS (SELECT 1 FROM sample_task_box l WHERE l.task_id = t.id) AND NOT EXISTS (SELECT 1 FROM sample_task_box m LEFT JOIN sample_box b ON b.id=m.box_id WHERE m.task_id=t.id AND NOT (${historical.sql})))${own}${sampling})`,
      params: [
        ...historical.params,
        ...orgIds,
        ...orgIds,
        // 单位编号是服务端的，不带通配符；% _ 一律按 ! 转义，双引号先去掉（与 #tasks 同口径）
        ...samplingIds.map((id) => likePattern(`"orgId":"${String(id).replace(/"/g, "")}"`)),
      ],
    };
  }

  async #taskView(ctx, row) {
    const body = JSON.parse(row.body);
    if (!ctx.access.perms.has(P.read)) {
      delete body.policy;
      delete body.overrides;
    }
    // R22 旧单回算：存量合并单 body 无 trip（059 回填前/无快照漏回填的兜底）→
    // 按首箱建单快照 org＋生效检测站派生显示方向。只注入视图，不改写 body/箱快照。
    if (isMergedSample({ ...body, kind: row.kind }) && !body.trip && !body.tripDerived) {
      const link = await this.db.get(
        "SELECT org_id FROM sample_task_box WHERE task_id=? ORDER BY box_id LIMIT 1",
        [row.id]
      );
      if (link) {
        const station = await resolveStation(this.db);
        const depts = await this.db.all("SELECT id, parent_id, sort FROM sys_dept");
        const orgId = String(link.org_id ?? "") || rootOrgId(depts);
        body.trip = deriveTrip(orgId, station?.id, body.orgId);
        body.tripDerived = true;
      }
    }
    return {
      ...body,
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      // R23 三态类型标签：本地采样＝采样；合并（含旧别名）＝采样后送检；送检/划拨/调拨按 kind
      displayKind: isLocalSample({ ...body, kind: row.kind })
        ? "采样"
        : isMergedSample({ ...body, kind: row.kind })
          ? "采样后送检"
          : row.kind,
      steps: stepsOf({ ...body, kind: row.kind, status: row.status }),
    };
  }

  /**
   * 任务列表。筛选：类型、状态（逗号多选，含「进行中」「已结束」伪态；非法值忽略＝R-c）、单位、创建日期、关键字（任务名、编号、箱号、箱子名称）。
   * mine=1 只列我现在能推进的任务（可与 status/bucket 内存组合）。counts 是同样筛选下各状态的数量，给页面上的状态标签用。
   * sort=updated（默认）按最近流转时间倒序（sample_task_log MAX(created_at)，无新迁移）；sort=created 切回创建序。
   */
  async tasks(ctx) {
    this.require(ctx, BOX.task);
    // #69：本人保管箱集（采样段参与方门本人分支）；mine/bucket 与列表 actions 共用同一份
    const owned = await this.#selfOwnedBoxIds(ctx);
    const visible = this.#visible(ctx);
    const clauses = visible.sql ? [visible.sql] : [];
    const params = [...visible.params];
    if (ctx.query.boxId) {
      await this.targets(ctx, [ctx.query.boxId]);
      clauses.push("EXISTS (SELECT 1 FROM sample_task_box m WHERE m.task_id=t.id AND m.box_id=?)");
      params.push(ctx.query.boxId);
    }
    // R23：任务单页默认放三类任务单（采样/送检/采样后送检），划拨有独立页、旧调拨只读不混入。
    // kind 白名单含旧 调拨/划拨，供迁移前过滤历史行；allKinds=1 兜底回全部。
    // R25：划拨两桶（transferAccept/transferCancel）落地自动 kind=划拨——todo 窗口含划拨待接受，
    // 不带 kind 过滤会落 0 行（默认排除划拨），破坏「卡片数字==落地行数」。显式 kind 优先。
    const transferBucket = ["transferAccept", "transferCancel"].includes(ctx.query.bucket);
    const kindQuery = transferBucket && !ctx.query.kind ? "划拨" : ctx.query.kind;
    if (["采样", "送检", "采样后送检", "划拨", "调拨"].includes(kindQuery)) {
      clauses.push("t.kind=?");
      params.push(kindQuery);
    } else if (ctx.query.allKinds !== "1") {
      clauses.push("t.kind IN ('采样','送检','采样后送检')");
    }
    const orgId = typeof ctx.query.orgId === "string" ? ctx.query.orgId.slice(0, 32) : "";
    if (orgId) {
      clauses.push(`(t.from_org_id=? OR t.to_org_id=? OR t.body LIKE ? ${ESCAPE_SQL})`);
      // 以前是把关键字里的 % 和 _ 直接删掉再拼：搜索词被改了样子，匹配范围反而变窄。
      // 现在原样保留、按 ! 转义，跟箱子列表、日志查询同一个口径（L-P2-5）。
      params.push(orgId, orgId, likePattern(`"orgId":"${orgId}"`));
    }
    const day = (value, endOfDay) => {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    };
    const from = day(ctx.query.from, false),
      to = day(ctx.query.to, true);
    if (from) {
      clauses.push("t.created_at>=?");
      params.push(from);
    }
    if (to) {
      clauses.push("t.created_at<=?");
      params.push(to);
    }
    const q = typeof ctx.query.q === "string" ? ctx.query.q.trim().slice(0, 60) : "";
    if (q) {
      const like = likePattern(q);
      // D7（R22 批3/P1-2）：m.box_id 就是整串 IMEI，无设备标识权限时这一项不参与匹配
      //（与箱子列表 canMatchImei 同口径，堵「IMEI→存在性/挂哪张单」枚举预言机）。
      // b.name 保留现状：已命名箱可按名称搜；未命名箱 name 列空串（编号只在 JSON 出口回显，不落 name 列），非泄漏面。
      const matchImei = canMatchImei(ctx);
      const boxMatch = matchImei
        ? `m.box_id LIKE ? ${ESCAPE_SQL} OR b.name LIKE ? ${ESCAPE_SQL}`
        : `b.name LIKE ? ${ESCAPE_SQL}`;
      clauses.push(
        `(t.id LIKE ? ${ESCAPE_SQL} OR t.name LIKE ? ${ESCAPE_SQL} OR EXISTS (SELECT 1 FROM sample_task_box m LEFT JOIN sample_box b ON b.id=m.box_id WHERE m.task_id=t.id AND (${boxMatch})))`
      );
      params.push(like, like, ...(matchImei ? [like, like] : [like]));
    }
    const base = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    // 各状态数量（不受状态筛选影响）。R23：本地采样已封箱是终态，按 kind+localOnly 区分进行中/已结束。
    // R28：双向寄回单（tripMode=return）已检测是中间态，计进行中（与 isEndedFor/activeTaskSql 同口径）。
    const grouped = await this.db.all(
      `SELECT t.status, t.kind, CASE WHEN t.body LIKE '%"localOnly":true%' THEN 1 ELSE 0 END AS local, CASE WHEN t.body LIKE '%"tripMode":"return"%' THEN 1 ELSE 0 END AS ret, COUNT(*) AS n FROM sample_task t ${base} GROUP BY t.status, t.kind, local, ret`,
      params
    );
    const counts = { 全部: 0, 进行中: 0, 已结束: 0, 签收: 0 };
    for (const row of grouped) {
      const n = Number(row.n);
      counts[row.status] = (counts[row.status] || 0) + n;
      if (SIGN_STEPS.includes(row.status)) counts.签收 += n;
      counts.全部 += n;
      const ended =
        (ENDED.includes(row.status) && !(Number(row.ret) === 1 && row.status === "已检测")) ||
        (row.kind === "采样" && Number(row.local) === 1 && row.status === "已封箱");
      counts[ended ? "已结束" : "进行中"] += n;
    }
    // 我能推进的：只在进行中的任务里找，最多看 500 张（与工作台 todo 同窗口）。
    // 窗口序保持 created_at DESC（D1：与 todo() 同窗口同序，卡数==落地数不变）；
    // 带出 last_flow_at 供 mine/bucket 内存路径按「最近更新」排序（D4/批5）。
    const activeRows = await this.db.all(
      `SELECT t.*, f.last_flow_at FROM sample_task t ${LAST_FLOW_JOIN} ${base ? `${base} AND` : "WHERE"} ${activeTaskSql()} ORDER BY t.created_at DESC LIMIT 500`,
      params
    );
    // 每单 abilities 算一次：mine 过滤与 bucket 分桶共用（D1：与 todo() 同谓词同窗口）
    const active = activeRows.map((row) => {
      const task = JSON.parse(row.body);
      return { row, task, can: this.#abilities(ctx, task, row.status, owned) };
    });
    // 只能取消的不算「待我处理」：和工作台、顶栏铃铛用同一个口径
    const mineRows = active.filter((item) => actionable(item.can)).map((item) => item.row);
    counts.mine = mineRows.length;
    // D1（R22 批2）：bucket 与 todo() 同谓词（bucketsOf），在同一「进行中前 500 张」窗口上分桶，
    // 保证工作台卡片数字==点击落地行数。overLimit 要开箱数，仅该桶时逐单算；其余桶只看 can。
    // 非法 bucket 静默忽略（回落普通列表，与 kind 非法值同口径）。
    const bucket = BUCKET_KEYS.includes(ctx.query.bucket) ? ctx.query.bucket : "";
    let bucketIds = null;
    if (bucket) {
      bucketIds = new Set();
      for (const item of active) {
        const openOver =
          bucket === "overLimit" && Number.isInteger(item.task.maxOpens)
            ? overOpenLimit(item.task, await openCounts(this.db, item.row.id)).length
            : null;
        if (bucketsOf(item.task, item.row.status, item.can, openOver).includes(bucket))
          bucketIds.add(item.row.id);
      }
    }

    // 批4：status 支持逗号分隔多选（16 态＋划拨两态＋伪态）；非法值忽略该筛选（R-c，与 kind/bucket 同口径）。
    // 单值行为与 R22 完全一致（伪态走 SQL 谓词、具体态等值）；多值按 OR 组合（伪态谓词 OR 具体态 IN）。
    const statusKeys = [
      ...new Set(
        String(ctx.query.status || "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => STATUS_KEYS.includes(s))
          .slice(0, 24)
      ),
    ];
    const statusClauses = [...clauses],
      statusParams = [...params];
    if (statusKeys.length) {
      const concrete = statusKeys.filter((key) => !statusSqlOf(key));
      const parts = statusKeys.filter((key) => statusSqlOf(key)).map((key) => statusSqlOf(key));
      if (concrete.length) {
        parts.push(`t.status IN (${concrete.map(() => "?").join(",")})`);
        statusParams.push(...concrete);
      }
      statusClauses.push(parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`);
    }
    // D4（批5）：默认排序＝最近更新（流转日志 MAX(created_at)）；sort=created 切回创建序；非法值回落默认。
    const sort = ctx.query.sort === "created" ? "created" : "updated";
    const orderBy =
      sort === "created"
        ? "t.created_at DESC, t.id DESC"
        : "COALESCE(f.last_flow_at, t.created_at) DESC, t.id DESC";
    const where = statusClauses.length ? `WHERE ${statusClauses.join(" AND ")}` : "";
    const page = Math.max(1, Math.floor(Number(ctx.query.page) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(ctx.query.pageSize) || 20)));
    let rows, total;
    const mine = ctx.query.mine === "1";
    if (mine || bucket) {
      // mine/bucket/status 在内存组合（mineRows 上再过滤，500 截断行为不变；P1-4：mine+status 可组合）。
      // bucket 命中集来自 activeRows（todo 同窗口）；mine=1 再与 mineRows 取交集
      //（can 基桶 send/arrive/sign/returning/sampling 本就⊆mineRows；overLimit 含只能取消的单，故不强制 mine）。
      let picked = bucket ? activeRows.filter((row) => bucketIds.has(row.id)) : mineRows;
      if (mine && bucket) {
        const mineIds = new Set(mineRows.map((row) => row.id));
        picked = picked.filter((row) => mineIds.has(row.id));
      }
      if (statusKeys.length) {
        // 窗口本身只含进行中：进行中＝全留、已结束＝空；签收/具体状态按状态名匹配；多选 OR（批4）
        picked = picked.filter((row) => statusKeys.some((key) => statusMatchOf(key, row.status)));
      }
      // D4（批5）：内存路径与 SQL 路径同排序键（最近更新＝last_flow_at，创建＝created_at），id DESC 兜底同秒
      picked = [...picked].sort((a, b) => {
        const ka = sort === "created" ? a.created_at : flowAtOf(a);
        const kb = sort === "created" ? b.created_at : flowAtOf(b);
        return ka < kb ? 1 : ka > kb ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
      total = picked.length;
      rows = picked.slice((page - 1) * pageSize, page * pageSize);
    } else {
      rows = await this.db.all(
        `SELECT t.*, f.last_flow_at FROM sample_task t ${LAST_FLOW_JOIN} ${where} ORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ?`,
        [...statusParams, (page - 1) * pageSize]
      );
      total = Number(
        (await this.db.get(`SELECT COUNT(*) AS n FROM sample_task t ${where}`, statusParams)).n
      );
    }
    const withPosition = ctx.access.perms.has(BOX.location);
    const list = [];
    for (const row of rows) {
      const task = await this.#taskView(ctx, row);
      // D4（批5）：最近更新＝最近一条流转日志时间（建单日志兜底），列表「最近更新」列与排序键同源
      task.updatedAt = flowAtOf(row);
      // 正在去某地的任务，算出有几台已到附近
      const target = MOVING.includes(row.status) ? targetOf(task, row.status) : null;
      if (target && withPosition && hasCoords(target)) {
        const boxes = await boxDistances(this.db, task.boxIds || [], target, {
          radius: await taskRadiusOf(this.db, task, target),
        });
        task.arrival = {
          role: target.role,
          near: boxes.filter((b) => b.near).length,
          total: boxes.length,
        };
      }
      if (Number.isInteger(task.maxOpens))
        task.openOver = overOpenLimit(task, await openCounts(this.db, row.id)).length;
      // R25：划拨动作面在调拨单页（accept/cancel/reject/tracking/retransfer），通用任务单页无划拨推进对话框——
      // 划拨行 actions 恒 []（R24 行为不变），避免把动作键当状态名渲染成坏按钮。
      task.actions =
        row.kind === "划拨"
          ? []
          : Object.entries(this.#abilities(ctx, task, row.status, owned))
              .filter(([, ok]) => ok)
              .map(([to]) => to);
      list.push(task);
    }
    ctx.ok({ list, total, counts });
  }

  /** 划拨/送检功能常开（组织简化后无开关）：守卫入口保留、恒通过（transferInspectEnabled 恒 true），旧 off 配置不再拦新端点。 */
  #requireTransferFeature() {
    if (!transferInspectEnabled()) throw notConfigured("划拨/送检功能未开通，请先在系统设置中开启");
  }

  /**
   * 划拨提交的口令再认证（R24 #70，PM 裁决「划拨需要二次确认和输入密码」）。
   * 写法照 auth/AccountSecurity.js:29-40：按 ctx.user.id 重查 sys_user，用 verifyPassword 比 hash。
   * 三条刻意选择，别顺手「优化」：
   * 1. 不复用 AccountSecurity.attempts 计数——那套锁定是给改密入口用的，错口令把改密一起锁掉不合适；
   *    划拨走的是已登录态，防爆破由登录与口令策略管（安全设置里的锁定阈值不该被这里改动）。
   * 2. 缺口令 400、口令错 403，两条都不回显任何口令信息。
   * 3. 失败也留一条审计（result 显式写「失败」——operationLog.js:39 只认这个值，其余一律归「成功」），
   *    detail 只记原因文本，绝不带 password / ctx.body / password_hash。
   * 会话有效性不在这里重复判：index.js 的 currentUser() 每条请求都重读 sys_user 并核 sessionMatches。
   */
  async #confirmPassword(ctx) {
    const password = (ctx.body || {}).password;
    if (typeof password !== "string" || !password) {
      await this.#auditTransferConfirm(ctx, "缺少确认口令");
      throw badRequest("请输入登录密码以确认划拨");
    }
    if (password.length > 1024) {
      await this.#auditTransferConfirm(ctx, "确认口令超长");
      throw badRequest("登录密码格式不正确");
    }
    const current = await this.db.get("SELECT status, password_hash FROM sys_user WHERE id = ?", [
      String(ctx.user?.id ?? ""),
    ]);
    if (!current || Number(current.status) !== 1) {
      await this.#auditTransferConfirm(ctx, "账号不可用");
      throw noPermission("账号已停用或不存在，请联系管理员");
    }
    if (!verifyPassword(password, current.password_hash)) {
      await this.#auditTransferConfirm(ctx, "确认口令不正确");
      throw noPermission("密码不正确");
    }
  }

  /** 口令再认证失败的审计留痕：只记「谁、什么时候、没过」，不记口令本身（见 #confirmPassword 第 3 条）。 */
  async #auditTransferConfirm(ctx, reason) {
    await audit(this.db, {
      orgId: String(ctx.user?.dept_id || ""),
      orgName: "",
      actorId: String(ctx.user?.id ?? ""),
      actorName: ctx.user?.nickname || ctx.user?.username || "",
      action: "提交划拨",
      targetType: "report-policy",
      targetId: "",
      result: "失败",
      detail: { 二次确认: false, 原因: reason },
      ip: ctx.ip || "",
    });
  }

  /**
   * 创建划拨单（POST /sample/transfers，R25 三态）：创建后落待接受，归属在接受时转移。
   * 箱子可见性沿用 targets（不存在/范围外同一个 404）；提交守卫与 candidate-boxes 同一函数。
   * 二次确认口令（R24 #70）沿用：先于 clientToken 幂等命中校验。trackingNo 选填 ≤64（R25③）。
   */
  async createTransfer(ctx) {
    this.#requireTransferFeature();
    this.require(ctx, T.createTransfer);
    const input = ctx.body || {};
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120)
      throw badRequest("请填写划拨单名称");
    if (input.toOrgId == null || String(input.toOrgId) === "") throw badRequest("请选择目标公司");
    if (input.note != null && (typeof input.note !== "string" || input.note.length > 1000))
      throw badRequest("备注格式不正确");
    if (
      input.trackingNo != null &&
      (typeof input.trackingNo !== "string" || input.trackingNo.length > 64)
    )
      throw badRequest("快递单号格式不正确（64 字以内）");
    if (
      input.clientToken != null &&
      (typeof input.clientToken !== "string" || input.clientToken.length > 64)
    )
      throw badRequest("clientToken 格式不正确");
    // R24（#70）划拨二次确认：口令必须在 clientToken 幂等命中之前校验——幂等查询在
    // policies.createTransfer 里，先命中就直接返回原单，等于让「重复提交」绕过再认证。
    // 放在名称/目标/备注这些纯格式校验之后：格式错本来就该先提示，且不影响这条安全顺序。
    await this.#confirmPassword(ctx);
    const boxes = await this.targets(ctx, input.boxIds);
    if (boxes.length > 500) throw badRequest("一张划拨单最多 500 台箱子，请分批提交");
    const result = await this.policies.createTransfer(
      {
        name: input.name.trim(),
        toOrgId: String(input.toOrgId),
        boxIds: boxes.map((b) => b.id),
        note: input.note || "",
        trackingNo: typeof input.trackingNo === "string" ? input.trackingNo : "",
        clientToken: input.clientToken || "",
      },
      { ...actorOf(ctx), scope: ctx.access?.scope }
    );
    const data = await this.policies.transferView(result.id);
    if (!data) throw notVisible("划拨单不存在或不在你的管理范围内");
    // R24（#70）：提交成功的审计带一条 detail={二次确认:true}，说明这单过了口令再认证。
    // 口径与 this.log 一致（同 action/targetType/targetId），只是多一个不含敏感信息的 detail；
    // 绝不把 input / ctx.body / password 塞进来（audit→insertOperationLog 只落固定列，见 #confirmPassword 第 3 条）。
    await audit(this.db, {
      orgId: String(ctx.user.dept_id || ""),
      orgName: "",
      actorId: String(ctx.user.id),
      actorName: ctx.user.nickname || ctx.user.username,
      action: result.idempotent ? "提交划拨（重复提交，返回原单）" : "提交划拨",
      targetType: "report-policy",
      targetId: result.id,
      result: "成功",
      detail: { 二次确认: true },
      ip: ctx.ip || "",
    });
    ctx.ok(
      {
        ...data,
        idempotent: result.idempotent,
        abilities: this.#transferAbilities(
          ctx,
          { ...data, toOrgId: data.toOrg.id, boxIds: data.boxes.map((b) => b.boxId) },
          data.status,
          data.boxCount
        ),
      },
      result.idempotent
        ? "已提交过，返回原划拨单"
        : `已提交，${data.boxCount} 台箱子待 ${data.toOrg.name} 管理员接受`
    );
  }

  /**
   * 接受划拨（POST /sample/transfers/:id/accept，R25①）：目标分公司管理员确认。
   * 门：task:transfer:accept 码＋目标 manageOrgIds 参与方门＋待接受态。接受事务内归属转移＋保管人清空＋审计。
   * 不加密码（口径⑤仅创建需密码）。
   */
  async acceptTransfer(ctx) {
    this.#requireTransferFeature();
    this.require(ctx, T.transferAccept);
    const row = await this.#visibleTask(ctx);
    if (row.kind !== "划拨") throw conflict("只有划拨单可以接受");
    const task = JSON.parse(row.body);
    if (!inPartyScope(ctx, task.toOrgId)) throw noPermission("只能接受划拨到你自己范围内的单位");
    const result = await this.policies.acceptTransfer(row.id, { actor: actorOf(ctx) });
    this.boxes.summaryCache?.clear();
    await this.log(ctx, "接受划拨", row.id);
    ctx.ok(result, `已接受，${result.count} 台箱子归属已转到 ${result.toOrg.name}`);
  }

  /**
   * 取消划拨（POST /sample/transfers/:id/cancel，R25②创建方出口）：创建方＋待接受。
   * 接受前箱未动，取消无守卫；备注选填 ≤100。不加密码。
   */
  async cancelTransfer(ctx) {
    this.#requireTransferFeature();
    const row = await this.#visibleTask(ctx);
    if (row.kind !== "划拨") throw conflict("只有划拨单可以取消");
    const task = JSON.parse(row.body);
    const me = String(ctx.user?.id ?? "");
    if (String(task.createdById ?? "") !== me && !isAdminRole(ctx))
      throw noPermission("只有创建方可以取消这张划拨单");
    const note = typeof ctx.body?.note === "string" ? ctx.body.note.trim() : "";
    if (note.length > 100) throw badRequest("取消备注 100 字以内");
    const result = await this.policies.cancelTransfer(row.id, { note, actor: actorOf(ctx) });
    await this.log(ctx, "取消划拨", row.id);
    ctx.ok(result, "已取消，箱子归属未动");
  }

  /**
   * 拒收划拨（POST /sample/transfers/:id/reject，R25②接收方出口）：目标 manageOrgIds＋task:reject＋待接受。
   * 原因必填 ≤100（沿用签收拒收模式）。箱不动。不加密码。
   */
  async rejectTransfer(ctx) {
    this.#requireTransferFeature();
    this.require(ctx, T.reject);
    const row = await this.#visibleTask(ctx);
    if (row.kind !== "划拨") throw conflict("只有划拨单可以拒收");
    const task = JSON.parse(row.body);
    if (!inPartyScope(ctx, task.toOrgId)) throw noPermission("只能拒收划拨到你自己范围内的单位");
    const reason = typeof ctx.body?.reason === "string" ? ctx.body.reason.trim() : "";
    if (!reason || reason.length > 100) throw badRequest("请填写拒收原因（100 字以内）");
    const result = await this.policies.rejectTransfer(row.id, { reason, actor: actorOf(ctx) });
    await this.log(ctx, "拒收划拨", row.id);
    ctx.ok(result, "已拒收，箱子归属未动");
  }

  /**
   * 补填/修改快递单号（POST /sample/transfers/:id/tracking，R25③）：创建方＋待接受。
   * 单号 ≤64（空串＝清空）；接受后只读（领域层 status 门拦）。不加密码。
   */
  async trackingTransfer(ctx) {
    this.#requireTransferFeature();
    const row = await this.#visibleTask(ctx);
    if (row.kind !== "划拨") throw conflict("只有划拨单可以补填快递单号");
    const task = JSON.parse(row.body);
    const me = String(ctx.user?.id ?? "");
    if (String(task.createdById ?? "") !== me && !isAdminRole(ctx))
      throw noPermission("只有创建方可以补填快递单号");
    if (ctx.body?.trackingNo != null && typeof ctx.body.trackingNo !== "string")
      throw badRequest("快递单号格式不正确");
    const trackingNo = typeof ctx.body?.trackingNo === "string" ? ctx.body.trackingNo : "";
    if (trackingNo.length > 64) throw badRequest("快递单号格式不正确（64 字以内）");
    const result = await this.policies.trackingTransfer(row.id, {
      trackingNo,
      actor: actorOf(ctx),
    });
    await this.log(ctx, "补填快递单号", row.id);
    ctx.ok(result, trackingNo ? "快递单号已保存" : "快递单号已清空");
  }

  /**
   * 撤销划拨（R24 已下线，不再挂路由：POST /sample/transfers/:id/revoke 直接回 410）。
   * 方法本体连同领域层 policies.revokeTransfer、整单禁撤四守卫保留，只服务回归用例直调与
   * 历史已撤销单的审计口径；要恢复撤销功能就是把 index.js 那一行接回来。
   */
  async revokeTransfer(ctx) {
    this.#requireTransferFeature();
    this.require(ctx, T.transferRevoke);
    const row = await this.#visibleTask(ctx);
    if (row.kind !== "划拨") throw conflict("只有划拨单可以撤销");
    const reason = typeof ctx.body?.reason === "string" ? ctx.body.reason.trim() : "";
    if (!reason || reason.length > 100) throw badRequest("请填写撤销原因（100 字以内）");
    const result = await this.policies.revokeTransfer(row.id, { reason, actor: actorOf(ctx) });
    this.boxes.summaryCache?.clear();
    await this.log(ctx, "撤销划拨", row.id);
    const orgs = [...new Set(result.restored.map((r) => r.toOrg))].join("、");
    ctx.ok(result, `已撤销，${result.restoredCount} 台箱子归属已退回 ${orgs}`);
  }

  /**
   * 划拨向导的箱子集下发（GET /sample/transfers/candidate-boxes，§6.5）：
   * 替换预览页的 16 台 POOL 副本。selectable/reasonCode 与提交守卫同一函数（transferBlock），
   * 不会「向导能选、提交被拒」。历史上开过盖/做过检测不下发也不拦（D-9，撤销时才判）。
   */
  async transferCandidates(ctx) {
    this.#requireTransferFeature();
    this.require(ctx, T.createTransfer);
    const q = typeof ctx.query.q === "string" ? ctx.query.q.trim().slice(0, 100) : "";
    const orgId = typeof ctx.query.orgId === "string" ? ctx.query.orgId.slice(0, 32) : "";
    const life = ["待激活", "未使用", "在途", "停用"].includes(ctx.query.life)
      ? ctx.query.life
      : "";
    const toOrgId = String(ctx.query.toOrgId ?? "");
    let target = null;
    if (toOrgId) {
      target = await this.db.get("SELECT id,name FROM sys_dept WHERE id=? AND status=1", [toOrgId]);
      if (!target) throw badRequest("目标公司不存在或已停用");
    }
    const page = Math.max(1, Math.floor(Number(ctx.query.page) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(ctx.query.pageSize) || 50)));
    const where = [];
    const params = [];
    const scoped = scopeSql(ctx.access?.scope);
    if (scoped) {
      where.push(scoped.sql);
      params.push(...scoped.params);
    }
    if (q) {
      const like = likePattern(q);
      // 编号就是 IMEI：没有设备标识权限只搜名称/保管人，与箱子列表同一口径
      if (identityGranted(ctx.access.perms)) {
        where.push(
          `(name LIKE ? ${ESCAPE_SQL} OR id LIKE ? ${ESCAPE_SQL} OR owner LIKE ? ${ESCAPE_SQL})`
        );
        params.push(like, like, like);
      } else {
        where.push(`(name LIKE ? ${ESCAPE_SQL} OR owner LIKE ? ${ESCAPE_SQL})`);
        params.push(like, like);
      }
    }
    if (orgId) {
      where.push("org_id=?");
      params.push(orgId);
    }
    if (life) {
      where.push("life=?");
      params.push(life);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number(
      (await this.db.get(`SELECT COUNT(*) AS n FROM sample_box ${whereSql}`, params)).n
    );
    const rows = await this.db.all(
      `SELECT id,name,org,org_id,owner,owner_id,life,last_report_at,battery_mv FROM sample_box ${whereSql} ORDER BY id LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );
    const seePower = ctx.access.perms.has(BOX.power);
    const list = [];
    let selectableCount = 0;
    let blockedCount = 0;
    for (const row of rows) {
      const hit = await transferBlock(
        this.db,
        row,
        target ? { id: String(target.id), name: target.name } : null
      );
      // 占用关系与 busy 守卫同一判定（未结束单 × 未开始检测；R28 寄回腿期间仍占用），多单取最早建单那张
      const bound = await this.db.get(
        `SELECT t.id,t.name,t.kind,t.status,t.created_at FROM sample_task t JOIN sample_task_box m ON m.task_id=t.id WHERE m.box_id=? AND ${activeTaskSql()} AND ${boxHeldSql()} ORDER BY t.created_at LIMIT 1`,
        [row.id]
      );
      if (hit) blockedCount += 1;
      else selectableCount += 1;
      list.push({
        boxId: row.id,
        code: row.id,
        name: boxNameCell({ name: row.name || row.id, id: row.id }, ctx.access.perms),
        orgId: String(row.org_id ?? ""),
        org: row.org,
        ownerId: String(row.owner_id ?? ""),
        owner: row.owner || "—",
        life: row.life,
        lastReportAt: row.last_report_at || "",
        batteryMv: seePower
          ? row.battery_mv == null || row.battery_mv === ""
            ? null
            : Number(row.battery_mv)
          : null,
        boundTask: bound
          ? {
              id: bound.id,
              name: bound.name,
              kind: bound.kind,
              status: bound.status,
              createdAt: bound.created_at,
            }
          : null,
        selectable: !hit,
        ...(hit ? { reasonCode: hit.reasonCode, reason: hit.reason } : {}),
      });
    }
    ctx.ok({ list, total, selectableCount, blockedCount, page, pageSize });
  }

  /**
   * 划拨列表（GET /sample/transfers，kind=划拨，R25 三态）：counts 与列表同口径（同一 WHERE 去掉 status），
   * boxCountTotal 是箱次累计口径（同一箱子出现在多单计多次）。
   * 页签 全部/待接受/已结束/已撤销·历史＋状态 chips（已完成/已取消/已拒收多选）：status 参数收伪态
   * （已结束＝三终态合集、已撤销·历史＝已撤销）或逗号分隔具体态；非法值忽略（与 tasks 同口径）。
   * 门禁（R25）：新建划拨 或 接受划拨 任一码（接受方可能只持 accept 码）；与 local-menus/menus.js 同口径。
   * 每行带 abilities（按态×角色）＋快递单号＋终态事实（接受/拒收/取消/撤销人·时间）＋历史标。
   */
  async transfers(ctx) {
    this.#requireTransferFeature();
    this.#requireTransferView(ctx);
    const visible = this.#visible(ctx);
    const clauses = ["t.kind='划拨'", ...(visible.sql ? [visible.sql] : [])];
    const params = [...visible.params];
    const orgId = typeof ctx.query.orgId === "string" ? ctx.query.orgId.slice(0, 32) : "";
    if (orgId) {
      // from 匹配建单快照（跨公司批量时 from_org_id 为 NULL），to 匹配 to_org_id
      clauses.push(
        "(t.to_org_id=? OR EXISTS (SELECT 1 FROM sample_task_box m WHERE m.task_id=t.id AND m.org_id=?))"
      );
      params.push(orgId, orgId);
    }
    const day = (value, endOfDay) => {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    };
    const from = day(ctx.query.from, false),
      to = day(ctx.query.to, true);
    if (from) {
      clauses.push("t.created_at>=?");
      params.push(from);
    }
    if (to) {
      clauses.push("t.created_at<=?");
      params.push(to);
    }
    const q = typeof ctx.query.q === "string" ? ctx.query.q.trim().slice(0, 60) : "";
    if (q) {
      const like = likePattern(q);
      clauses.push(
        `(t.id LIKE ? ${ESCAPE_SQL} OR t.name LIKE ? ${ESCAPE_SQL} OR t.body LIKE ? ${ESCAPE_SQL} OR EXISTS (SELECT 1 FROM sample_task_box m LEFT JOIN sample_box b ON b.id=m.box_id WHERE m.task_id=t.id AND (m.box_id LIKE ? ${ESCAPE_SQL} OR b.name LIKE ? ${ESCAPE_SQL})))`
      );
      params.push(like, like, likePattern(`"trackingNo":"${q}"`), like, like);
    }
    const base = `WHERE ${clauses.join(" AND ")}`;
    const grouped = await this.db.all(
      `SELECT t.status, COUNT(*) AS n FROM sample_task t ${base} GROUP BY t.status`,
      params
    );
    // counts 按归一状态累加（历史已划拨→已完成）；已结束＝已完成/已取消/已拒收三终态合集
    const counts = { 全部: 0, 待接受: 0, 已完成: 0, 已取消: 0, 已拒收: 0, 已撤销: 0, 已结束: 0 };
    for (const row of grouped) {
      const n = Number(row.n);
      const status = transferStatusOf(row.status);
      counts[status] = (counts[status] || 0) + n;
      counts.全部 += n;
      if (["已完成", "已取消", "已拒收"].includes(status)) counts.已结束 += n;
    }
    counts.boxCountTotal = Number(
      (
        await this.db.get(
          `SELECT COUNT(*) AS n FROM sample_task_box m JOIN sample_task t ON t.id=m.task_id ${base}`,
          params
        )
      ).n
    );
    // status 筛选：伪态展开＋具体态多选（逗号）；已完成含历史已划拨别名（读兼容未迁移行）
    const statusClauses = [...clauses],
      statusParams = [...params];
    const requested = [
      ...new Set(
        String(ctx.query.status || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      ),
    ];
    const concrete = new Set();
    for (const key of requested) {
      if (key === "已结束") ["已完成", "已取消", "已拒收"].forEach((s) => concrete.add(s));
      else if (key === "已撤销·历史" || key === "已撤销") concrete.add("已撤销");
      else if (TRANSFER_STATUS_KEYS.includes(key)) concrete.add(key);
    }
    if (concrete.size) {
      const raw = new Set();
      for (const s of concrete) {
        raw.add(s);
        if (s === "已完成") raw.add("已划拨"); // 历史别名读兼容
      }
      statusClauses.push(`t.status IN (${[...raw].map(() => "?").join(",")})`);
      statusParams.push(...raw);
    }
    const where = `WHERE ${statusClauses.join(" AND ")}`;
    const page = Math.max(1, Math.floor(Number(ctx.query.page) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(ctx.query.pageSize) || 20)));
    const rows = await this.db.all(
      `SELECT t.* FROM sample_task t ${where} ORDER BY created_at DESC,id DESC LIMIT ${pageSize} OFFSET ?`,
      [...statusParams, (page - 1) * pageSize]
    );
    const total = Number(
      (await this.db.get(`SELECT COUNT(*) AS n FROM sample_task t ${where}`, statusParams)).n
    );
    const depts = await this.db.all("SELECT id,name FROM sys_dept");
    const orgNameOf = new Map(depts.map((d) => [String(d.id), d.name]));
    // 终态事实日志一次取回（接受/拒收/取消/撤销），按 task_id+action 归组，避免逐行 N 查询
    const ids = rows.map((r) => r.id);
    const factRows = ids.length
      ? await this.db.all(
          `SELECT task_id,action,created_at,actor_name,note FROM sample_task_log WHERE task_id IN (${ids.map(() => "?").join(",")}) AND action IN ('接受划拨','拒收划拨','取消划拨','撤销划拨') ORDER BY created_at DESC`,
          ids
        )
      : [];
    const factOf = new Map();
    for (const log of factRows) {
      const key = `${log.task_id}|${log.action}`;
      if (!factOf.has(key)) factOf.set(key, log); // DESC 序首条＝最近
    }
    const list = [];
    for (const row of rows) {
      const body = JSON.parse(row.body);
      const links = await this.db.all("SELECT org_id FROM sample_task_box WHERE task_id=?", [
        row.id,
      ]);
      const fromMap = new Map();
      for (const link of links) {
        const id = String(link.org_id ?? "");
        const bucket = fromMap.get(id) || {
          orgId: id,
          orgName: orgNameOf.get(id) || id || "总公司",
          count: 0,
        };
        bucket.count += 1;
        fromMap.set(id, bucket);
      }
      const status = transferStatusOf(row.status);
      const accept = factOf.get(`${row.id}|接受划拨`);
      const reject = factOf.get(`${row.id}|拒收划拨`);
      const cancel = factOf.get(`${row.id}|取消划拨`);
      const revoke = factOf.get(`${row.id}|撤销划拨`);
      list.push({
        id: row.id,
        name: row.name,
        status,
        createdAt: row.created_at,
        boxCount: links.length,
        from: [...fromMap.values()],
        toOrg: {
          id: String(row.to_org_id ?? ""),
          name: body.toOrg || orgNameOf.get(String(row.to_org_id ?? "")) || "",
        },
        by: body.createdBy || "",
        byId: body.createdById || "",
        trackingNo: body.trackingNo || "",
        legacy: body.legacyTransfer === true,
        abilities: this.#transferAbilities(
          ctx,
          {
            ...body,
            kind: "划拨",
            toOrgId: String(row.to_org_id ?? ""),
            createdById: body.createdById || "",
          },
          status,
          links.length
        ),
        ...(accept ? { acceptedAt: accept.created_at, acceptedBy: accept.actor_name || "" } : {}),
        ...(reject
          ? {
              rejectedAt: reject.created_at,
              rejectedBy: reject.actor_name || "",
              rejectReason: reject.note || "",
            }
          : {}),
        ...(cancel ? { cancelledAt: cancel.created_at, cancelledBy: cancel.actor_name || "" } : {}),
        ...(revoke ? { revokedAt: revoke.created_at, revokeReason: revoke.note || "" } : {}),
      });
    }
    ctx.ok({
      list,
      total,
      counts,
      kpiHints: { boxCountTotal: "箱次口径：同一箱子出现在多单计多次" },
    });
  }

  /** 划拨详情（GET /sample/transfers/:id，R25）：逐台快照（当前归属/保管人/电量/位置）＋终态事实＋审计线＋按态×角色 abilities。
   * 门禁同 transfers 列表：新建划拨 或 接受划拨 任一码。编号脱敏/电量按权限遮挡（与箱子列表同口径）。 */
  async transferDetail(ctx) {
    this.#requireTransferFeature();
    this.#requireTransferView(ctx);
    const row = await this.#visibleTask(ctx);
    if (row.kind !== "划拨") throw notVisible("划拨单不存在或不在你的管理范围内");
    const data = await this.policies.transferView(row.id);
    const perms = ctx.access.perms;
    const seePower = perms.has(BOX.power);
    const seePosition = perms.has(BOX.location);
    // 编号脱敏（前3后4）：无设备标识权限遮 IMEI；电量/位置按各自权限遮挡（与箱子列表/候选集同口径）
    const boxes = data.boxes.map((b) => ({
      ...b,
      code: identityGranted(perms) ? b.code : maskImei(b.code),
      batteryMv: seePower ? b.batteryMv : null,
      batteryUsable: seePower ? b.batteryUsable : null,
      gpsLng: seePosition ? b.gpsLng : null,
      gpsLat: seePosition ? b.gpsLat : null,
      lbsLng: seePosition ? b.lbsLng : null,
      lbsLat: seePosition ? b.lbsLat : null,
    }));
    const logs = await this.db.all(
      "SELECT * FROM sample_task_log WHERE task_id=? ORDER BY created_at, id",
      [row.id]
    );
    ctx.ok({
      ...data,
      boxes,
      abilities: this.#transferAbilities(
        ctx,
        { ...data, toOrgId: data.toOrg.id, boxIds: data.boxes.map((b) => b.boxId) },
        data.status,
        data.boxCount
      ),
      logs: logs.map((log) => ({
        status: log.status,
        action: log.action,
        by: log.actor_name || "",
        note: log.note || "",
        time: log.created_at,
        detail: log.detail ? JSON.parse(log.detail) : null,
      })),
    });
  }

  /** 创建页的候选：所有启用单位（含有效位置、是否在自己范围内），选了单位再取人员。 */
  async taskOptions(ctx) {
    // R21（062）：送检严格要 create:inspect 后，仅持送检码（无 sample/transfer）也要能取建单选项
    const perms = ctx.access?.perms;
    if (!perms?.has(T.createTransfer) && !perms?.has(T.createInspect))
      this.require(ctx, T.createSample);
    // 列明白写出来（L-P2-4）：这张表后面还长过 cameras、perm_limited、max_data_scope 这些
    // 只给授权页用的列，SELECT d.* 早晚把它们带到只给创建页的响应里。
    const rows = await this.db.all(
      `SELECT d.id, d.parent_id, d.name, d.type, d.sort, d.address, d.lng, d.lat, d.contact, d.phone,
              d.leader_user_id, u.nickname AS leader_name
         FROM sys_dept d LEFT JOIN sys_user u ON u.id = d.leader_user_id AND u.status = 1
        WHERE d.status = 1`
    );
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const pathOf = (id) => {
      const names = [];
      const seen = new Set();
      for (
        let cursor = byId.get(String(id));
        cursor && !seen.has(String(cursor.id));
        cursor = byId.get(String(cursor.parent_id))
      ) {
        seen.add(String(cursor.id));
        names.unshift(cursor.name);
      }
      return names.join(" / ");
    };
    const orgs = rows
      .map((row) => ({
        id: String(row.id),
        parentId: String(row.parent_id),
        name: row.name,
        type: row.type || "公司",
        path: pathOf(row.id),
        inScope: inScope(ctx, row.id),
        location: effectiveDeptLocation(rows, row.id),
        leader: row.leader_name ? { id: String(row.leader_user_id), name: row.leader_name } : null,
      }))
      // #87：非管理员只回数据范围内的单位——原先全量返回＋inScope 旗标，前端把范围外公司
      // disabled 灰显仍泄露名称与层级（分公司管理员看见华东/西南/总公司）。ADMIN（scope.all）全量保持；
      // 保留行的 path 祖先名随子树自然带出，属范围内信息。
      .filter((org) => org.inScope || isSystemAdmin(ctx))
      .sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
    let users = [];
    const orgId = String(ctx.query.orgId || "");
    // #87：按单位取人员同样过范围门——越权 orgId 回空数组，不给他单位人员名单（原先只查部门存在）
    if (byId.has(orgId) && (inScope(ctx, orgId) || isSystemAdmin(ctx))) {
      const ids = [
        orgId,
        ...orgs.filter((org) => org.path.startsWith(`${pathOf(orgId)} / `)).map((org) => org.id),
      ];
      const found = await this.db.all(
        `SELECT id,nickname,dept_id FROM sys_user WHERE status=1 AND dept_id IN (${ids.map(() => "?").join(",")}) ORDER BY nickname LIMIT 200`,
        ids
      );
      users = found.map((row) => ({
        id: String(row.id),
        name: row.nickname,
        dept: pathOf(row.dept_id),
      }));
    }
    // 创建任务页的默认值都从系统设置来：前端不要再写死一个「60 秒」，
    // 管理员把默认上报周期改了，页面上的「本任务统一」初始值要跟着变。
    const settings = currentBoxSettings();
    // 组织简化（P5/P10）：合并单接收方固定唯一检测站——候选只回 station（带位置/负责人，签收人默认检测站负责人）。
    // orgs 仍列全部启用单位，供寄出分公司（采样单位）选择；接收方不再从 orgs 里挑。
    // B1b：resolveStation 统一解析（配置优先→DB 恰一个自动认定），stationDeptId 回生效值。
    const resolved = await resolveStation(this.db);
    const stationId = resolved ? String(resolved.id) : "";
    const stationRow = resolved ? byId.get(stationId) : null;
    const station = stationRow
      ? {
          id: String(stationRow.id),
          name: stationRow.name,
          type: stationRow.type || "公司",
          path: pathOf(stationRow.id),
          location: effectiveDeptLocation(rows, stationRow.id),
          leader: stationRow.leader_name
            ? { id: String(stationRow.leader_user_id), name: stationRow.leader_name }
            : null,
        }
      : null;
    // R13 拍板①：公司任务期间默认策略随寄出单位下发——建单页「本任务统一」初始值用它
    //（公司未设＝null，页面回落系统默认）；提交未勾「本任务统一」时服务端再以它兜底入快照。
    const companyTaskPolicy = orgId ? await companyTaskFor(this.db, orgId) : null;
    const companyRadius = orgId
      ? (await companyJudgmentFor(this.db, orgId)).arriveRadiusM
      : settings.arriveRadiusM;
    ctx.ok({
      orgs,
      users,
      station,
      stationDeptId: stationId || "",
      myOrgId: String(ctx.user?.dept_id || ""),
      arriveRadiusM: companyRadius,
      defaultReportPeriodSec: settings.reportPeriodSec,
      defaultReportOnlyWhenCharging: settings.reportOnlyWhenCharging,
      companyTaskPolicy,
    });
  }

  /** 任务详情：任务、流转记录、各箱当前位置和到当前目标的距离。 */
  async taskDetail(ctx) {
    this.require(ctx, BOX.task);
    const owned = await this.#selfOwnedBoxIds(ctx);
    const visible = this.#visible(ctx);
    const row = await this.db.get(
      `SELECT t.* FROM sample_task t WHERE t.id=?${visible.sql ? ` AND ${visible.sql}` : ""}`,
      [ctx.params.id, ...visible.params]
    );
    if (!row)
      throw Object.assign(new Error("任务不存在或不在你的管理范围内"), {
        httpStatus: 404,
        publicCode: "A0404",
      });
    const task = await this.#taskView(ctx, row);
    const logs = await this.db.all(
      "SELECT * FROM sample_task_log WHERE task_id=? ORDER BY created_at, id",
      [row.id]
    );
    // detail 只解析一次：距离快照按位置权限遮挡；签收交接结果（R-5）不含位置，单独暴露
    const logDetails = logs.map((log) => {
      try {
        return log.detail ? JSON.parse(log.detail) : null;
      } catch {
        return null;
      }
    });
    // 最近一次签收交接：存在签收流转记录的 detail.handOver 里，倒序找第一条
    let handOver = null;
    for (let i = logs.length - 1; i >= 0 && !handOver; i -= 1) {
      const info = logDetails[i]?.handOver;
      if (info)
        handOver = {
          movedCount: info.movedCount ?? null,
          skippedCount: info.skippedCount ?? (info.skipped || []).length,
          skipped: info.skipped || [],
          at: logs[i].created_at,
          by: logs[i].actor_name || "",
        };
    }
    const target = targetOf(task, row.status);
    const withPosition = ctx.access.perms.has(BOX.location);
    const counts = await openCounts(this.db, row.id);
    // 开箱超限的箱子样品作废：强制签收后也不能开始检测
    const voided = new Set(overOpenLimit(task, counts));
    const afterSeal = await sealOpenCounts(this.db, row.id);
    const perms0 = ctx.access.perms;
    // 工况按字段给：电量、充电、箱盖、信号各要各的权限；一项都没有时 status 为空
    const statusOf = (state) => {
      if (!state) return null;
      const out = { alert: state.alert };
      let any = false;
      if (perms0.has(BOX.power)) {
        out.battery = state.battery;
        out.batteryUsable = state.batteryUsable ?? null;
        any = true;
      }
      if (perms0.has(BOX.charging)) {
        out.charge = state.charge;
        any = true;
      }
      if (perms0.has(BOX.lid)) {
        out.lid = state.lid;
        any = true;
      }
      if (perms0.has(BOX.signal)) {
        out.csq = state.csq;
        any = true;
      }
      return any ? out : null;
    };
    const inspected = new Map(
      (
        await this.db.all(
          "SELECT box_id, inspected_at, inspected_by FROM sample_task_box WHERE task_id=?",
          [row.id]
        )
      ).map((r) => [r.box_id, r])
    );
    const boxes = [];
    // R13：到达半径与电量显示按寄出分公司公司层（箱子在检测站期间同口径，拍板④）；R22 派生单按采样单位
    const radius = await taskRadiusOf(this.db, task, target);
    const { batteryReserve } = await companyJudgmentFor(this.db, companyOrgOfTask(task));
    for (const box of await boxDistances(this.db, task.boxIds || [], target, {
      withPosition,
      radius,
    })) {
      const boxState = box.missing ? null : await this.boxes.findById(box.id);
      const state = boxState
        ? withCompanyBattery(boxState.toJSON(), boxState, batteryReserve)
        : null;
      boxes.push({
        ...box,
        opensDuring: counts.get(box.id) ?? null,
        opensAfterSeal: afterSeal.get(box.id) ?? null,
        voided: voided.has(box.id),
        owner: state?.owner || "",
        inspectedAt: inspected.get(box.id)?.inspected_at || "",
        inspectedBy: inspected.get(box.id)?.inspected_by || "",
        // 电量、箱盖要有状态权限，地址要有位置权限
        status: statusOf(state),
        address:
          state && withPosition
            ? (box.position?.source === "GPS" ? state.gpsAddress : state.lbsAddress) || ""
            : "",
        // 位置是什么时候的，页面显示「几分钟前」；用了基站时 gpsAt 是最后一次 GPS 定位时间
        gpsAt: state && withPosition ? state.gpsInfo?.at || "" : "",
        positionAt: withPosition ? box.position?.at || "" : "",
      });
    }
    // 轨迹和开关箱事件按任务窗口取；没有位置权限只给事件不给坐标
    const window = taskWindow(row.created_at, row.status, logs, new Date(), task);
    await this.boxes.flush?.();
    const track = await taskTrack(this.db, task.boxIds || [], window, {
      places: await taskPlaces(task, this.db),
    });
    const perms = ctx.access.perms;
    ctx.ok({
      task,
      target,
      boxes,
      tracks: withPosition ? track.tracks : [],
      // 开关箱、上电、充电各要各的记录权限
      events: filterEvents(track.events, perms),
      window,
      // 开箱录像：分公司采样现场开箱时向视频平台请求的录像，按开箱时间排（检测站不设录像）
      videos: perms.has(T.video) && this.videos ? await this.videos.list(row.id) : [],
      // 监控通道（1–8 路）：采样任务取采样单位（分公司）的、旧调拨取接收单位的；检测站无通道
      cameras: perms.has(T.camera) ? await this.#cameras(task) : [],
      allow: {
        log: perms.has(T.log) || perms.has(BOX.log),
        raw: perms.has(BOX.raw),
        video: perms.has(T.video),
        camera: perms.has(T.camera),
        retry: perms.has(T.videoRetry),
        policy: perms.has(P.read),
      },
      arriveRadiusM: radius,
      ...(await this.#receiveDetail(ctx, task, row, owned)),
      // 最近一次签收交接的跳过明细（R-5）：页面据此显示「N 台箱子未随单交接」警示
      handOver,
      logs: logs.map((log, index) => ({
        status: log.status,
        action: log.action,
        by: log.actor_name || "",
        note: log.note || "",
        time: log.created_at,
        detail: logDetails[index] && withPosition ? logDetails[index] : null,
      })),
    });
  }

  /** 详情里的 can；在等这个人收货时换成核验后的结果，并带上 check。owned 透传（#69）。 */
  async #receiveDetail(ctx, task, row, owned = null) {
    const plain = this.#receiveCan(ctx, task, row.status, null, owned);
    if (this.#receiveMode(task, plain) === "none")
      return { can: this.#abilities(ctx, task, row.status, owned), check: null };
    const check = await receiveCheck(this.db, this.boxes, task, row.id, row.status, {
      perms: ctx.access.perms,
    });
    return { can: this.#receiveCan(ctx, task, row.status, check, owned), check };
  }

  /**
   * #69：一次查齐本人保管箱 id 集（scope.ownerIds），供采样段参与方门的本人分支同步判定。
   * 显式传参给 #abilities/#receiveCan/#receiveDetail，不挂 ctx——同一 actor 对象跨调用复用
   * （单测/内部调用）时避免 stale 缓存。全范围（scope.all，含 DUTY）或无 ownerIds 返回 null＝不放宽。
   * 仅 scope4 类（有 ownerIds）请求多这一条按保管人的查询，与箱子列表 scopeSql 同族口径。
   */
  async #selfOwnedBoxIds(ctx) {
    const scope = ctx.access?.scope;
    if (!scope || scope.all || !scope.ownerIds?.length) return null;
    const ids = scope.ownerIds.map(String).filter(Boolean);
    if (!ids.length) return null;
    const rows = await this.db.all(
      `SELECT id FROM sample_box WHERE owner_id IN (${ids.map(() => "?").join(",")})`,
      ids
    );
    return new Set(rows.map((row) => String(row.id)));
  }

  /**
   * 划拨三态动作门（R25，任务 #71）：按态×角色下发 accept/cancel/reject/tracking/retransfer。
   * 待接受：接受/拒收归目标方（manageOrgIds 参与方门＋accept/reject 码）；取消/补单号归创建方
   * （创建人本人或系统管理员，身份门不另设码）。已完成（含历史已划拨别名）：重新划拨（持建单码＋有箱）。
   * 已取消/已拒收/已撤销：终态只读，全 false。动作键不与状态名冲突——#receiveMode 不会把划拨误判成签收。
   */
  #transferAbilities(ctx, task, status, boxCount = null) {
    const has = (perm) => ctx.access.perms.has(perm);
    const view = has(BOX.task);
    const me = String(ctx.user?.id ?? "");
    const creator = Boolean(task.createdById) && String(task.createdById) === me;
    const creatorOrAdmin = creator || isAdminRole(ctx);
    const target = inPartyScope(ctx, task.toOrgId);
    const pending = status === "待接受";
    const endedOk = status === "已完成" || status === "已划拨";
    const count = boxCount ?? (task.boxIds || []).length;
    return {
      accept: pending && view && has(T.transferAccept) && target,
      reject: pending && view && has(T.reject) && target,
      cancel: pending && creatorOrAdmin,
      tracking: pending && creatorOrAdmin,
      retransfer: endedOk && count > 0 && has(T.createTransfer),
    };
  }

  /**
   * 调拨单页读门（R25）：新建划拨 或 接受划拨 任一码即可见（接受方可能只持 accept 码）。
   * 与前端 local-menus TRANSFER_VIEW_PERMS、menus.js 预览镜像同口径；candidate-boxes 仍 create-only。
   */
  #requireTransferView(ctx) {
    const perms = ctx.access?.perms;
    if (!perms?.has(T.createTransfer) && !perms?.has(T.transferAccept))
      throw noPermission("没有这项操作权限");
  }

  /**
   * 谁能推进哪一步。调拨单：寄出、取消归寄出单位；确认到达寄出、接收方都可以；签收、拒收只归接收单位。
   * 接收方只需能看任务（device:box:task），不需要上报策略权限。
   * 指定了签收人（系统用户）时只有他能正常签收；接收单位里其他有签收权限的人只能「强制签收」，要写原因。
   * owned＝#selfOwnedBoxIds 查得的本人保管箱集（#69）：仅采样段（采样中/已封箱）认本人保管，
   * 默认 null＝不放宽（fail-closed），他角色步一律不读它。
   */
  #abilities(ctx, task, status, owned = null) {
    // R25 划拨三态：专用动作门（accept/cancel/reject/tracking/retransfer），不走通用 nextOf。
    if (task.kind === "划拨") return this.#transferAbilities(ctx, task, status);
    const has = (perm) => ctx.access.perms.has(perm);
    const view = has(BOX.task);
    const next = nextOf(task, status);
    const signTo = signTargetOf(task);
    const may = (perm, party) => Boolean(view && has(perm) && party);
    // R23 仅本地采样单：采样段归采样单位（＝箱归属），无寄送/检测站步；已封箱终态。
    if (isLocalSample(task)) {
      // R-b：参与方门走管理范围（manageOrgIds/ADMIN），全部范围的非 ADMIN 角色不能推进他单位采样步
      const unit = inPartyScope(ctx, task.orgId || task.fromOrgId);
      // #69 窄放宽：采样段（采样中/已封箱）另认本人保管；取消仍走严格参与方门（不放宽）
      const sampling = unit || selfCustodyHit(owned, task);
      const STEP = { 采样中: T.sampleStart, 已封箱: T.seal };
      return Object.fromEntries(
        next.map((to) => {
          if (to === "已取消") return [to, may(T.cancel, unit)];
          if (STEP[to]) return [to, may(STEP[to], sampling)];
          return [to, false];
        })
      );
    }
    // 合并采样单（采样后送检＋旧合并别名）与送检共用物流段权限：采样段归采样单位（送检无采样段），
    // 签收/拒收/开始检测归检测站，退回由检测站发起、寄出方接收。
    const merged = isMergedSample(task) || task.kind === "送检";
    if (merged) {
      // 合并采样单（P6）：采样段归寄出分公司；签收/拒收/开始检测归检测站；
      // 退回由检测站发起（待检测/已检测），寄出方接收退回（R22 双向＝检测站自己）。
      // R-b：参与方门走管理范围（manageOrgIds/ADMIN）——数据范围=全部≠参与方，
      // 检测站值守（DUTY 全部范围）不能推进他单位的采样段/检测段（写探针证实越权后收紧）。
      const sender = inPartyScope(ctx, task.fromOrgId);
      const receiver = inPartyScope(ctx, task.toOrgId);
      const signer = isSigner(ctx, task);
      const sampler = task.orgId ? inPartyScope(ctx, task.orgId) : sender;
      // #69 窄放宽：仅采样段（采样中/已封箱）另认本人保管；寄送段（在途 sendBack 等）不放宽
      const custody = selfCustodyHit(owned, task);
      const STEP = { 采样中: T.sampleStart, 已封箱: T.seal, 在途: T.sendBack };
      const can = Object.fromEntries(
        next.map((to) => {
          if (to === "已取消") return [to, may(T.cancel, sender)];
          if (to === "待签收") return [to, may(T.arrive, sender || receiver)];
          // R22 双向首腿：检测站寄出——task:send 或 task:sign 任一（检测站侧 DUTY/VERIFY 持 sign
          // 的 045 拆分码集、无 send；DISPATCH 持 policyTask→send。双码门避免主责角色被挡，057 教训）。
          if (to === "运送中") return [to, may(T.send, sender) || may(T.sign, sender)];
          // 分公司确认到达（＝首腿签收）：归属随交接检测站→采样单位
          if (to === "待采样") return [to, may(T.arrive, sampler)];
          // 采样段：参与方（采样单位/寄出方）或本人保管（#69）；寄送段在途仍仅参与方
          if (to === "采样中" || to === "已封箱")
            return [to, may(STEP[to], sampler || sender || custody)];
          if (STEP[to]) return [to, may(STEP[to], sampler || sender)];
          if (to === signTo) return [to, may(T.sign, task.signerId ? signer : receiver)];
          if (to === "已拒收") return [to, may(T.reject, signer || receiver)];
          if (to === "退回中") return [to, may(T.rejectReturn, signer || receiver)];
          if (to === "已退回") return [to, may(T.acceptReturn, sender)];
          if (to === "已检测") return [to, may(T.inspect, receiver)];
          // R28 双向寄回腿（tripMode=return）：待寄回/寄回在途/待归还的动作门＝检测站（接收方）。
          // 发起寄回/确认寄回双码门 send‖sign（沿 R22 首腿先例：DUTY/VERIFY 持 sign 无 send）；
          // 确认到达（待归还）arrive‖sign 同理。签收归还（已归还）门＝寄出分公司（fromOrg）。
          if (to === "待寄回" || to === "寄回在途")
            return [to, may(T.send, receiver) || may(T.sign, receiver)];
          if (to === "待归还") return [to, may(T.arrive, receiver) || may(T.sign, receiver)];
          if (to === "已归还") return [to, may(T.sign, sender) || may(T.acceptReturn, sender)];
          return [to, false];
        })
      );
      // 指定了签收人：检测站里不是签收人的人只能强制签收
      if (task.signerId && next.includes(signTo))
        can[FORCE_SIGN] = !signer && may(T.forceSign, receiver);
      return can;
    }
    // 旧调拨/送检/采样单（只读兼容）：寄出、取消归寄出单位；确认到达寄出、接收方都可以；签收、拒收只归接收单位。
    const transfer = task.kind === "调拨" && task.toOrgId;
    const sender = transfer ? inScope(ctx, task.fromOrgId) : true;
    const receiver = transfer ? inScope(ctx, task.toOrgId) : false;
    const signer = transfer && isSigner(ctx, task);
    const sampler = task.orgId ? inScope(ctx, task.orgId) : true;
    const home = task.kind === "采样" && task.trip ? inScope(ctx, task.fromOrgId) : true;
    // 采样单、通用任务每一步要的权限和参与方
    const STEP = {
      运送中: [T.send, home],
      待采样: [T.arrive, sampler || home],
      采样中: [T.sampleStart, sampler || home],
      已封箱: [T.seal, sampler || home],
      已完成: [T.finish, sampler || home],
      在途: [T.sendBack, sampler || home],
      待核验: [T.arrive, home],
      执行中: [T.sampleStart, sampler],
    };
    const can = Object.fromEntries(
      next.map((to) => {
        if (to === "已取消") return [to, may(T.cancel, transfer ? sender : true)];
        if (transfer) {
          if (to === "运送中") return [to, may(T.send, sender)];
          if (to === "待签收") return [to, may(T.arrive, sender || receiver)];
          if (to === signTo) return [to, may(T.sign, task.signerId ? signer : receiver)];
          if (to === "已拒收") return [to, may(T.reject, signer || receiver)];
          if (to === "退回中") return [to, may(T.rejectReturn, signer || receiver)];
          if (to === "已退回") return [to, may(T.acceptReturn, sender)];
          if (to === "已检测") return [to, may(T.inspect, receiver)];
          return [to, false];
        }
        if (to === signTo) return [to, may(T.sign, home)];
        if (to === "已拒收") return [to, may(T.reject, home)];
        if (to === "已检测") return [to, may(T.inspect, home)];
        const step = STEP[to];
        return [to, step ? may(step[0], step[1]) : false];
      })
    );
    // 指定了签收人：接收单位里不是签收人的人只能强制签收
    if (transfer && task.signerId && next.includes(signTo))
      can[FORCE_SIGN] = !signer && may(T.forceSign, receiver);
    return can;
  }

  /**
   * 收货时能做什么：在 #abilities 的基础上，
   * - 调拨运送中：收货方扫码可以直接签收、拒收（推进时先自动记一笔「确认到达」）；
   * - 签收核验有问题（check.problems）：不能直接签收，只能拒收或强制签收（要写原因）。
   * owned 透传 #abilities（#69 采样段本人保管）；收货追加的签收/拒收动作不读它（不放宽）。
   */
  #receiveCan(ctx, task, status, check, owned = null) {
    const can = { ...this.#abilities(ctx, task, status, owned) };
    const signTo = signTargetOf(task);
    if (task.kind === "调拨" && status === "运送中") {
      const at = this.#abilities(ctx, task, "待签收", owned);
      for (const to of [signTo, "已拒收", "退回中", FORCE_SIGN]) if (at[to]) can[to] = true;
    }
    // 送检：检测站在「运送中」扫箱码可直接签收/拒收（推进时先自动记一笔「确认到达」）
    if (task.kind === "送检" && status === "运送中") {
      const at = this.#abilities(ctx, task, "待签收", owned);
      for (const to of [signTo, "已拒收", "退回中", FORCE_SIGN]) if (at[to]) can[to] = true;
    }
    // 合并采样单：检测站在「在途」扫箱码可直接签收/拒收（推进时先自动记一笔「确认到达」）
    if (isMergedSample(task) && status === "在途") {
      const at = this.#abilities(ctx, task, "待签收", owned);
      for (const to of [signTo, "已拒收", FORCE_SIGN]) if (at[to]) can[to] = true;
    }
    if (check?.problems?.length && can[signTo]) {
      can[signTo] = false;
      can[FORCE_SIGN] = ctx.access.perms.has(T.forceSign);
    }
    return can;
  }

  /** 收货方式：sign 签收核验（签收、强制签收、拒收）、return 寄出方接收退回，none 没有要做的。 */
  #receiveMode(task, can) {
    if (can["已退回"]) return "return";
    const signTo = signTargetOf(task);
    return [signTo, FORCE_SIGN, "已拒收", "退回中"].some((to) => can[to]) ? "sign" : "none";
  }

  /**
   * 签收核验页（GET /tasks/:id/receive?boxId=）：小程序扫箱码后弹出、网页签收对话框用。
   * 给每台箱子的状态、本次开箱次数、离收货点多远，问题列表，以及现在能做的签收动作。
   */
  async receive(ctx) {
    this.require(ctx, BOX.task);
    const owned = await this.#selfOwnedBoxIds(ctx);
    const row = await this.#visibleTask(ctx);
    const task = JSON.parse(row.body);
    const check = await receiveCheck(this.db, this.boxes, task, row.id, row.status, {
      perms: ctx.access.perms,
    });
    const can = this.#receiveCan(ctx, task, row.status, check, owned);
    ctx.ok({
      task: {
        id: row.id,
        name: task.name,
        kind: task.kind,
        // R25（E additive）：三态类型显示名，mp #77 消费；不改既有字段
        displayKind: isLocalSample({ ...task, kind: row.kind })
          ? "采样"
          : isMergedSample({ ...task, kind: row.kind })
            ? "采样后送检"
            : row.kind,
        status: row.status,
        steps: stepsOf({ ...task, status: row.status }),
        from: task.fromOrg || "",
        to:
          task.kind === "调拨" || task.kind === "送检" || isMergedSample(task)
            ? task.toOrg || ""
            : task.org || "",
        sender: task.sender || "",
        signer: task.signer || "",
        inspect: Boolean(task.inspect),
        boxes: (task.boxIds || []).length,
      },
      mode: this.#receiveMode(task, can),
      signTo: signTargetOf(task),
      boxId: String(ctx.query.boxId || ""),
      check,
      can,
    });
  }

  /**
   * 工作台的任务待办：我现在能推进的任务按下一步分组，加上开箱超限和我经手的任务。
   * 只看进行中的、最多 500 张；每组给数量和前 5 张。
   */
  async todo(ctx) {
    if (!ctx.access.perms.has(BOX.task)) return null;
    // #69：本人保管箱集——sampling 待办桶与 mine 同谓词，门放宽即随 #abilities 生效
    const owned = await this.#selfOwnedBoxIds(ctx);
    const visible = this.#visible(ctx);
    const rows = await this.db.all(
      `SELECT t.* FROM sample_task t WHERE ${activeTaskSql()}${visible.sql ? ` AND ${visible.sql}` : ""} ORDER BY created_at DESC LIMIT 500`,
      visible.params
    );
    // todo：我现在能推进的任务（去重），工作台标题、顶栏铃铛、任务单「待我处理」都用这个数
    const groups = {
      todo: [],
      send: [],
      arrive: [],
      sign: [],
      returning: [],
      sampling: [],
      inspect: [],
      overLimit: [],
      mine: [],
      moving: [],
      // R25 划拨三态：接收方待接受（接受/拒收）＋创建方可取消视角（mp #77 消费；web 工作台冻结面不读）
      transferAccept: [],
      transferCancel: [],
    };
    const me = String(ctx.user?.id || ""),
      myName = ctx.user?.nickname || "";
    for (const row of rows) {
      const task = JSON.parse(row.body);
      const can = this.#abilities(ctx, task, row.status, owned);
      const brief = {
        id: row.id,
        name: task.name,
        kind: task.kind,
        displayKind: isLocalSample(task) ? "采样" : isMergedSample(task) ? "采样后送检" : task.kind,
        status: row.status,
        createdAt: row.created_at,
        from: task.fromOrg || "",
        to:
          task.kind === "调拨" || task.kind === "送检" || isMergedSample(task)
            ? task.toOrg || ""
            : task.org || "",
        boxes: (task.boxIds || []).length,
      };
      if (actionable(can)) groups.todo.push(brief);
      // 分桶谓词与 tasks()?bucket= 共用 bucketsOf（D1/R22 批2：卡片数字==点击落地行数）
      const openOver = Number.isInteger(task.maxOpens)
        ? overOpenLimit(task, await openCounts(this.db, row.id)).length
        : 0;
      for (const key of bucketsOf(task, row.status, can, openOver)) groups[key].push(brief);
      if (["运送中", "在途", "寄回在途"].includes(row.status)) groups.moving.push(brief);
      if (
        (me && (task.senderId === me || task.signerId === me)) ||
        (myName && String(task.people || "").includes(myName))
      )
        groups.mine.push(brief);
    }
    return Object.fromEntries(
      Object.entries(groups).map(([key, list]) => [
        key,
        { total: list.length, list: list.slice(0, 5) },
      ])
    );
  }

  /**
   * 工作台指标口径：可见的进行中任务绑定的箱子（历史快照，与 todo 同一批任务）。
   * 箱子后来改挂单位/保管人时，任务待办还在、箱子指标不能掉成 0。
   */
  async activeBoxIds(ctx) {
    if (!ctx.access.perms.has(BOX.task)) return [];
    const visible = this.#visible(ctx);
    const rows = await this.db.all(
      `SELECT DISTINCT m.box_id FROM sample_task t JOIN sample_task_box m ON m.task_id = t.id
       WHERE ${activeTaskSql()}${visible.sql ? ` AND ${visible.sql}` : ""} LIMIT 2000`,
      visible.params
    );
    return rows.map((row) => String(row.box_id));
  }

  /**
   * 扫箱码（小程序扫箱子上的二维码进来）。箱子在自己范围内：给状态（按权限遮挡），能建任务时 canCreate=true；
   * 不在范围内（比如调拨单的接收方）：只给名称，但和自己相关的任务照样列出、能签收。
   */
  async scan(ctx) {
    const perms = ctx.access.perms;
    const key = String(ctx.params.id || "").slice(0, 64);
    const box = (await this.boxes.findById(key)) || (await this.boxes.findByName(key));
    if (!box)
      throw Object.assign(new Error("没有这台采样箱，请确认二维码"), {
        httpStatus: 404,
        publicCode: "A0404",
      });
    const visible = canSee(ctx.access, box) && (perms.has(BOX.detail) || perms.has(BOX.list));
    let tasks = [];
    if (perms.has(BOX.task)) {
      const owned = await this.#selfOwnedBoxIds(ctx);
      const scope = this.#visible(ctx);
      const rows = await this.db.all(
        `SELECT t.*, m.inspected_at AS box_inspected_at, m.opens_start AS box_opens_start, m.opens_end AS box_opens_end FROM sample_task t JOIN sample_task_box m ON m.task_id=t.id WHERE m.box_id=?${scope.sql ? ` AND ${scope.sql}` : ""} ORDER BY t.created_at DESC LIMIT 10`,
        [box.id, ...scope.params]
      );
      const opensNow = Number(box.toJSON().opens ?? 0);
      tasks = rows.map((row) => {
        const task = JSON.parse(row.body);
        // 检测站已开始检测的箱子：这张单对它来说已经结束；R23 本地采样已封箱也是终态。
        // R28 双向寄回单例外：已检测后还要寄回分公司（占用保持到已归还），扫码仍可推进寄回腿
        const active =
          !isEndedFor({ ...task, kind: row.kind, status: row.status }) &&
          (!row.box_inspected_at || tripModeOf({ ...task, kind: row.kind }) === "return");
        const can = active ? this.#abilities(ctx, task, row.status, owned) : {};
        // 待检测时扫到的这台箱子：能逐台开始检测；整张单的「全部开始检测」留在任务详情里
        if (active && row.status === "待检测") {
          can["开始检测"] = Boolean(can["已检测"]);
          delete can["已检测"];
        }
        // 这张单在等这个人收货：小程序扫码后直接弹出签收核验页
        const receive = active
          ? this.#receiveMode(task, this.#receiveCan(ctx, task, row.status, null, owned))
          : "none";
        // 本次任务开了几次箱：签收前看当前，签收后定在签收那一刻
        const opensDuring =
          row.box_opens_start == null
            ? null
            : Math.max(0, Number(row.box_opens_end ?? opensNow) - Number(row.box_opens_start));
        return {
          id: row.id,
          name: task.name,
          kind: task.kind,
          // R25（E additive）：三态类型显示名，mp #77 消费；不改既有字段
          displayKind: isLocalSample({ ...task, kind: row.kind })
            ? "采样"
            : isMergedSample({ ...task, kind: row.kind })
              ? "采样后送检"
              : row.kind,
          status: row.status,
          createdAt: row.created_at,
          active,
          from: task.fromOrg || "",
          to:
            task.kind === "调拨" || task.kind === "送检" || isMergedSample(task)
              ? task.toOrg || ""
              : task.org || "",
          sender: task.sender || "",
          signer: task.signer || "",
          boxes: (task.boxIds || []).length,
          inspect: Boolean(task.inspect),
          inspectedAt: row.box_inspected_at || "",
          opensDuring,
          maxOpens: Number.isInteger(task.maxOpens) ? task.maxOpens : null,
          receive,
          can,
        };
      });
    }
    if (!visible && !tasks.length)
      throw Object.assign(new Error("这台采样箱不在你的管理范围内"), {
        httpStatus: 403,
        publicCode: "A0301",
      });
    const json = withCompanyBattery(
      box.toJSON(),
      box,
      boxReserve(box, await companyLimits(this.db, limits()))
    );
    // 范围外、只在任务单上见过的箱子：给得越少越好，IMEI 同样按「设备标识」权限打码
    const hidden = {
      id: box.id,
      // 名称为空时 toJSON 是编号回显，编号就是整串 IMEI（M-1）：这一份不走 maskBox，自己遮一次
      name: boxNameCell(json, perms),
      life: json.life,
      masked: ["status", "location", "identity"],
      imei: identityGranted(perms) ? json.imei || box.id : maskImei(json.imei || box.id),
    };
    if (!identityGranted(perms)) hidden.masked = [...hidden.masked, "imei"];
    ctx.ok({
      box: visible ? maskBox(json, perms) : hidden,
      visible,
      tasks,
      canCreate:
        visible &&
        (perms.has(T.createTransfer) || perms.has(T.createSample)) &&
        box.life === "未使用" &&
        !tasks.some((task) => task.active),
    });
  }

  /** 最近的任务流转，工作台动态用。 */
  async recentLogs(ctx, limit = 20) {
    if (!ctx.access.perms.has(BOX.task)) return [];
    const visible = this.#visible(ctx);
    const rows = await this.db.all(
      `SELECT l.task_id, l.status, l.action, l.actor_name, l.note, l.created_at, t.name, t.kind FROM sample_task_log l JOIN sample_task t ON t.id = l.task_id
       ${visible.sql ? `WHERE ${visible.sql}` : ""} ORDER BY l.created_at DESC LIMIT ${Math.min(50, limit)}`,
      visible.params
    );
    return rows.map((row) => ({
      type: "task",
      taskId: row.task_id,
      taskName: row.name,
      kind: row.kind,
      status: row.status,
      action: row.action,
      by: row.actor_name || "",
      note: row.note || "",
      time: row.created_at,
    }));
  }

  /**
   * 任务轨迹：任务期间（创建到结束，没结束到现在）一台或全部箱子的位置和事件，不受 31 天限制。
   * 采样箱详情「轨迹」按任务看时用，只要能看这个任务和「当前位置」，不需要「历史轨迹」。
   * boxId 必须是这个任务里的箱子。
   */
  async taskTrack(ctx) {
    this.require(ctx, BOX.task);
    this.require(ctx, BOX.location);
    const row = await this.#visibleTask(ctx);
    const task = JSON.parse(row.body);
    const all = task.boxIds || [];
    const boxId = typeof ctx.query.boxId === "string" ? ctx.query.boxId : "";
    if (boxId && !all.includes(boxId))
      throw Object.assign(new Error("这台箱子不在这个任务里"), {
        httpStatus: 404,
        publicCode: "A0404",
      });
    const logs = await this.db.all(
      "SELECT status, created_at FROM sample_task_log WHERE task_id=? ORDER BY created_at, id",
      [row.id]
    );
    const window = taskWindow(row.created_at, row.status, logs, new Date(), task);
    await this.boxes.flush?.();
    const places = await taskPlaces(task, this.db);
    const track = await taskTrack(this.db, boxId ? [boxId] : all, window, { places });
    ctx.ok({
      task: {
        id: row.id,
        name: task.name || row.name || "",
        kind: row.kind,
        status: row.status,
        createdAt: row.created_at,
      },
      window,
      places,
      tracks: track.tracks,
      events: filterEvents(track.events, ctx.access.perms),
      truncated: track.truncated,
    });
  }

  /** 任务期间所有箱子的上报记录，按时间倒序翻页。范围固定在任务窗口内，不受 31 天限制。 */
  async taskLogs(ctx) {
    this.require(ctx, BOX.task);
    if (!ctx.access.perms.has(T.log) && !ctx.access.perms.has(BOX.log)) this.require(ctx, T.log);
    const row = await this.#visibleTask(ctx);
    const task = JSON.parse(row.body);
    const logs = await this.db.all(
      "SELECT * FROM sample_task_log WHERE task_id=? ORDER BY created_at, id",
      [row.id]
    );
    const window = taskWindow(row.created_at, row.status, logs, new Date(), task);
    const all = task.boxIds || [];
    const boxId =
      typeof ctx.query.boxId === "string" && all.includes(ctx.query.boxId) ? ctx.query.boxId : "";
    if (typeof this.boxes.listLogsMany !== "function")
      return ctx.ok({ list: [], nextCursor: null, window });
    const page = await this.boxes.listLogsMany(boxId ? [boxId] : all, {
      from: window.from,
      to: window.to,
      limit: ctx.query.limit,
      kind: ctx.query.kind,
      cursorTime: ctx.query.cursorTime,
      cursorId: ctx.query.cursorId,
    });
    ctx.ok({
      list: page.list.map((item) => {
        const json = item.toListJSON ? item.toListJSON() : item.toJSON();
        delete json.raw;
        return maskUplink(json, ctx.access.perms);
      }),
      nextCursor: page.nextCursor,
      window,
    });
  }

  /** 开箱录像重试：平台失败或后来才接入时手动再发一次。 */
  async retryVideo(ctx) {
    this.require(ctx, T.videoRetry);
    const row = await this.#visibleTask(ctx);
    if (!this.videos) return ctx.fail("录像服务不可用");
    const result = await this.videos.retry(row.id, ctx.params.videoId);
    if (!result) return ctx.fail("录像记录不存在", "A0404", 404);
    await this.log(ctx, "重试开箱录像请求", row.id);
    ctx.ok(
      { videos: await this.videos.list(row.id) },
      result.status === "失败" ? result.detail : "已重新请求"
    );
  }

  async #cameras(task) {
    // 监控通道（录音⑥）：采样单取采样单位（分公司）的通道；旧调拨取接收单位的；检测站不设摄像头（无通道）
    const orgId = task.kind === "调拨" ? task.toOrgId : task.orgId;
    if (!orgId) return [];
    const row = await this.db
      .get("SELECT cameras FROM sys_dept WHERE id=?", [String(orgId)])
      .catch(() => null);
    return readCameras(row?.cameras).map((camera, index) => ({
      index: index + 1,
      name: camera.name,
      channel: camera.channel || "",
      status: camera.liveUrl ? "在线" : "未接入",
      liveUrl: camera.liveUrl || "",
      playbackUrl: camera.playbackUrl || "",
    }));
  }

  async #visibleTask(ctx) {
    const visible = this.#visible(ctx);
    const row = await this.db.get(
      `SELECT t.* FROM sample_task t WHERE t.id=?${visible.sql ? ` AND ${visible.sql}` : ""}`,
      [ctx.params.id, ...visible.params]
    );
    if (!row) throw notVisible("任务不存在或不在你的管理范围内");
    return row;
  }

  async transition(ctx) {
    this.require(ctx, BOX.task);
    // #69：本人保管箱集——采样段推进门本人分支；签收/检测等他角色步不读它
    const owned = await this.#selfOwnedBoxIds(ctx);
    const asked = ctx.body?.status;
    const force = asked === FORCE_SIGN;
    const note = typeof ctx.body?.note === "string" ? ctx.body.note.slice(0, 1000) : "";
    // 入口先按数据范围取单：裸 SELECT 让范围外账号改一个 :id 就能推进别人的单（L-P0-1）
    const row = await this.#visibleTask(ctx);
    const id = row.id;
    const task = JSON.parse(row.body);
    // 划拨单没有物流步骤（R25）：走专用 accept/cancel/reject/tracking 端点。nextOf 恒空也会拦，这里给明确文案
    if (task.kind === "划拨") throw conflict("划拨单没有物流步骤，请使用划拨专用接口");
    const signTo = signTargetOf(task);
    const status = force ? signTo : asked;
    const ids = (await this.db.all("SELECT box_id FROM sample_task_box WHERE task_id=?", [id])).map(
      (b) => b.box_id
    );
    const transfer = task.kind === "调拨" && task.toOrgId;
    const merged = isMergedSample(task);
    const inspectKind = task.kind === "送检";
    // 合并单与送检都有检测站接收方：签收交接归属、退回回迁寄出方共用同一套
    const stationFlow = merged || inspectKind;
    // R22 双向首腿：分公司确认到达（运送中→待采样），归属检测站→采样单位（同事务交接）
    const outbound =
      merged && task.trip === "双向" && row.status === "运送中" && status === "待采样";
    // 签收、强制签收、拒收：先做签收核验，有问题时不能直接签收
    const receiving = [signTo, FORCE_SIGN, "已拒收", "退回中"].includes(asked);
    const check = receiving
      ? await receiveCheck(this.db, this.boxes, task, row.id, row.status, {
          perms: ctx.access.perms,
        })
      : null;
    const can = receiving
      ? this.#receiveCan(ctx, task, row.status, check, owned)
      : this.#abilities(ctx, task, row.status, owned);
    if (!can[asked]) {
      const problems = check?.problems || [];
      const message =
        status === signTo && !force && problems.length && can[FORCE_SIGN]
          ? `有异常：${problems
              .slice(0, 3)
              .map((p) => `${p.name} ${p.text}`)
              .join("；")}。只能拒收或强制签收`
          : status === signTo && can[FORCE_SIGN]
            ? `只有签收人 ${task.signer} 可以签收，你可以强制签收`
            : (transfer || stationFlow) && [signTo, "已拒收", "已检测"].includes(status)
              ? "只有接收单位（检测站）的人员可以签收、拒收或开始检测"
              : stationFlow && ["待寄回", "寄回在途", "待归还"].includes(status)
                ? "只有检测站的人员可以发起寄回、确认寄回或确认到达"
                : stationFlow && status === "已归还"
                  ? "只有寄出分公司的人员可以签收归还"
                  : "没有这项操作权限";
      throw noPermission(message);
    }
    if (force && !note.trim()) throw badRequest("请填写强制签收的原因");
    if (status === "退回中" && !note.trim()) throw badRequest("请填写退回原因");
    if (!status) throw badRequest("请选择要推进到的状态");
    // 建单时已经要求签收人在接收单位里；这里再认一次，兜住建单后人被调走、以及改造前留下的外来 signerId。
    // 正常签收只拦「以签收人身份」这条路：接收单位里其他人本来就走强制签收，要写原因。
    // 同一次判定交给交接用：外来用户不能因为这张单把自己变成这批箱子的保管人。
    const signerFit =
      (transfer || stationFlow) && status === signTo && task.signerId
        ? await this.#signerFitsReceiver(task)
        : "none";
    if (asked === signTo && isSigner(ctx, task) && signerFit === "foreign")
      throw noPermission("签收人已不属于这张单的接收单位，请由接收单位有签收权限的人强制签收");
    // 接收方看不到寄出方的箱子，签收、到达不再按箱子范围拦
    // 采样单同理：采样单位按任务上的单位放行——单向采样单的箱子可能仍属寄出单位，
    // 采样单位在现场经手箱子，#abilities 也承认它是参与方，不能再用箱子范围拦它的推进（R4）
    const party =
      (isMergedSample(task) || isLocalSample(task)) &&
      (inScope(ctx, task.orgId) || (task.trip && inScope(ctx, task.fromOrgId)));
    // 合并单/送检：检测站签收/拒收/开始检测/发起退回/寄回腿、寄出方接收退回/签收归还时，
    // 箱子可能已挂检测站，按参与方放行
    const mergedReceive =
      stationFlow &&
      ["待签收", "待检测", "已检测", "已拒收", "退回中", "已退回", ...RETURN_LEG_STEPS].includes(
        status
      ) &&
      (inScope(ctx, task.toOrgId) || inScope(ctx, task.fromOrgId) || isSigner(ctx, task));
    if (
      !party &&
      !mergedReceive &&
      !(
        transfer &&
        ["待签收", "已签收", "已拒收", "待检测", "已检测", "退回中", "已退回"].includes(status) &&
        (inScope(ctx, task.toOrgId) || inScope(ctx, task.fromOrgId) || isSigner(ctx, task))
      )
    )
      await this.targets(ctx, ids);
    // 寄出、寄回这两步记的是出发地的距离；拒收并退回记离收货地址多远，接收退回记离寄出地址多远；
    // R28 寄回腿：确认寄回记离检测站（收货地址）多远，签收归还记离寄出分公司多远
    const at =
      {
        运送中: "待寄出",
        在途: "已封箱",
        退回中: "待签收",
        已退回: "退回中",
        寄回在途: "待寄回",
        已归还: "待归还",
      }[status] || status;
    const target = targetOf(task, at);
    const detail =
      target && hasCoords(target)
        ? distanceSnapshot(
            target,
            await boxDistances(this.db, ids, target, {
              radius: await taskRadiusOf(this.db, task, target),
            })
          )
        : null;
    // 运送中（旧调拨/送检）/在途（合并单）直接扫码签收、拒收：先自动记一笔确认到达
    if (
      ((transfer || inspectKind) && row.status === "运送中") ||
      (merged && row.status === "在途")
    ) {
      if ([signTo, "已拒收", "退回中"].includes(status)) {
        await this.policies.transition(id, "待签收", {
          actor: actorOf(ctx),
          note: "扫码收货时自动确认到达",
        });
      }
    }
    // 签收交接（R-5）：归属迁移并入 transition 的同一事务，任一台失败整体回滚，
    // 不再出现「已签收但归属只移了一半」。跳过守卫（已改挂/不在寄出方）语义不变。
    // 退回交接（D3）：合并单/送检「已退回」时归属回迁原寄出分公司，同样同事务、整体回滚。
    // 签收归还交接（R28）：「已归还」时归属回寄出分公司＋保管人清空（可重新分配）。
    const result = await this.policies.transition(id, status, {
      actor: actorOf(ctx),
      note,
      detail,
      action: force ? FORCE_SIGN : undefined,
      handOver: (transfer || stationFlow) && status === signTo ? { signerFit } : null,
      returnHandOver: stationFlow && status === "已退回" ? true : null,
      outboundHandOver: outbound ? true : null,
      handBack: stationFlow && status === "已归还" ? true : null,
    });
    const handOver = result.handOver;
    // 旧字段兼容：handOverSkipped 仍是 [{id, reason}]；新字段 handOver 给全量 moved/skipped
    const handOverSkipped = (handOver?.skipped || []).map(({ boxId, reason }) => ({
      id: boxId,
      reason,
    }));
    await this.log(ctx, force ? "任务单强制签收" : `任务单推进到「${status}」`, id);
    // 跳过的台数进操作日志，每台箱子为什么被跳过进运行日志（提交后才记，回滚不留假日志）
    if (handOverSkipped.length) {
      await this.log(
        ctx,
        `签收交接跳过 ${handOverSkipped.length} 台箱子：建单后已改挂到别的单位，未自动改归属`,
        id
      );
      for (const item of handOver.skipped)
        if (item.where) this.#logHandOverSkip(ctx, id, item.boxId, item.where);
    }
    ctx.ok({
      saved: true,
      handOverSkipped,
      handOver: handOver
        ? {
            moved: handOver.moved,
            skipped: handOver.skipped.map(({ boxId, reason }) => ({ boxId, reason })),
          }
        : null,
    });
  }

  /**
   * 检测站扫一台箱子「开始检测」（POST /tasks/:id/boxes/:boxId/inspect）。
   * 谁能做和整张单「全部开始检测」一样：接收单位（双向单是寄出单位）里有签收权限的人。
   */
  async inspect(ctx) {
    this.require(ctx, BOX.task);
    const owned = await this.#selfOwnedBoxIds(ctx);
    const row = await this.#visibleTask(ctx);
    const task = JSON.parse(row.body);
    if (row.status !== "待检测")
      throw badRequest(
        row.status === "已检测" ? "这张单的箱子都已开始检测" : "签收以后才能开始检测"
      );
    if (!this.#abilities(ctx, task, row.status, owned)["已检测"])
      throw noPermission("只有检测站有签收权限的人员可以开始检测");
    const boxId = String(ctx.params.boxId || "").slice(0, 64);
    // 这台箱子也得在自己的范围内：否则能给范围外的箱子盖「开始检测」
    await this.targets(ctx, [boxId]);
    const result = await this.policies.inspectBox(row.id, boxId, { actor: actorOf(ctx) });
    await this.log(ctx, `采样箱 ${boxId} 开始检测`, row.id);
    ctx.ok(result);
  }

  /**
   * 单上的签收人还挂不在这张单的接收单位（含下级部门）名下。
   * 建单时校验过一次，这里独立再校验：防止建单后人被调到别的单位，
   * 也防止改造前留下的外来 signerId 被用来签收、并把这批箱子的保管人写成自己。
   *
   * 返回三态：
   * - local：确实在接收单位里；
   * - foreign：确实不在，正常签收要拦，交接时也不把他记成保管人；
   * - unknown：判不出（旧单只写了单位名、或账号已删）。unknown 保持改造前的行为，
   *   不因为数据不全就把合法签收拦死；账号已删的人本来就登不进来。
   */
  async #signerFitsReceiver(task) {
    const depts = await this.db.all("SELECT id,parent_id AS parentId,name,sort FROM sys_dept");
    const orgId = resolveOrgId(depts, task.toOrgId, task.toOrg);
    if (!orgId) return "unknown";
    const signer = await this.db.get("SELECT dept_id FROM sys_user WHERE id=?", [
      String(task.signerId),
    ]);
    if (!signer) return "unknown";
    return deptUnder(depts, signer.dept_id, orgId) ? "local" : "foreign";
  }

  /**
   * 跳过的箱子逐台进运行日志：谁在签收哪张单时没带走哪台、它现在在谁名下。
   * 操作日志只在 transition 里按台数记一条汇总，避免一张大单签收刷出几百条审计。
   * R-5 后交接在 ReportPolicy.transition 事务内执行，这里在事务提交后才记，回滚不留假日志。
   */
  #logHandOverSkip(ctx, taskId, boxId, orgName) {
    logSystem({
      source: "task",
      level: "warn",
      kind: "hand-over-skipped",
      message: `任务单 #${taskId} 交接时跳过一台箱子：这台现在挂在${orgName}名下，未自动改归属`,
      deviceId: boxId,
      actorId: ctx.user?.id,
    });
  }
  async log(ctx, action, id) {
    await audit(this.db, {
      orgId: String(ctx.user.dept_id || ""),
      orgName: "",
      actorId: String(ctx.user.id),
      actorName: ctx.user.nickname || ctx.user.username,
      action,
      targetType: "report-policy",
      targetId: id,
      result: "成功",
      ip: ctx.ip || "",
    });
  }
}

/** 签收核验那一步：合并单/调拨叫「待签收」，旧采样寄回叫「待核验」。任务单列表的「待签收」标签都列。 */
const SIGN_STEPS = ["待签收", "待核验"];

/**
 * 划拨状态筛选白名单（R25 三态）：待接受＋四终态＋历史已划拨别名（读兼容）。
 * 伪态（已结束/已撤销·历史）在 transfers() 里展开，不在本表。
 */
const TRANSFER_STATUS_KEYS = ["待接受", "已完成", "已取消", "已拒收", "已撤销", "已划拨"];

/**
 * 状态筛选白名单（批4/R-c）：16 个持久态＋划拨两态＋伪态（进行中/已结束/签收）。
 * 从 shared/taskFlow.js 的流程常量派生（与前端 status.ts 的 STATUS_GROUPS 同一份词汇），
 * 不另抄枚举。非法值忽略该筛选（与 kind/bucket 同口径），不再静默 0 行——
 * 旧书签/分享链接里的陈旧状态值不再落进「没有符合条件的任务」死胡同。
 */
const STATUS_KEYS = [
  ...new Set([
    ...SAMPLE_FLOW,
    ...SAMPLE_OUTBOUND_STEPS,
    ...RETURN_STEPS,
    ...RETURN_LEG_STEPS,
    ...ENDED_OK,
    ...ENDED_VOID,
    "待接受", // R25 划拨三态进行中态（不在全局 ENDED）
    "待核验", // 旧采样核验态（只读兼容，056 映射前的存量行）
    "进行中",
    "已结束",
    "签收",
  ]),
];

/** 伪态的 SQL 谓词；具体态返回 null（走等值/IN）。 */
function statusSqlOf(key) {
  if (key === "进行中") return activeTaskSql();
  if (key === "已结束") return `NOT ${activeTaskSql()}`;
  if (key === "签收") return `t.status IN (${SIGN_STEPS.map((s) => `'${s}'`).join(",")})`;
  return null;
}

/** 伪态在 mine/bucket 内存窗口（只含进行中）上的判定；具体态按状态名匹配。 */
function statusMatchOf(key, status) {
  if (key === "进行中") return true;
  if (key === "已结束") return false;
  if (key === "签收") return SIGN_STEPS.includes(status);
  return status === key;
}

/**
 * 最近更新排序（D4/批5）：sample_task 无 updated_at 列，用流转日志 MAX(created_at) 子查询，
 * 不新增迁移。建单事务内就写「创建」日志（ReportPolicy.addTaskLog），每单至少一条；
 * COALESCE 兜底 022 迁移前的无日志老行。idx_task_log_task(task_id,created_at) 覆盖分组。
 * MySQL 大库 join 计划未在本轮验证（残留风险，见验收报告）。
 */
const LAST_FLOW_JOIN =
  "LEFT JOIN (SELECT task_id, MAX(created_at) AS last_flow_at FROM sample_task_log GROUP BY task_id) f ON f.task_id = t.id";
const flowAtOf = (row) => row.last_flow_at || row.created_at;

/** 有取消以外的动作可做：算「待我处理」。只能取消的（比如管理员看别人的单）不算。 */
function actionable(can) {
  return Object.entries(can).some(([to, ok]) => ok && to !== "已取消");
}

/** 任务单列表支持的桶参数（D1/R22 批2）：与工作台 todo() 同一份谓词，保证「卡片数字==点击落地行数」。
 * R25 增划拨两桶：transferAccept（接收方待接受）/transferCancel（创建方可取消），落地自动 kind=划拨。 */
const BUCKET_KEYS = [
  "sampling",
  "arrive",
  "sign",
  "returning",
  "send",
  "overLimit",
  "transferAccept",
  "transferCancel",
];

/**
 * 工作台分桶谓词（D1/R22 批2）：todo() 与 tasks()?bucket= 共用这一份，避免两处漂移。
 * 返回该任务命中的桶名数组。overLimit 要开箱数（异步），由调用方先算好传入
 * （>0＝命中；null/0＝未算或无超限，不算命中）；其余桶只看 can（与 todo 逐条判定一致）。
 * R25 划拨：transferAccept＝接收方可接受/拒收；transferCancel＝创建方可取消；不参与物流六桶。
 */
function bucketsOf(task, status, can, openOver = null) {
  const buckets = [];
  if (task.kind === "划拨") {
    if (can.accept || can.reject) buckets.push("transferAccept");
    if (can.cancel) buckets.push("transferCancel");
    return buckets;
  }
  if (can["运送中"] || can["寄回在途"]) buckets.push("send");
  if (can["待签收"] || can["待归还"] || (status === "运送中" && can["待采样"]))
    buckets.push("arrive");
  if (can["已签收"] || can["待检测"] || can[FORCE_SIGN] || can["已归还"]) buckets.push("sign");
  if (can["已退回"] || can["待寄回"]) buckets.push("returning");
  if (can["已检测"]) buckets.push("inspect");
  if (
    (isLocalSample(task) || isMergedSample(task)) &&
    ["待采样", "采样中", "已封箱"].includes(status) &&
    Object.entries(can).some(([to, ok]) => ok && to !== "已取消")
  )
    buckets.push("sampling");
  if (openOver) buckets.push("overLimit");
  return buckets;
}

/** 任务要记进出的地点：调拨/送检/合并单看寄出、收货地址，本地采样看计划地点（旧双向单再加寄出地址）。没坐标的跳过。
 * R13：地点没显式半径时用寄出分公司的公司级到达半径（公司未覆盖＝系统默认）。
 * R23：合并单判别走 isMergedSample（采样后送检＋旧合并别名）；送检按物流两方。 */
async function taskPlaces(task, db) {
  const merged = isMergedSample(task);
  const companyRadius = await taskRadiusOf(db, task, null);
  return (
    task.kind === "调拨" || task.kind === "送检"
      ? [
          { ...task.fromPlace, role: "寄出地址" },
          { ...task.toPlace, role: "收货地址" },
        ]
      : [
          { ...task.placeAt, role: "计划地点" },
          ...(task.trip || merged ? [{ ...task.fromPlace, role: "寄出地址" }] : []),
          ...(merged ? [{ ...task.toPlace, role: "收货地址" }] : []),
        ]
  )
    .filter((p) => hasCoords(p))
    .map((p) => ({
      role: p.role,
      lng: p.lng,
      lat: p.lat,
      radiusM: Number.isInteger(p.radiusM) ? p.radiusM : companyRadius,
    }));
}
