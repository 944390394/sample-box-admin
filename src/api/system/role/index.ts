import request from "@/utils/request";
import type { RoleQueryParams, RoleItem, RoleForm } from "./types";
import type { PageResult } from "@/api/common";

const ROLE_BASE_URL = "/api/v1/roles";

/**
 * 一项权限：label 是名称，hint 是白话说明。
 * tier：enter 能进这页、see 能看到什么、do 能做什么。needs 是前置，列出的任意一项有了这一项才用得上；
 * 勾选时自动补上第一项，取消前置时连带取消依赖它的项。
 */
export interface PermItem {
  code: string;
  label: string;
  hint?: string;
  module?: string;
  tier?: "enter" | "see" | "do";
  needs?: string[];
}
/** 一个模块（和菜单对应），items 按 能进这页 → 能看到什么 → 能做什么 排好。 */
export interface PermGroup {
  key: string;
  label: string;
  hint: string;
  items: PermItem[];
}
/** 常用模板：一键套用后再改。 */
export interface RoleTemplate {
  key: string;
  label: string;
  hint: string;
  codes: string[];
}
export interface PermCatalog {
  groups: PermGroup[];
  tiers: Record<string, string>;
  templates: RoleTemplate[];
  passwordRule: string;
}
/** 人员表单里的角色选项；当前用户不能分配的 disabled 为真，reason 说明原因；cut 是在目标部门会被上限挡住的项数。 */
export interface RoleOption {
  value: number;
  label: string;
  disabled?: boolean;
  reason?: string;
  cut?: number;
}

const RoleAPI = {
  permCatalog() {
    return request<unknown, PermCatalog>({ url: `${ROLE_BASE_URL}/perm-catalog`, method: "get" });
  },
  /**
   * fixed 为真表示系统管理员，固定拥有全部权限。
   * codes 拥有的权限，grantOption 其中开了「可转授」的；assignable 是当前用户能勾、能取消、能改可转授的权限码
   *（自己可转授的）：null 表示全部（系统管理员），空数组表示没有「给角色分配权限」。
   */
  getPerms(roleId: string) {
    return request<
      unknown,
      {
        codes: string[];
        grantOption: string[];
        fixed: boolean;
        assignable: string[] | null;
        reasons: Record<string, string>;
      }
    >({ url: `${ROLE_BASE_URL}/${roleId}/perms`, method: "get" });
  },
  /** codes 是拥有的权限，grantOption 是其中开「可转授」的。 */
  savePerms(roleId: string, codes: string[], grantOption: string[]) {
    return request({
      url: `${ROLE_BASE_URL}/${roleId}/perms`,
      method: "put",
      data: { codes, grantOption },
    });
  },
  /** 获取角色分页数据 */
  getPage(queryParams?: RoleQueryParams) {
    return request<unknown, PageResult<RoleItem>>({
      url: `${ROLE_BASE_URL}`,
      method: "get",
      params: queryParams,
    });
  },
  /** 角色下拉选项，带当前用户能不能分配 */
  getOptions(deptId = "") {
    return request<unknown, RoleOption[]>({
      url: `${ROLE_BASE_URL}/options`,
      method: "get",
      params: deptId ? { deptId } : undefined,
    });
  },
  /** 获取角色表单数据 */
  getFormData(id: string) {
    return request<unknown, RoleForm>({ url: `${ROLE_BASE_URL}/${id}/form`, method: "get" });
  },
  /** 获取角色的部门ID集合(自定义数据权限) */
  getRoleDeptIds(roleId: string) {
    return request<unknown, string[]>({
      url: `${ROLE_BASE_URL}/${roleId}/dept-ids`,
      method: "get",
    });
  },
  /** 新增角色 */
  create(data: RoleForm) {
    return request({ url: `${ROLE_BASE_URL}`, method: "post", data });
  },
  /** 更新角色 */
  update(id: string, data: RoleForm) {
    return request({ url: `${ROLE_BASE_URL}/${id}`, method: "put", data });
  },
  /** 批量删除角色，多个以英文逗号(,)分割 */
  deleteByIds(ids: string) {
    return request({ url: `${ROLE_BASE_URL}/${ids}`, method: "delete" });
  },
};

export default RoleAPI;

// 重导出类型
export * from "./types";
