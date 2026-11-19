import request from "@/utils/request";

export interface OperationLogQuery {
  from: string;
  to: string;
  limit?: number;
  /** 组织筛选：仅数据范围内的单位有效，越权由服务端收敛为空 */
  orgId?: string;
  actor?: string;
  targetId?: string;
  cursorTime?: string;
  cursorId?: string;
}

export interface OperationLogItem {
  id: string;
  orgId: string;
  orgName: string;
  actorId: string;
  actorName: string;
  action: string;
  targetType: string;
  targetId: string;
  result: string;
  /** 明细（grant diff/scope 前后等 JSON 文本，055a 起回填） */
  detail: string;
  createdAt: string;
  ip: string;
}

export interface OperationLogCursor {
  time: string;
  id: string;
}

export interface OperationLogPage {
  list: OperationLogItem[];
  nextCursor: OperationLogCursor | null;
}

const OperationLogAPI = {
  page(params: OperationLogQuery) {
    return request<unknown, OperationLogPage>({
      url: "/api/v1/system/operation-logs",
      method: "get",
      params,
      // 错误态由页面按码分流渲染（无权限/网络错误可重试），不弹全局提示
      silent: true,
    });
  },
  /** 按当前筛选导出 CSV（perm sys:oplog:export）；上限 5 万行，截断标记在响应头 */
  export(params: OperationLogQuery) {
    return request<unknown, { data: Blob; headers: Record<string, string> }>({
      url: "/api/v1/system/operation-logs/export",
      method: "get",
      params,
      responseType: "blob",
      silent: true,
    });
  },
};

export default OperationLogAPI;
