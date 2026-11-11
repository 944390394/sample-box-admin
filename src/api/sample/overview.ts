import request from "@/utils/request";

/** 箱子统计：总数、按生命周期、按标记（告警、离线、低电量、开着盖、可调配）。 */
export interface BoxStats {
  total: number;
  counts: Record<string, number>;
  flags: Record<string, number>;
}

/** 检测站的三个数：在途来站的箱子、已到待检测、这一天已开始检测。 */
export interface StationCounts {
  moving: number;
  arrived: number;
  inspected: number;
}

export interface OverviewUnit {
  id: string;
  name: string;
  /** 公司 / 检测站 / 采样机构。顶级单位都列，检测站不管在哪一级都单独列。 */
  type: string;
  path: string;
  /** 第一个顶级部门（总公司），没分配单位的箱子也算在它名下。 */
  hq?: boolean;
  stats: BoxStats | null;
  station: StationCounts | null;
}

export interface GroupOverview {
  day: string;
  total: BoxStats | null;
  units: OverviewUnit[];
}

export interface InboundTask {
  id: string;
  name: string;
  kind: string;
  status: string;
  from: string;
  boxes: number;
  createdAt: string;
}
export interface WaitingBox {
  boxId: string;
  boxName: string;
  taskId: string;
  taskName: string;
  from: string;
  signedAt: string;
  opensDuring: number | null;
  maxOpens: number | null;
}
export interface DoneBox {
  boxId: string;
  boxName: string;
  taskId: string;
  taskName: string;
  from: string;
  inspectedAt: string;
  inspectedBy: string;
  opensDuring: number | null;
}
export interface DayTask {
  id: string;
  name: string;
  kind: string;
  status: string;
  createdAt: string;
  endedAt: string;
  from: string;
  to: string;
  boxes: number;
  inspect: boolean;
}

export interface UnitOverview {
  unit: { id: string; name: string; type: string; path: string; hq?: boolean };
  day: string;
  month: string;
  stats: BoxStats | null;
  station:
    (StationCounts & { inbound: InboundTask[]; waiting: WaitingBox[]; done: DoneBox[] }) | null;
  /** 选中那天进行过的任务；没有任务权限时为 null。 */
  tasks: DayTask[] | null;
  /** 这个月每天有几张进行中的单，没有的日子不列。 */
  calendar: Record<string, number> | null;
}

export default {
  group: () => request<unknown, GroupOverview>({ url: "/api/v1/sample/overview", method: "get" }),
  unit: (orgId: string, params: { day?: string; month?: string } = {}) =>
    request<unknown, UnitOverview>({
      url: `/api/v1/sample/overview/${encodeURIComponent(orgId)}`,
      method: "get",
      params,
    }),
};
