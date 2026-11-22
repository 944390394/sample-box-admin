import request from "@/utils/request";

/**
 * 划拨单（批量归属划拨，AL-）接口。R25（#71）三态：创建→待接受→（目标分公司管理员）接受→已完成；
 * 接受前创建方可取消、接收方可拒收（原因必填）；接受后不可撤销，只能重新划拨。归属在接受时转移。
 * 历史两态（R24 前）：已划拨→已完成（064 映射，legacy 标，接受人—不伪造）、已撤销只读保留。
 * 提交的 409 会把逐台拦截原因放在 error.data 里（silent 调用，由页面渲染弹窗）。
 *
 * R24（#70）撤销划拨下线：revoke 路由直接回 410＋「撤销已下线：如需退回或改派请重新划拨」。
 * 提交（create）必填 password：服务端在 clientToken 幂等命中之前校验当前登录账号口令，
 * 缺→400、错→403。口令只走这一次请求体，不进日志、不进审计 detail。
 * R25 新增 trackingNo（快递单号③）：创建选填 ≤64；接受前创建方可补填/修改（tracking）；接受后只读。
 * accept/cancel/reject/tracking 均不加密码（口径⑤仅创建需密码）。
 */

/** 来源公司聚合（跨公司批量时多条，权威来源是建单快照）。 */
export interface TransferFrom {
  orgId: string;
  orgName: string;
  count: number;
}
export interface TransferOrg {
  id: string;
  name: string;
}
/** R25 按态×角色动作门（服务端下发，前端不自造）。 */
export interface TransferAbilities {
  accept: boolean;
  cancel: boolean;
  reject: boolean;
  tracking: boolean;
  retransfer: boolean;
}
/** 列表行。 */
export interface TransferListItem {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  boxCount: number;
  from: TransferFrom[];
  toOrg: TransferOrg;
  by: string;
  byId: string;
  trackingNo: string;
  legacy: boolean;
  abilities: TransferAbilities;
  acceptedAt?: string;
  acceptedBy?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  rejectReason?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  revokedAt?: string;
  revokeReason?: string;
}
/** counts 单数口径（待接受/已完成/已取消/已拒收/已撤销＋已结束伪态合集），boxCountTotal 箱次累计。 */
export interface TransferCounts {
  全部: number;
  待接受: number;
  已完成: number;
  已取消: number;
  已拒收: number;
  已撤销: number;
  已结束: number;
  boxCountTotal: number;
}
export interface TransferListResult {
  list: TransferListItem[];
  total: number;
  counts: TransferCounts;
  kpiHints?: { boxCountTotal?: string };
}
/** 详情/创建响应里的逐台快照。当前归属/保管人随接受转移；电量/位置按权限遮挡（控制器层）。 */
export interface TransferBox {
  boxId: string;
  code: string;
  name: string;
  fromOrgId: string;
  fromOrg: string;
  fromOwnerId: string;
  fromOwner: string;
  life: string;
  orgId: string;
  org: string;
  ownerId: string;
  owner: string;
  batteryMv: number | null;
  batteryUsable: number | null;
  lastReportAt: string;
  gpsLng: number | null;
  gpsLat: number | null;
  gpsAt: string;
  lbsLng: number | null;
  lbsLat: number | null;
  lbsAt: string;
}
export interface TransferLog {
  status: string;
  action: string;
  by: string;
  note: string;
  time: string;
  detail?: unknown;
}
export interface TransferDetail {
  id: string;
  kind: string;
  status: string;
  name: string;
  createdAt: string;
  createdBy: string;
  createdById: string;
  note: string;
  trackingNo: string;
  legacy: boolean;
  toOrg: TransferOrg;
  from: TransferFrom[];
  boxCount: number;
  boxes: TransferBox[];
  steps: string[];
  acceptedAt?: string;
  acceptedBy?: string;
  acceptedById?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  rejectReason?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  cancelNote?: string;
  revokedAt?: string;
  revokeReason?: string;
  abilities: TransferAbilities;
  logs: TransferLog[];
  idempotent?: boolean;
}
/** 向导箱子集（服务端下发，替换预览页 16 台 POOL 副本）。 */
export interface CandidateBox {
  boxId: string;
  code: string;
  name: string;
  orgId: string;
  org: string;
  ownerId: string;
  owner: string;
  life: string;
  lastReportAt: string;
  batteryMv: number | null;
  boundTask: { id: string; name: string; kind: string; status: string; createdAt: string } | null;
  selectable: boolean;
  reasonCode?: string;
  reason?: string;
}
export interface CandidateResult {
  list: CandidateBox[];
  total: number;
  selectableCount: number;
  blockedCount: number;
  page: number;
  pageSize: number;
}
export interface TransferQuery {
  status?: string;
  q?: string;
  orgId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}
