export type DeptType = "公司" | "采样机构";

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
  /** 类型：公司、采样机构或检测站。采样机构做采样单位时可以要求开箱录像；送到检测站的任务签收后要逐台扫码开始检测。 */
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
  /** 类型：公司、采样机构或检测站。采样机构做采样单位时可以要求开箱录像；送到检测站的任务签收后要逐台扫码开始检测。 */
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
  /** 采样机构的监控通道（1–8 路）。 */
  cameras?: DeptCamera[];
}

/** 一路监控：名称必填；平台通道号、直播地址、回放地址模板选填。 */
export interface DeptCamera {
  name: string;
  channel: string;
  liveUrl: string;
  playbackUrl: string;
}
