import request from "@/utils/request";

export interface EffectivePerms {
  user: { id: string; name: string; username: string };
  admin: boolean;
  roles: { id: string; name: string; active: boolean; scope: string }[];
  chain: { id: string; name: string; limited: boolean; count: number | null; maxScope: string }[];
  scope: { roles: string; cap: string; effective: string };
  items: { code: string; has: boolean; roles: string[]; cutBy: string; grantable: boolean }[];
}
import type {
  UserInfo,
  UserForm,
  UserQueryParams,
  UserItem,
  UserProfileDetail,
  UserProfileForm,
  PasswordChangeForm,
  PasswordVerifyForm,
  MobileUpdateForm,
  EmailUpdateForm,
  MyWechat,
} from "./types";
import type { ExcelResult, OptionItem, PageResult } from "@/api/common";

const USER_BASE_URL = "/api/v1/users";

const UserAPI = {
  /**
   * 获取当前登录用户信息
   *
   * @returns 登录用户昵称、头像信息，包括角色和权限
   */
  getInfo() {
    return request<unknown, UserInfo>({
      url: `${USER_BASE_URL}/me`,
      method: "get",
    });
  },

  /**
   * 获取用户分页列表
   *
   * @param queryParams 查询参数
   */
  getPage(queryParams: UserQueryParams) {
    return request<unknown, PageResult<UserItem>>({
      url: `${USER_BASE_URL}`,
      method: "get",
      params: queryParams,
    });
  },

  /**
   * 获取用户表单详情
   *
   * @param userId 用户ID
   * @returns 用户表单详情
   */
  /** 一个人的实际权限：每项来自哪些角色、有没有被部门上限挡住，数据范围怎么算出来的。 */
  getEffectivePerms(userId: string) {
    return request<unknown, EffectivePerms>({
      url: `${USER_BASE_URL}/${userId}/effective-perms`,
      method: "get",
    });
  },
  getFormData(userId: string) {
    return request<unknown, UserForm>({
      url: `${USER_BASE_URL}/${userId}/form`,
      method: "get",
    });
  },

  /**
   * 添加用户
   *
   * @param data 用户表单数据
   */
  /** 不填密码时服务端随机生成，只在这次返回 password。 */
  create(data: UserForm) {
    const payload = { ...data };
    delete payload.avatar;
    return request<unknown, { id: string; username: string; password: string }>({
      url: `${USER_BASE_URL}`,
      method: "post",
      data: payload,
    });
  },

  /**
   * 修改用户
   *
   * @param id 用户ID
   * @param data 用户表单数据
   */
  update(id: string, data: UserForm) {
    const payload = { ...data };
    delete payload.avatar;
    return request({
      url: `${USER_BASE_URL}/${id}`,
      method: "put",
      data: payload,
    });
  },

  /**
   * 修改用户密码
   *
   * @param id 用户ID
   * @param password 新密码
   */
  resetPassword(id: string, password = "") {
    return request<unknown, { password: string }>({
      url: `${USER_BASE_URL}/${id}/password/reset`,
      method: "put",
      data: { password },
    });
  },

  /** 下次登录必须改密。 */
  forcePassword(id: string) {
    return request({ url: `${USER_BASE_URL}/${id}/force-password`, method: "post" });
  },
  /** 免除首次改密（审核、演示等共用账号），仅系统管理员。 */
  skipPassword(id: string) {
    return request({ url: `${USER_BASE_URL}/${id}/skip-password`, method: "post" });
  },

  unlock(id: string) {
    return request({ url: `${USER_BASE_URL}/${id}/unlock`, method: "post" });
  },

  /** 强制下线：已有登录全部失效。 */
  kick(id: string) {
    return request({ url: `${USER_BASE_URL}/${id}/kick`, method: "post" });
  },

  /** 解绑微信：之后在小程序里要重新输账号密码。 */
  unbindWechat(id: string) {
    return request({ url: `${USER_BASE_URL}/${id}/wechat`, method: "delete" });
  },

  /**
   * 批量删除用户，多个以英文逗号(,)分割
   *
   * @param ids 用户ID字符串，多个以英文逗号(,)分割
   */
  deleteByIds(ids: string) {
    return request({
      url: `${USER_BASE_URL}/${ids}`,
      method: "delete",
    });
  },

  /** 下载用户导入模板 */
  downloadTemplate() {
    return request({
      url: `${USER_BASE_URL}/template`,
      method: "get",
      responseType: "blob",
    });
  },

  /**
   * 导出用户
   *
   * @param queryParams 查询参数
   */
  export(queryParams: UserQueryParams) {
    return request({
      url: `${USER_BASE_URL}/export`,
      method: "get",
      params: queryParams,
      responseType: "blob",
    });
  },

  /**
   * 导入用户
   *
   * @param file 导入文件
   */
  import(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    return request<unknown, ExcelResult>({
      url: `${USER_BASE_URL}/import`,
      method: "post",
      data: formData,
      headers: {
        "Content-Type": "multipart/form-data",
      },
    });
  },

  /** 我绑定的微信（小程序登录用）。 */
  myWechat() {
    return request<unknown, MyWechat>({ url: `${USER_BASE_URL}/me/wechat`, method: "get" });
  },

  /** 生成绑定二维码的票据：5 分钟有效、只能用一次。 */
  wechatTicket() {
    return request<unknown, { ticket: string; expiresAt: string; ttlSec: number }>({
      url: `${USER_BASE_URL}/me/wechat/ticket`,
      method: "post",
    });
  },

  /** 解绑自己的微信。 */
  unbindMyWechat() {
    return request({ url: "/api/v1/auth/wechat/bind", method: "delete" });
  },

  /** 获取个人中心用户信息 */
  getProfile() {
    return request<unknown, UserProfileDetail>({
      url: `${USER_BASE_URL}/profile`,
      method: "get",
    });
  },

  /** 修改个人中心用户信息 */
  updateProfile(data: UserProfileForm) {
    return request({
      url: `${USER_BASE_URL}/profile`,
      method: "put",
      data,
    });
  },

  /** 修改个人中心用户密码 */
  changePassword(data: PasswordChangeForm) {
    return request({
      url: `${USER_BASE_URL}/password`,
      method: "put",
      data,
    });
  },

  /** 发送短信验证码（绑定或更换手机号）*/
  sendMobileCode(mobile: string) {
    return request({
      url: `${USER_BASE_URL}/mobile/code`,
      method: "post",
      params: { mobile },
    });
  },

  /** 绑定或更换手机号 */
  bindOrChangeMobile(data: MobileUpdateForm) {
    return request({
      url: `${USER_BASE_URL}/mobile`,
      method: "put",
      data,
    });
  },

  /** 解绑手机号 */
  unbindMobile(data: PasswordVerifyForm) {
    return request({
      url: `${USER_BASE_URL}/mobile`,
      method: "delete",
      data,
    });
  },

  /** 发送邮箱验证码（绑定或更换邮箱）*/
  sendEmailCode(email: string) {
    return request({
      url: `${USER_BASE_URL}/email/code`,
      method: "post",
      params: { email },
    });
  },

  /** 绑定或更换邮箱 */
  bindOrChangeEmail(data: EmailUpdateForm) {
    return request({
      url: `${USER_BASE_URL}/email`,
      method: "put",
      data,
    });
  },

  /** 解绑邮箱 */
  unbindEmail(data: PasswordVerifyForm) {
    return request({
      url: `${USER_BASE_URL}/email`,
      method: "delete",
      data,
    });
  },

  /**
   *  获取用户下拉列表
   */
  getOptions() {
    return request<unknown, OptionItem[]>({
      url: `${USER_BASE_URL}/options`,
      method: "get",
    });
  },
};

export default UserAPI;

// 重导出类型
export * from "./types";
