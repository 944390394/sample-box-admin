/**
 * User 用户类型定义
 */

import type { BaseQueryParams } from "@/api/common";

/** 登录用户信息 */
export interface UserInfo {
  /** 用户ID */
  userId?: string;
  /** 用户名 */
  username?: string;
  /** 用户昵称 */
  nickname?: string;
  /** 头像URL */
  avatar?: string;
  /** 租户切换权限（true 可切换租户） */
  canSwitchTenant?: boolean;
  /** 角色集合 */
  roles: string[];
  /** 权限集合 */
  perms: string[];
  /** 须先改密：required 管理员要求（新建、重置、强制），expired 超过更换周期。null 不需要。 */
  passwordChange?: "required" | "expired" | null;
  /** 当前密码规则说明。 */
  passwordRule?: string;
}

/** 用户分页查询参数 */
export interface UserQueryParams extends BaseQueryParams {
  /** 搜索关键字 */
  keywords?: string;
  /** 用户状态 */
  status?: number;
  /** 部门ID */
  deptId?: string;
  /** 创建时间 */
  createTime?: [string, string];
}

/** 用户分页对象 */
export interface UserItem {
  /** 用户ID */
  id: string;
  /** 用户头像地址 */
  avatar?: string;
  /** 创建时间 */
  createTime?: Date;
  /** 部门名称 */
  deptName?: string;
  /** 用户邮箱 */
  email?: string;
  /** 性别 */
  gender?: number;
  /** 手机号 */
  mobile?: string;
  /** 用户昵称 */
  nickname?: string;
  /** 角色名称，多个使用英文逗号(,)分割 */
  roleNames?: string;
  /** 用户状态(1:启用;0:禁用) */
  status?: number;
  /** 用户名 */
  username?: string;
  deptId?: string;
  /** 管理员要求或新建、重置后，下次登录必须改密。 */
  mustChangePassword?: boolean;
  /** 连续输错被锁定，还剩几分钟；0 为未锁定。 */
  lockedMinutes?: number;
  /** 超过密码策略里的更换周期。 */
  passwordExpired?: boolean;
  /** 在小程序里绑定了微信。 */
  wechatBound?: boolean;
  /** 绑定的微信昵称（用户在小程序里填的，可能为空）。 */
  wechatNickname?: string;
}

/** 我绑定的微信：昵称、头像是用户在小程序里填的。 */
export interface MyWechat {
  bound: boolean;
  nickname?: string;
  avatar?: string;
  boundAt?: string;
  lastLoginAt?: string;
}

/** 用户表单对象 */
export interface UserForm {
  /** 用户ID */
  id?: string;
  /** 用户头像 */
  avatar?: string;
  /** 部门ID */
  deptId?: string;
  /** 用户邮箱 */
  email?: string;
  /** 性别 */
  gender?: number;
  /** 手机号 */
  mobile?: string;
  /** 用户昵称 */
  nickname?: string;
  /** 角色ID集合 */
  roleIds?: number[];
  /** 用户状态(1:正常;0:禁用) */
  status?: number;
  /** 用户名 */
  username?: string;
  /** 新建时的初始密码；不填由服务端随机生成。 */
  password?: string;
}

/** 个人中心用户信息 */
export interface UserProfileDetail {
  /** 用户ID */
  id?: string;
  /** 用户名 */
  username?: string;
  /** 用户昵称 */
  nickname?: string;
  /** 头像URL */
  avatar?: string;
  /** 性别 */
  gender?: number;
  /** 手机号 */
  mobile?: string;
  /** 邮箱 */
  email?: string;
  /** 部门名称 */
  deptName?: string;
  /** 角色名称 */
  roleNames?: string;
  /** 创建时间 */
  createTime?: Date;
}

/** 个人中心用户信息表单 */
export interface UserProfileForm {
  /** 用户昵称 */
  nickname?: string;
  /** 头像URL */
  avatar?: string;
  /** 性别 */
  gender?: number;
}

/** 修改密码表单 */
export interface PasswordChangeForm {
  /** 原密码 */
  oldPassword?: string;
  /** 新密码 */
  newPassword?: string;
  /** 确认新密码 */
  confirmPassword?: string;
}

/** 密码校验表单 */
export interface PasswordVerifyForm {
  /** 当前密码 */
  password?: string;
}

/** 修改手机表单 */
export interface MobileUpdateForm {
  /** 手机号 */
  mobile?: string;
  /** 验证码 */
  code?: string;
  /** 当前密码 */
  password?: string;
}

/** 修改邮箱表单 */
export interface EmailUpdateForm {
  /** 邮箱 */
  email?: string;
  /** 验证码 */
  code?: string;
  /** 当前密码 */
  password?: string;
}
