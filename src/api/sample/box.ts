import request from "@/utils/request";
import type { SampleBox } from "@/views/sample/data";

export interface BoxLogItem {
  id?: string;
  box: string;
  time: string;
  text: string;
  by: string;
  raw?: string;
  deviceTime?: string;
  kind?: string;
  lbsLng: number | null;
  lbsLat: number | null;
  gpsLng: number | null;
  gpsLat: number | null;
}

/** 板子本机日志回传。querying 等设备回条数，ready 等你确认范围，pending 等设备开始，running 回传中。 */
export interface DumpState {
  id: string;
  state: "querying" | "ready" | "pending" | "running" | "done" | "cancelled" | "timeout";
  total: number | null;
  parts: number | null;
  receivedParts: number;
  fromSec: number;
  max: number;
  createdAt: string;
  updatedAt: string;
}

export interface UplinkQuery {
  from?: string;
  to?: string;
  limit?: number;
  cursorTime?: string;
  cursorId?: string;
  kind?: string;
}

export interface UplinkPage {
  list: BoxLogItem[];
  nextCursor: { time: string; id: string } | null;
}

export interface PlaceHit {
  lng: number;
  lat: number;
  count: number;
  latest: string;
}

export interface BoxPlaces {
  lbs: PlaceHit[];
  gps: PlaceHit[];
}

export interface BatteryPoint {
  /** 设备时间（补传的落在它真实发生的时间），没有才用收到时间。 */
  time: string;
  mv: number | null;
  percent: number | null;
  /** 0 未充电，1 充电中，2 已充满。旧上报可能没有。 */
  charge?: number | null;
  /** 中间超过 3 个上报周期没有数据，曲线在这里断开。 */
  gap?: boolean;
}

/** 快捷筛选：告警、离线、低电量、开着盖、可调配。 */
export type BoxFlag = "alert" | "offline" | "low" | "lid" | "ready";

export interface BoxFlags {
  alert: number;
  offline: number;
  low: number;
  lid: number;
  ready: number;
}

