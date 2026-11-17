import request from "@/utils/request";
import type { UplinkPage } from "./box";
/** indicators 缺省视为 true：STM 三个指示灯日常亮；false 为日常全灭，需固件 1.0.7 及以上。 */
export interface Policy {
  reportPeriodSec: number;
  reportOnlyWhenCharging: boolean;
  indicators?: boolean;
  moduleLed?: boolean;
  periodicGps?: boolean;
}
export interface PolicyState {
  single: Policy | null;
  batch: Policy | null;
  effective: Policy & { source: string; version: string };
  status: string;
  taskId: string | null;
  sentAt: string | null;
  confirmedAt: string | null;
  echo?: { version: string; periodSec: number; charging: boolean } | null;
}
/** 任务里的地址快照。orgId 是来源单位，custom 表示改过、不是单位地址原样。没有坐标时算不了距离。 */
export interface Place {
  address: string;
  lng: number | null;
  lat: number | null;
  orgId?: string;
  custom?: boolean;
  radiusM?: number;
}
/** 单位的有效位置；inherited 为真表示用的是上级 fromName 的位置。 */
export interface OrgLocation {
  address: string;
  lng: number | null;
  lat: number | null;
  contact: string;
  phone: string;
  fromId: string;
  fromName: string;
  inherited: boolean;
}
export interface PolicyTask {
  id: string;
  name: string;
  kind: string;
  status: string;
  createdAt: string;
  boxIds: string[];
  policy: Policy | null;
  overrides: Record<string, Policy>;
  fromOrg?: string;
  toOrg?: string;
  sender?: string;
  signer?: string;
  place?: string;
  people?: string;
  note?: string;
  sample?: string;
  fromOrgId?: string;
  toOrgId?: string;
  senderId?: string;
  signerId?: string;
  fromPlace?: Place | null;
  toPlace?: Place | null;
  orgId?: string;
  org?: string;
  placeAt?: Place | null;
  /** 采样单的寄送方式：单向寄到采样单位、双向采样后寄回；旧单没有，箱子已在采样单位。 */
  trip?: "单向" | "双向";
  /** 这张单的流程步骤，服务端按类型和寄送方式给出。 */
  steps?: string[];
  /** 任务期间每台箱子最多开几次箱，不设为不限。 */
  maxOpens?: number | null;
  /** 送检测站的单：签收后「待检测」，检测站逐台扫码开始检测，全部检测完「已检测」。 */
  inspect?: boolean;
  /** 创建人姓名，旧任务没有。 */
  createdBy?: string;
  /** 列表用：开箱次数超过上限的箱子台数。 */
  openOver?: number;
  /** 正在前往某地的任务：几台已到附近。 */
  arrival?: { role: string; near: number; total: number };
  /** 采样任务：采样机构开箱时请求视频平台录像。 */
  recordVideo?: boolean;
  /** 列表用：我现在能把它推进到哪些状态。 */
  actions?: string[];
}
export interface TaskOrg {
  id: string;
  parentId: string;
  name: string;
  type?: "公司" | "采样机构";
  path: string;
  inScope: boolean;
  location: OrgLocation | null;
  leader: { id: string; name: string } | null;
}
export interface TaskOptions {
  orgs: TaskOrg[];
  users: { id: string; name: string; dept: string }[];
  myOrgId: string;
  arriveRadiusM: number;
}
export interface TaskBox {
  id: string;
  name?: string;
  missing: boolean;
  org: string;
  life: string;
  last: string;
  /** 当前位置：GPS 过时、基站更新时是基站。at 是这个位置的时间，gpsAt 是最后一次 GPS 定位时间（用了基站时才有）。 */
  position: { lng: number; lat: number; source: string; at?: string; gpsAt?: string } | null;
  distanceM: number | null;
  near: boolean | null;
  /** 任务开始以来开了几次箱；任务还没开始为 null。 */
  opensDuring?: number | null;
  owner?: string;
  /** 没有状态权限为 null。 */
  status?: {
    battery: string;
    batteryUsable: number | null;
    charge: number | null;
    lid: number | null;
    csq: number | null;
    alert: string;
  } | null;
  /** 当前位置的中文地址，没有位置权限为空。 */
  address?: string;
  /** 送检测站的单：这台箱子扫码「开始检测」的时间和人，没开始为空串。 */
  inspectedAt?: string;
  inspectedBy?: string;
}
/** 签收核验里的一台箱子：状态、本次开箱、离收货点多远，issues 是它的问题。 */
export interface ReceiveBox {
  id: string;
  name: string;
  missing: boolean;
  opensDuring: number | null;
  over: boolean;
  near: boolean | null;
  distanceM: number | null;
  positionSource: string;
  positionAt: string;
  lid: number | null;
  alert: string;
  battery: string;
  batteryUsable: number | null;
  charge: number | null;
  last: string;
  issues: string[];
}
export interface ReceiveCheck {
  target: { role: string; address: string; hasCoords: boolean } | null;
  radiusM: number;
  maxOpens: number | null;
  boxes: ReceiveBox[];
  problems: { boxId: string; name: string; text: string }[];
}
export interface TrackPoint {
  t: string;
  lng: number;
  lat: number;
}
/** 任务期间一台箱子的位置点：GPS 连线，基站点误差大单独标。distanceM 是 GPS 行程。 */
export interface TaskTrack {
  boxId: string;
  gps: TrackPoint[];
  lbs: TrackPoint[];
  gpsCount: number;
  lbsCount: number;
  distanceM: number;
}
/** 任务期间的开箱、关箱、上电上报。 */
/**
 * 任务期间的箱子事件：开箱 pad、关箱 shut、上电 boot，以及推出来的：
 * 连接中断 gap（一条没补回）、信号不好 weak（补回八成以上）、数据不全 partial（只补回一部分）；连着的短失联合成一条，label 为「连接不稳定」，count 是次数；失联中 lost、离开 leave / 到达 arrive 任务地点。
 */
