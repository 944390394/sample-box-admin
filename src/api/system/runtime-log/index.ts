import request from "@/utils/request";
export interface LogItem {
  id: string;
  time: number;
  level: string;
  source: string;
  kind: string;
  message: string;
  duration: number | null;
  path: string;
  method: string;
  status: number | null;
  code: string;
  requestId: string;
  actorId: string;
  deviceId: string;
  release: string;
  stack?: string;
  latestId?: string;
  fingerprint: string;
  firstTime?: number;
  lastTime?: number;
  occurrences?: number;
  maxDuration?: number | null;
  avgDuration?: number | null;
}
export interface LogPage {
  list: LogItem[];
  nextCursor?: { time: number; id: string } | null;
  hasMore?: boolean;
  summary: {
    total: number;
    errors: number;
    slow: number;
    issues: number;
    maxDuration: number | null;
  };
  health: {
    retentionDays: number;
    maxRows: number;
    dropped: number;
    lastFailure: string;
    slowMs: number;
    release: string;
  };
}
export default {
  page: (params: Record<string, unknown>) =>
    request<unknown, LogPage>({ url: "/api/v1/system/runtime-logs", params }),
  detail: (id: string) =>
    request<unknown, LogItem>({ url: `/api/v1/system/runtime-logs/${encodeURIComponent(id)}` }),
};