export interface CandidateQuery {
  q?: string;
  orgId?: string;
  life?: string;
  toOrgId?: string;
  page?: number;
  pageSize?: number;
}
export interface CreateTransferInput {
  name: string;
  toOrgId: string;
  boxIds: string[];
  note?: string;
  /** R25③ 快递单号选填 ≤64。 */
  trackingNo?: string;
  clientToken?: string;
  /** 当前登录账号口令（R24 二次确认）。必填：服务端先校验它，再谈 clientToken 幂等。 */
  password: string;
}
/** 提交 409 的 data：逐台 blocked。 */
export interface CreateBlocked {
  blocked: {
    boxId: string;
    code: string;
    name: string;
    reasonCode: string;
    reason: string;
    taskName?: string;
    taskStatus?: string;
  }[];
  totalCount: number;
  blockedCount: number;
}
/** R25 接受/取消/拒收/补单号响应。 */
export interface TransferActionResult {
  id: string;
  status: string;
  acceptedAt?: string;
  acceptedBy?: string;
  count?: number;
  toOrg?: TransferOrg;
  cancelledAt?: string;
  cancelledBy?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  rejectReason?: string;
  trackingNo?: string;
}

const base = "/api/v1/sample/transfers";
const enc = encodeURIComponent;

export default {
  list: (params: TransferQuery = {}) => request<unknown, TransferListResult>({ url: base, params }),
  detail: (id: string) => request<unknown, TransferDetail>({ url: `${base}/${enc(id)}` }),
  candidates: (params: CandidateQuery = {}) =>
    request<unknown, CandidateResult>({ url: `${base}/candidate-boxes`, params }),
  /** 创建落待接受。silent：409 的逐台 blocked 由向导弹窗渲染，不弹全局 toast。
   * 400＝没填口令、403＝口令不对，两种都由向导内的红字呈现，不跳登录。 */
  create: (data: CreateTransferInput) =>
    request<unknown, TransferDetail>({ url: base, method: "post", data, silent: true }),
  /** R25① 目标分公司管理员接受（归属接受时转移）。 */
  accept: (id: string) =>
    request<unknown, TransferActionResult>({
      url: `${base}/${enc(id)}/accept`,
      method: "post",
      data: {},
    }),
  /** R25② 创建方取消（箱不动，备注选填）。 */
  cancel: (id: string, note?: string) =>
    request<unknown, TransferActionResult>({
      url: `${base}/${enc(id)}/cancel`,
      method: "post",
      data: { note: note || "" },
    }),
  /** R25② 接收方拒收（原因必填，箱不动）。 */
  reject: (id: string, reason: string) =>
    request<unknown, TransferActionResult>({
      url: `${base}/${enc(id)}/reject`,
      method: "post",
      data: { reason },
    }),
  /** R25③ 创建方补填/修改快递单号（接受前）。 */
  tracking: (id: string, trackingNo: string) =>
    request<unknown, TransferActionResult>({
      url: `${base}/${enc(id)}/tracking`,
      method: "post",
      data: { trackingNo },
    }),
};
