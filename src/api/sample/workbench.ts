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

export default {
  get: () => request<unknown, Workbench>({ url: "/api/v1/sample/workbench", method: "get" }),
};