export interface TaskEvent {
  boxId: string;
  time: string;
  kind: string;
  label: string;
  text: string;
  minutes?: number;
  backfilled?: number;
  expected?: number;
  count?: number;
  role?: string;
}
/** 开箱视频，预留：接入前服务端恒返回空数组。 */
/**
 * 开箱录像：采样机构在采样单位开箱一次一条。
 * status：待请求 / 已请求 / 录制中 / 已完成 / 失败 / 平台未接入。有 url 时可以播放。
 */
export interface TaskVideo {
  id: string;
  boxId: string;
  title: string;
  url: string;
  poster?: string;
  recordedAt: string;
  by?: string;
  durationSec?: number;
  openedAt?: string;
  distanceM?: number | null;
  status?: string;
  detail?: string;
  attempts?: number;
}
export interface TaskLog {
  status: string;
  action: string;
  by: string;
  note: string;
  time: string;
  detail: {
    target: { role: string; address: string };
    boxes: { id: string; distanceM: number | null; source: string }[];
  } | null;
}
/** 一路监控：status 未接入 / 在线 / 离线；liveUrl 有值时可以直接看。 */
export interface TaskCamera {
  index: number;
  name: string;
  channel: string;
  status: string;
  liveUrl: string;
  playbackUrl: string;
}

export interface TaskDetail {
  /** 采样单位（调拨为接收单位）的监控通道，1–8 路；要有录像权限才有。 */
  cameras?: TaskCamera[];
  task: PolicyTask;
  target: (Place & { role: string }) | null;
  boxes: TaskBox[];
  arriveRadiusM: number;
  can: Record<string, boolean>;
  logs: TaskLog[];
  /** 在等你收货时的签收核验；有 problems 时不能直接签收，只能拒收或强制签收。 */
  check?: ReceiveCheck | null;
  tracks?: TaskTrack[];
  events?: TaskEvent[];
  videos?: TaskVideo[];
  /** 当前用户能不能看任务上报记录、录像、上报策略。 */
  allow?: { log: boolean; video: boolean; policy: boolean };
  /** 轨迹和事件的时间范围：创建到结束（没结束到现在），服务器本地时间。 */
  window?: { from: string; to: string };
}
/** 任务轨迹：places 是要进出的地点（寄出、收货、计划地点）和到达半径。 */
export interface TaskTrackResult {
  task: { id: string; name: string; kind: string; status: string; createdAt: string };
  window: { from: string; to: string };
  places: { role: string; lng: number; lat: number; radiusM: number }[];
  tracks: TaskTrack[];
  events: TaskEvent[];
  truncated?: boolean;
}
export type TaskCreate = Omit<
  PolicyTask,
  "id" | "status" | "createdAt" | "arrival" | "openOver" | "createdBy" | "steps"
