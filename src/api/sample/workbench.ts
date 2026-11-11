import request from "@/utils/request";

export interface BoxBrief {
  id: string;
  name: string;
  org: string;
  owner: string;
  life: string;
  last: string;
  alert: string;
  batteryUsable: number | null;
  lid: number | null;
  address: string;
}

export interface TaskBrief {
  id: string;
  name: string;
  kind: string;
  status: string;
  createdAt: string;
  from: string;
  to: string;
  boxes: number;
}

export interface Bucket<T> {
  total: number;
  list: T[];
}

/** 工作台动态：任务流转或箱子开关箱、上电。 */
export interface FeedItem {
  type: "task" | "box";
  time: string;
  action: string;
  taskId?: string;
  taskName?: string;
  kind?: string;
  status?: string;
  by?: string;
  note?: string;
  boxId?: string;
  boxName?: string;
  /** 箱子事件：同一台箱子连续的同类事件合成一条，count 是次数，since 是最早一次的时间（time 是最近一次）。 */
  count?: number;
  since?: string;
}

export interface Workbench {
  /** 勾了哪几张工作台卡片（monitor:card:*，逐张授权）；旧服务端为空。 */
  cards: string[] | null;
  stats: { total: number; counts: Record<string, number>; flags: Record<string, number> } | null;
  boxTodo: {
    pending?: Bucket<BoxBrief>;
    alert?: Bucket<BoxBrief>;
    offline?: Bucket<BoxBrief>;
    low?: Bucket<BoxBrief>;
    lid?: Bucket<BoxBrief>;
  };
  taskTodo: {
    /** 我现在能推进的任务（去重）：工作台标题、顶栏铃铛、任务单「待我处理」同一个数。旧服务端没有。 */
    todo?: Bucket<TaskBrief>;
    send?: Bucket<TaskBrief>;
    arrive?: Bucket<TaskBrief>;
    sign?: Bucket<TaskBrief>;
    sampling?: Bucket<TaskBrief>;
    /** 检测站：已签收、要逐台开始检测的单。旧服务端没有。 */
    inspect?: Bucket<TaskBrief>;
    /** 被拒收、正退回本单位、要我接收的单。 */
    returning?: Bucket<TaskBrief>;
    overLimit?: Bucket<TaskBrief>;
    mine?: Bucket<TaskBrief>;
    moving: Bucket<TaskBrief>;
  } | null;
  myBoxes: Bucket<BoxBrief> | null;
  feed: FeedItem[];
}

/**
 * 「待处理」件数：我能推进的任务（去重，一张单只算一次）+ 待激活的箱子。
 * 顶栏铃铛和工作台标题都用它；任务单「待我处理」标签是同一批任务。
 * 低电、开着盖、离线这些是提醒，不算件数。
 */
export function todoCount(data: Workbench) {
  const t = data.taskTodo;
  const tasks = t
    ? (t.todo?.total ??
      (t.send?.total || 0) +
        (t.arrive?.total || 0) +
        (t.sign?.total || 0) +
        (t.returning?.total || 0) +
        (t.sampling?.total || 0) +
        (t.inspect?.total || 0))
    : 0;
  return tasks + (data.boxTodo?.pending?.total || 0);
}

export default {
  get: () => request<unknown, Workbench>({ url: "/api/v1/sample/workbench", method: "get" }),
};
