import request from "@/utils/request";
import type { Policy } from "./report-policy";

/**
 * 公司级策略中心（R13，任务 #46）。
 * 公司＝顶级部门（分公司/总部）；每公司两份完整策略（非任务期间 idle / 任务期间 task），
 * NULL＝整层继承系统默认，不逐字段拼接。task 只作新建任务单「本任务统一」初始值＋空策略兜底，
 * 进行中任务按建单快照执行，不受公司级后续修改影响（拍板①）。
 * 判定阈值三列（电量预留/到达半径/离线宽限）null＝继承系统默认，服务端生效不下发（P1）。
 * 写闸门：device:box:policyCompany＋manageOrgIds（只能改本公司）；读闸门：policyRead＋view 范围。
 */
export interface CompanyJudgment {
  /** 电量预留 %（0–80），null＝继承系统默认 */
  batteryReserve: number | null;
  /** 任务到达半径 米（100–50000），null＝继承系统默认 */
  arriveRadiusM: number | null;
  /** 建单后未上线离线宽限 秒（60–86400），null＝继承系统默认 */
  taskOfflineGraceSec: number | null;
}

export interface CompanyPolicy extends CompanyJudgment {
  orgId: string;
  orgName: string;
  /** 非任务期间完整策略；null＝整层继承系统默认 */
  idle: Policy | null;
  /** 任务期间默认完整策略；null＝建单初始值仍用系统默认 */
  task: Policy | null;
  updatedAt: string;
  updatedBy: string;
  /** 系统默认生效值（继承态灰字展示用，只读） */
  system: {
    reportPeriodSec: number;
    reportOnlyWhenCharging: boolean;
    batteryReserve: number;
    arriveRadiusM: number;
    taskOfflineGraceSec: number;
  };
  /** 当前账号能不能改本公司（码＋manageOrgIds 闸门，服务端权威） */
  can: {
    write: boolean;
    /** R21（062）：判定阈值三列单独可写（policyCompanyJudge 码＋同一 manage 闸门）；老服务端无此键 */
    judge?: boolean;
  };
  /** 生效公司＝本公司的箱子台数（含检测站里由本公司寄出的箱子） */
  boxCount: number;
}

export interface CompanyPolicyInput extends CompanyJudgment {
  idle: Policy | null;
  task: Policy | null;
}

export interface CompanyPolicySaved extends CompanyPolicy {
  /** 本次保存触发策略刷新的箱子台数 */
  affectedBoxCount: number;
}

const url = (orgId: string) => `/api/v1/depts/${encodeURIComponent(orgId)}/policy`;

const CompanyPolicyAPI = {
  /** 读公司策略（policyRead＋view 范围；silent 供页面按码降级只读/隐藏）。 */
  get(orgId: string, opts?: { silent?: boolean }) {
    return request<unknown, CompanyPolicy>({ url: url(orgId), method: "get", ...opts });
  },
  /** 保存公司策略（policyCompany＋manageOrgIds 闸门；保存后服务端刷新公司箱子并沿既有通道下发）。 */
  save(orgId: string, data: CompanyPolicyInput) {
    return request<unknown, CompanyPolicySaved>({ url: url(orgId), method: "put", data });
  },
};

export default CompanyPolicyAPI;
