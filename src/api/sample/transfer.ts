import request from "@/utils/request";

/**
 * 划拨单（批量归属划拨，AL-）接口。提交即生效、无物流；状态只有 已划拨/已撤销。
 * 契约见 reports/plan-transfer-inspect.md §6.1/§6.2/§6.5 与 reports/impl-b1-core.md。
 * 提交的 409 会把逐台拦截原因放在 error.data 里（silent 调用，由页面渲染弹窗）。
 *
 * R24（#70）撤销划拨下线：revoke 方法与 RevokeBlocked/RevokeResult 类型一起删除，
 * 路由 POST /transfers/:id/revoke 现在直接回 410＋「撤销已下线：如需退回或改派请重新划拨」。
 * 提交（create）新增必填 password：服务端在 clientToken 幂等命中之前校验当前登录账号口令，
 * 缺→400、错→403。口令只走这一次请求体，不进日志、不进审计 detail。
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
  /** R24 撤销下线：服务端不再下发 revoke，只保留历史占位的 cancel。 */
  abilities: { cancel: boolean };
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
// R24（#70）撤销下线：原 RevokeBlocked（撤销 409 的整单禁撤 data）与 RevokeResult（撤销成功响应）
// 两个类型随 revoke 方法一起删除。领域层的整单禁撤四守卫仍在（历史单审计要读），只是接口不再暴露。

const base = "/api/v1/sample/transfers";
const enc = encodeURIComponent;

export default {
  list: (params: TransferQuery = {}) => request<unknown, TransferListResult>({ url: base, params }),
  detail: (id: string) => request<unknown, TransferDetail>({ url: `${base}/${enc(id)}` }),
  candidates: (params: CandidateQuery = {}) =>
    request<unknown, CandidateResult>({ url: `${base}/candidate-boxes`, params }),
  /** 提交即生效。silent：409 的逐台 blocked 由向导弹窗渲染，不弹全局 toast。
   * 400＝没填口令、403＝口令不对，两种都由向导内的红字呈现，不跳登录。 */
  create: (data: CreateTransferInput) =>
    request<unknown, TransferDetail>({ url: base, method: "post", data, silent: true }),
};
