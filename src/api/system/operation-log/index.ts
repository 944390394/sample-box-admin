import request from "@/utils/request";

export interface OperationLogQuery {
  from: string;
  to: string;
  limit?: number;
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
    });
  },
};

export default OperationLogAPI;
