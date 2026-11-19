import request from "@/utils/request";

/**
 * 划拨单（批量归属划拨，AL-）接口。提交即生效、无物流；状态只有 已划拨/已撤销。
 * 契约见 reports/plan-transfer-inspect.md §6.1/§6.2/§6.5 与 reports/impl-b1-core.md。
 * 提交/撤销的 409 会把逐台拦截原因放在 error.data 里（silent 调用，由页面渲染弹窗）。
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
  revokedAt?: string;
  revokeReason?: string;
}
/** counts 前三项是单数口径，boxCountTotal 是箱次累计口径（同一箱子出现在多单计多次）。 */
export interface TransferCounts {
  全部: number;
  已划拨: number;
  已撤销: number;
  boxCountTotal: number;
}
export interface TransferListResult {
  list: TransferListItem[];
  total: number;
  counts: TransferCounts;
  kpiHints?: { boxCountTotal?: string };
}
/** 详情/创建响应里的逐台快照。已划拨时带实时撤销守卫结论 revocable/reasonCode。 */
export interface TransferBox {
  boxId: string;
  code: string;
  name: string;
  fromOrgId: string;
  fromOrg: string;
  fromOwnerId: string;
  fromOwner: string;
  life: string;
  revocable: boolean;
  reasonCode?: string;
  reason?: string;
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
  toOrg: TransferOrg;
  from: TransferFrom[];
  boxCount: number;
  boxes: TransferBox[];
  steps: string[];
  revokedAt?: string;
  revokeReason?: string;
  abilities: { revoke: boolean; cancel: boolean };
  logs: TransferLog[];
  /** 创建响应里回吐的备注（body.note）。 */
  note?: string;
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
  clientToken?: string;
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
/** 撤销 409 的 data：整单禁撤 + 逐台 ok/restoreTo 或 reasonCode/reason。 */
export interface RevokeBlocked {
  canRevoke: false;
  banner: string;
  confirmLabel: string;
  totalCount: number;
  blockedCount: number;
  okCount: number;
  boxes: {
    boxId: string;
    code: string;
    name: string;
    ok: boolean;
    restoreTo?: { orgId: string; orgName: string; ownerName: string };
    reasonCode?: string;
    reason?: string;
    opensDelta?: number;
  }[];
}
/** 撤销成功响应。 */
export interface RevokeResult {
  id: string;
  status: string;
  revokedAt: string;
  restoredCount: number;
  restored: {
    boxId: string;
    code: string;
    name: string;
    toOrgId: string;
    toOrg: string;
    ownerId: string;
    owner: string;
  }[];
  log: { action: string; actorName: string; at: string };
}

const base = "/api/v1/sample/transfers";
const enc = encodeURIComponent;

export default {
  list: (params: TransferQuery = {}) => request<unknown, TransferListResult>({ url: base, params }),
  detail: (id: string) => request<unknown, TransferDetail>({ url: `${base}/${enc(id)}` }),
  candidates: (params: CandidateQuery = {}) =>
    request<unknown, CandidateResult>({ url: `${base}/candidate-boxes`, params }),
  /** 提交即生效。silent：409 的逐台 blocked 由向导弹窗渲染，不弹全局 toast。 */
  create: (data: CreateTransferInput) =>
    request<unknown, TransferDetail>({ url: base, method: "post", data, silent: true }),
  /** 撤销。silent：409 的整单禁撤 data 由撤销弹窗渲染。 */
  revoke: (id: string, reason: string) =>
    request<unknown, RevokeResult>({
      url: `${base}/${enc(id)}/revoke`,
      method: "post",
      data: { reason },
      silent: true,
    }),
};