>;
export interface TaskQuery {
  page?: number;
  pageSize?: number;
  boxId?: string;
  kind?: string;
  status?: string;
  q?: string;
  orgId?: string;
  from?: string;
  to?: string;
  mine?: "1";
}
/** 同样筛选下各状态的数量；mine 是我现在能推进的。 */
export type TaskCounts = Record<string, number> & {
  全部: number;
  进行中: number;
  已结束: number;
  mine: number;
};
export const policyPerm = {
  read: "device:box:policyRead",
  single: "device:box:policyWrite",
  batch: "device:box:policyBatch",
  defaults: "device:box:policyDefault",
  /** 任务期间上报策略（新建任务时设） */
  task: "task:policy",
};
const base = "/api/v1/sample";
export default {
  get: (id: string) =>
    request<unknown, PolicyState>({ url: `${base}/boxes/${encodeURIComponent(id)}/report-policy` }),
  save: (id: string, policy: Policy | null) =>
    request({
      url: `${base}/boxes/${encodeURIComponent(id)}/report-policy`,
      method: "put",
      data: { policy },
    }),
  preview: (data: { ids?: string[]; filter?: Record<string, unknown> }) =>
    request<unknown, { ids: string[]; total: number; overridden: number }>({
      url: `${base}/report-policy/preview`,
      method: "post",
      data,
    }),
  batch: (ids: string[], policy: Policy | null) =>
    request({ url: `${base}/report-policy/batch`, method: "put", data: { ids, policy } }),
  createTask: (data: TaskCreate) =>
    request<unknown, { id: string }>({ url: `${base}/tasks`, method: "post", data }),
  tasks: (params: TaskQuery = {}) =>
    request<unknown, { list: PolicyTask[]; total: number; counts: TaskCounts }>({
      url: `${base}/tasks`,
      params,
    }),
  /** 任务期间所有箱子的上报记录，按时间倒序翻页。 */
  taskLogs: (
    id: string,
    params: {
      boxId?: string;
      kind?: string;
      cursorTime?: string;
      cursorId?: string;
      limit?: number;
    } = {}
  ) =>
    request<unknown, UplinkPage & { window: { from: string; to: string } }>({
      url: `${base}/tasks/${encodeURIComponent(id)}/logs`,
      params,
    }),
  retryVideo: (id: string, videoId: string) =>
    request<unknown, { videos: TaskVideo[] }>({
      url: `${base}/tasks/${encodeURIComponent(id)}/videos/${encodeURIComponent(videoId)}/retry`,
      method: "post",
    }),
  taskOptions: (orgId?: string) =>
    request<unknown, TaskOptions>({
      url: `${base}/tasks/options`,
      params: orgId ? { orgId } : undefined,
    }),
  task: (id: string) =>
    request<unknown, TaskDetail>({ url: `${base}/tasks/${encodeURIComponent(id)}` }),
  /** 任务期间一台箱子（不传 boxId 为全部）的轨迹和事件；要能看任务和「当前位置」。 */
  taskTrack: (id: string, boxId?: string) =>
    request<unknown, TaskTrackResult>({
      url: `${base}/tasks/${encodeURIComponent(id)}/track`,
      params: boxId ? { boxId } : undefined,
    }),
  transition: (id: string, status: string, note = "") =>
    request({
      url: `${base}/tasks/${encodeURIComponent(id)}/status`,
      method: "put",
      data: { status, note },
    }),
  /** 检测站：一台箱子开始检测。done 为真表示整张单都检测完了。 */
  inspect: (id: string, boxId: string) =>
    request<any, { done: boolean; left: number }>({
      url: `${base}/tasks/${encodeURIComponent(id)}/boxes/${encodeURIComponent(boxId)}/inspect`,
      method: "post",
    }),
};

/** 米转成给人看的距离。 */
export function formatDistance(m: number | null | undefined) {
  if (m == null) return "—";
  return m < 1000 ? `${m} 米` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} 公里`;
}
