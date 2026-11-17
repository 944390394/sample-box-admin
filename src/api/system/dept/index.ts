import request from "@/utils/request";
import type { DeptQueryParams, DeptItem, DeptForm, DeptSaveResult } from "./types";
import type { OptionItem } from "@/api/common";

const DEPT_BASE_URL = "/api/v1/depts";

/** 部门权限上限。perms 为 null 表示不限。 */
export interface DeptLimit {
  id: string;
  name: string;
  limited: boolean;
  perms: string[];
  maxScope: number | null;
  parent: {
    perms: string[] | null;
    maxScope: number | null;
    chain: { id: string; name: string; limited: boolean }[];
  };
  effective: { perms: string[] | null; maxScope: number | null };
  users: number;
  editable: boolean;
  assignable: string[] | null;
  /** 不能动的项为什么不能动 */
  reasons: Record<string, string>;
  myScope: number;
}

const DeptAPI = {
  /** 获取部门树形列表 */
  getList(queryParams?: DeptQueryParams) {
    return request<unknown, DeptItem[]>({
      url: `${DEPT_BASE_URL}`,
      method: "get",
      params: queryParams,
    });
  },
  /** 获取部门下拉数据源 */
  getOptions() {
    return request<unknown, OptionItem[]>({ url: `${DEPT_BASE_URL}/options`, method: "get" });
  },
  /** 获取部门表单数据 */
  getFormData(id: string) {
    return request<unknown, DeptForm>({ url: `${DEPT_BASE_URL}/${id}/form`, method: "get" });
  },
  /** 新增部门 */
  create(data: DeptForm) {
    return request<unknown, DeptSaveResult | null>({
      url: `${DEPT_BASE_URL}`,
      method: "post",
      data,
    });
  },
  /** 修改部门 */
  update(id: string, data: DeptForm) {
    return request<unknown, DeptSaveResult | null>({
      url: `${DEPT_BASE_URL}/${id}`,
      method: "put",
      data,
    });
  },
  /** 部门权限上限：自己的设置、上级的实际上限、自己的实际上限、当前用户能动哪些项。 */
  getLimit(id: string) {
    return request<unknown, DeptLimit>({ url: `${DEPT_BASE_URL}/${id}/limit`, method: "get" });
  },
  /** limited 为假表示跟上级一样；perms 是单独限制时最多能用的权限；maxScope 1–4，空表示跟上级。 */
  saveLimit(id: string, data: { limited: boolean; perms: string[]; maxScope: number | null }) {
    return request({ url: `${DEPT_BASE_URL}/${id}/limit`, method: "put", data });
  },
  /** 批量删除部门，多个以英文逗号(,)分割 */
  deleteByIds(ids: string) {
    return request({ url: `${DEPT_BASE_URL}/${ids}`, method: "delete" });
  },
};

export default DeptAPI;

// 重导出类型
export * from "./types";