export interface BoxPage {
  list: SampleBox[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<string, number>;
  flags?: BoxFlags;
}

export interface BoxQuery {
  page?: number;
  pageSize?: number;
  life?: string;
  flag?: BoxFlag | "";
  q?: string;
  /** 所属单位编号。 */
  orgId?: string;
}

export interface TrackPoint {
  t: string;
  lng: number;
  lat: number;
}
/** 一台箱子一段时间内的位置点：GPS 连线，基站点误差大单独标。distanceM 是 GPS 行程。 */
export interface BoxTrack {
  boxId: string;
  gps: TrackPoint[];
  lbs: TrackPoint[];
  gpsCount: number;
  lbsCount: number;
  distanceM: number;
}
export interface BoxEvent {
  boxId: string;
  time: string;
  kind: string;
  label: string;
  text: string;
}
/** allow：这次给了轨迹（历史轨迹权限）和事件（事件权限）没有。 */
export interface TrackResult {
  tracks: BoxTrack[];
  events: BoxEvent[];
  window: { from: string; to: string };
  truncated?: boolean;
  allow?: { track: boolean; events: boolean };
}

export interface AssignOptions {
  orgs: { id: string; name: string; path: string }[];
  users: { id: string; name: string; dept: string }[];
}

function boxParams(params: BoxQuery) {
  return {
    life: params.life || undefined,
    flag: params.flag || undefined,
    q: params.q || undefined,
    orgId: params.orgId || undefined,
  };
}

const SampleBoxAPI = {
  list() {
    return request<unknown, SampleBox[]>({ url: "/api/v1/sample/boxes", method: "get" });
  },
  page(params: BoxQuery) {
    return request<unknown, BoxPage>({
      url: "/api/v1/sample/boxes",
      method: "get",
      params: {
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 20,
        ...boxParams(params),
      },
    });
  },
  stats() {
    return request<unknown, { total: number; counts: Record<string, number>; flags: BoxFlags }>({
      url: "/api/v1/sample/boxes/stats",
      method: "get",
    });
  },
  export(params: BoxQuery) {
    return request<unknown, { data: Blob; headers: Record<string, string> }>({
      url: "/api/v1/sample/boxes/export",
      method: "get",
      params: boxParams(params),
      responseType: "blob",
    });
  },
  /** 激活时可以顺便起名，不填用建档时的默认名称。 */
  activate(id: string, name = "") {
    return request<unknown, SampleBox>({
      url: `/api/v1/sample/boxes/${encodeURIComponent(id)}/activate`,
      method: "post",
      data: name ? { name } : {},
    });
  },
  rename(id: string, name: string) {
    return request<unknown, SampleBox>({
      url: `/api/v1/sample/boxes/${encodeURIComponent(id)}/name`,
      method: "put",
      data: { name },
    });
  },
  /** 一段时间内的位置轨迹和开关箱事件，最长 31 天。 */
  track(id: string, params: { from?: string; to?: string; days?: number }) {
    return request<unknown, TrackResult>({
      url: `/api/v1/sample/boxes/${encodeURIComponent(id)}/track`,
      method: "get",
      params,
    });
  },
  remove(id: string, wipe: "" | "quick" | "full" = "") {
    return request<unknown, { deleted: boolean; wiping: boolean; wipe: "quick" | "full" | null }>({
      url: `/api/v1/sample/boxes/${encodeURIComponent(id)}`,
      method: "delete",
      params: wipe ? { wipe } : undefined,
    });
  },
  exportLogs(id: string, params: { from?: string; to?: string; kind?: string }) {
    return request<unknown, { data: Blob; headers: Record<string, string> }>({
      url: `/api/v1/sample/boxes/${encodeURIComponent(id)}/export-logs`,
      method: "get",
      params,
      responseType: "blob",
    });
  },
  dumpQuery(id: string) {
    return request<unknown, DumpState>({
      url: `/api/v1/sample/boxes/${encodeURIComponent(id)}/dump`,
      method: "post",
    });
  },
  dumpStatus(id: string) {
    return request<unknown, DumpState | null>({
      url: `/api/v1/sample/boxes/${encodeURIComponent(id)}/dump`,
      method: "get",
    });
  },
  dumpConfirm(id: string, req: string, data: { fromSec: number; max: number }) {
    return request<unknown, DumpState>({
      url: `/api/v1/sample/boxes/${encodeURIComponent(id)}/dump/${req}`,
      method: "put",
      data,
    });
  },
  dumpCancel(id: string, req: string) {
    return request<unknown, DumpState>({
      url: `/api/v1/sample/boxes/${encodeURIComponent(id)}/dump/${req}`,
      method: "delete",
    });
  },
  dumpDownload(id: string, req: string) {
    return request<unknown, { data: Blob; headers: Record<string, string> }>({
      url: `/api/v1/sample/boxes/${encodeURIComponent(id)}/dump/${req}/download`,
      method: "get",
      responseType: "blob",
    });
  },
  disable(id: string) {
    return request<unknown, SampleBox>({
      url: `/api/v1/sample/boxes/${id}/disable`,
      method: "post",
    });
  },
  restore(id: string) {
    return request<unknown, SampleBox>({
      url: `/api/v1/sample/boxes/${id}/restore`,
      method: "post",
    });
  },
  assign(id: string, data: { orgId?: string; ownerId?: string }) {
    return request<unknown, SampleBox>({
      url: `/api/v1/sample/boxes/${id}/assign`,
      method: "put",
      data,
    });
  },
  assignOptions(params?: { orgId?: string; q?: string }) {
    return request<unknown, AssignOptions>({
      url: "/api/v1/sample/boxes/assign-options",
      method: "get",
      params,
    });
  },
  detail(id: string) {
    return request<unknown, SampleBox>({ url: `/api/v1/sample/boxes/${id}`, method: "get" });
  },
  logs(id: string, params?: UplinkQuery) {
    return request<unknown, UplinkPage>({
      url: `/api/v1/sample/boxes/${id}/logs`,
      method: "get",
      params,
    });
  },
  battery(id: string, from: string, to: string) {
    return request<unknown, BatteryPoint[]>({
      url: `/api/v1/sample/boxes/${id}/battery`,
      method: "get",
      params: { from, to },
    });
  },
  places(id: string) {
    return request<unknown, BoxPlaces>({
      url: `/api/v1/sample/boxes/${id}/places`,
      method: "get",
    });
  },
  raw(id: string, logId: string, receivedAt: string) {
    return request<unknown, { raw: string }>({
      url: `/api/v1/sample/boxes/${id}/logs/${logId}`,
      method: "get",
      params: { receivedAt },
    });
  },
  reports() {
    return request<unknown, BoxLogItem[]>({ url: "/api/v1/sample/reports", method: "get" });
  },
};

export default SampleBoxAPI;
