/** 组织简化（B1b）：部门类型只有 公司 / 检测站。公司＝总公司/分公司等（分公司自采）；检测站全局唯一、挂总公司子树。 */
export type DeptType = "公司" | "检测站";

/**
 * Dept 部门类型定义
 */

/** 部门查询参数 */
export interface DeptQueryParams {
  /** 搜索关键字 */
  keywords?: string;
  /** 状态 */
  status?: number;
}

/** 部门视图对象 */
export interface DeptItem {
  /** 子部门 */
  children?: DeptItem[];
  /** 创建时间 */
  createTime?: Date;
  /** 部门ID */
  id?: string;
  /** 部门名称 */
  name?: string;
  /** 部门编号 */
  code?: string;
  /** 类型：公司或检测站。分公司（公司类型）自采，可配采样现场监控通道；检测站全局唯一，接收任务单后逐台扫码开始检测，禁配摄像头。 */
  type?: DeptType;
  /** 父部门ID */
  parentId?: string;
  /** 排序 */
  sort?: number;
  /** 状态(1:启用；0:禁用) */
  status?: number;
  /** 父节点ID路径 */
  treePath?: string;
  /** 修改时间 */
  updateTime?: Date;
  /** 地址，没设时为空，任务里会用最近上级的地址 */
  address?: string;
  lng?: number | null;
  lat?: number | null;
  contact?: string;
  phone?: string;
  leaderUserId?: string;
  leaderName?: string;
  leaderMobile?: string;
  /** #26 B3（D2）：祖先只读壳。上级单位仅可见不可管：明细被后端清空，页面不给写操作入口。 */
  readOnly?: boolean;
}

/** 提交时的负责人：选已有用户，或在这个部门下新建账号；null 清空，不传不改。 */
export type DeptLeaderInput =
  | { userId: string }
  | {
      create: {
        nickname: string;
        username: string;
        mobile?: string;
        roleIds?: string[];
        password?: string;
      };
    }
  | null;

/** 新建了负责人账号时返回；password 只在随机生成时有值，且只返回这一次。 */
export interface DeptSaveResult {
  leader?: { userId: string; username: string; nickname: string; password: string };
}

/** 部门表单对象 */
export interface DeptForm {
  /** 部门ID */
  id?: string;
  /** 部门名称 */
  name?: string;
  /** 部门编号 */
  code?: string;
  /** 类型：公司或检测站。分公司（公司类型）自采，可配采样现场监控通道；检测站全局唯一，接收任务单后逐台扫码开始检测，禁配摄像头。 */
  type?: DeptType;
  /** 父部门ID */
  parentId?: string;
  /** 排序 */
  sort?: number;
  /** 状态(1:启用；0:禁用) */
  status?: number;
  address?: string;
  lng?: number | null;
  lat?: number | null;
  contact?: string;
  phone?: string;
  leaderUserId?: string;
  leaderName?: string;
  leaderMobile?: string;
  leader?: DeptLeaderInput;
  /** 分公司采样现场的监控通道（1–8 路）；检测站禁配（开箱凭证靠扫码＋开箱次数差）。 */
  cameras?: DeptCamera[];
  /** #26 B3：表单接口对祖先壳返回 readOnly=true（明细清空）；范围外部门直接 A0404。 */
  readOnly?: boolean;
}

/** 一路监控：名称必填；平台通道号、直播地址、回放地址模板选填。 */
export interface DeptCamera {
  name: string;
  channel: string;
  liveUrl: string;
  playbackUrl: string;
}
