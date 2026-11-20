import request from "@/utils/request";

/** 箱子统计：总数、按生命周期、按标记（告警、离线、低电量、开着盖、可调配）。 */
export interface BoxStats {
  total: number;
  counts: Record<string, number>;
  flags: Record<string, number>;
}

/**
 * 检测站四数＋今日（组织简化 P13，集团 stationTotal 与单位 station 同口径）：
 * moving＝在途来站（合并单[在途,待签收]＋legacy 调拨/送检在途映射期兼容）；
 * arrivedTotal＝累计已到站（单∈[待检测,已检测,退回中,已退回]的箱快照数，含已结束）；
 * openedTotal＝累计已开箱（inspected_at 非空，跨日累计）；
 * unopenedNow＝当前未开箱（待检测且 inspected_at 空）；
 * todayOpened＝今日已开箱（选定日窗口；集团恒今天）。
 */
export interface StationCounts {
  moving: number;
  arrivedTotal: number;
  openedTotal: number;
  unopenedNow: number;
  todayOpened: number;
  /** @deprecated 旧别名＝unopenedNow，服务端过渡期仍下发；前端已切新字段。 */
  arrived?: number;
  /** @deprecated 旧别名＝todayOpened，同上。 */
  inspected?: number;
}

export interface OverviewUnit {
  id: string;
  name: string;
  /** 公司 / 检测站。顶级单位都列，检测站（全局唯一）不管在哪一级都单独列。 */
  type: string;
  path: string;
  /** 第一个顶级部门（总公司），没分配单位的箱子也算在它名下。 */
  hq?: boolean;
  stats: BoxStats | null;
  station: StationCounts | null;
}

/** 箱子最多的分公司，给条形图用。 */
export interface TopUnit {
  id: string;
  name: string;
  total: number;
  moving: number;
  idle: number;
  pending: number;
}

export interface GroupQuery {
  q?: string;
  type?: "" | "branch" | "station";
  sort?: "" | "total" | "moving" | "alert" | "name";
  page?: number;
  pageSize?: number;
  /** 模拟视角（仅系统管理员生效）：按该单位＋该角色的范围与权限只读预览。 */
  asOrgId?: string;
  asRoleCode?: string;
}

/** 模拟视角回执：未模拟时为 null。数据按该单位该角色计算，非真实权限。 */
export interface ViewAs {
  orgId: string;
  orgName: string;
  roleCode: string;
  roleLabel: string;
}

export interface GroupOverview {
  day: string;
  total: BoxStats | null;
  /** 唯一检测站的四数＋今日合计；没有检测站时为 null。 */
  stationTotal: StationCounts | null;
  branchTotal: number;
  stationCount: number;
  /** 搜索筛选后的单位总数（分页用）。 */
  unitTotal: number;
  /** 非全量范围且恰好只有一个单位时＝该单位编号（前端空态/筛选空结果跳转用）；否则 null。 */
  myUnitId: string | null;
  /** 模拟视角回执；未模拟为 null。 */
  viewAs: ViewAs | null;
  page: number;
  pageSize: number;
  top: TopUnit[];
  /** 当前页的单位。 */
  units: OverviewUnit[];
}

export interface StationBoxes {
  pageSize: number;
  waiting: number;
  done: number;
  inbound: number;
  waitingPage: number;
  donePage: number;
  inboundPage: number;
}

/** 来源公司（分公司）的四数＋今日，口径与全站一致；company 筛选时只算那一家。 */
export interface StationCompany extends StationCounts {
  key: string;
  name: string;
}

export interface InboundTask {
  id: string;
  name: string;
  kind: string;
  status: string;
  from: string;
  fromKey?: string;
  boxes: number;
  createdAt: string;
}
export interface WaitingBox {
  boxId: string;
  boxName: string;
  taskId: string;
  taskName: string;
  from: string;
  fromKey?: string;
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
  fromKey?: string;
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

export interface UnitQuery {
  day?: string;
  month?: string;
  company?: string;
  companyQ?: string;
  companyPage?: number;
  waitingPage?: number;
  donePage?: number;
  inboundPage?: number;
  /** 模拟视角（仅系统管理员生效）：集团页单单位自动跳转时透传。 */
  asOrgId?: string;
  asRoleCode?: string;
}

export interface UnitOverview {
  unit: { id: string; name: string; type: string; path: string; hq?: boolean };
  day: string;
  month: string;
  /** 模拟视角回执；未模拟为 null。 */
  viewAs: ViewAs | null;
  stats: BoxStats | null;
  station:
    | (StationCounts & {
        companies: StationCompany[];
        companyTotal: number;
        companyPage: number;
        companyPageSize: number;
        boxes: StationBoxes;
        inbound: InboundTask[];
        waiting: WaitingBox[];
        done: DoneBox[];
      })
    | null;
  /** 选中那天进行过的任务；没有任务权限时为 null。 */
  tasks: DayTask[] | null;
  /** 这个月每天有几张进行中的单，没有的日子不列。 */
  calendar: Record<string, number> | null;
}

export default {
  // 轮询请求不弹全局错误提示，页面自己显示过期横幅
  group: (params: GroupQuery = {}) =>
    request<unknown, GroupOverview>({
      url: "/api/v1/sample/overview",
      method: "get",
      params,
      silent: true,
    }),
  unit: (orgId: string, params: UnitQuery = {}) =>
    request<unknown, UnitOverview>({
      url: `/api/v1/sample/overview/${encodeURIComponent(orgId)}`,
      method: "get",
      params,
      silent: true,
    }),
};
