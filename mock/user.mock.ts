import { defineMock } from "./base";
import {
  decorateUsers,
  depts,
  filterUsers,
  paginate,
  roles,
  userForm,
  users,
} from "../shared/org.js";

const adminPerms = [
  "sys:user:list",
  "sys:user:create",
  "sys:user:update",
  "sys:user:delete",
  "sys:user:import",
  "sys:user:export",
  "sys:user:reset-password",
  "sys:role:list",
  "sys:role:create",
  "sys:role:update",
  "sys:role:delete",
  "sys:role:assign",
  "sys:dept:list",
  "sys:dept:create",
  "sys:dept:update",
  "sys:dept:delete",
  "sys:menu:list",
  "sys:menu:create",
  "sys:menu:update",
  "sys:menu:delete",
  "sys:dict:list",
  "sys:dict:create",
  "sys:dict:update",
  "sys:dict:delete",
  "sys:dict-item:list",
  "sys:dict-item:create",
  "sys:dict-item:update",
  "sys:dict-item:delete",
  "sys:notice:list",
  "sys:notice:create",
  "sys:notice:update",
  "sys:notice:delete",
  "sys:notice:revoke",
  "sys:notice:publish",
  "sys:config:list",
  "sys:config:create",
  "sys:config:update",
  "sys:config:delete",
  "sys:config:refresh",
  "device:box:detail",
  "device:box:event",
  "device:box:log",
  "device:box:task",
  "device:box:activate",
  "device:box:disable",
  "monitor:home:switch",
];

export default defineMock([
  {
    url: "users/me",
    method: ["GET"],
    body: {
      code: "00000",
      data: {
        userId: "2",
        username: "admin",
        nickname: "系统管理员",
        avatar: "",
        roles: ["ADMIN", "HOME_SWITCH"],
        perms: adminPerms,
      },
      msg: "一切ok",
    },
  },

  {
    url: "users",
    method: ["GET"],
    body({ query }) {
      const decorated = decorateUsers(users, depts, roles);
      const matched = filterUsers(decorated, query || {}, depts);
      return {
        code: "00000",
        data: paginate(matched, query),
        msg: "一切ok",
      };
    },
  },

  {
    url: "users",
    method: ["POST"],
    body({ body }) {
      return {
        code: "00000",
        data: null,
        msg: "新增用户" + body.nickname + "成功",
      };
    },
  },

  {
    url: "users/:userId/form",
    method: ["GET"],
    body: ({ params }) => {
      return {
        code: "00000",
        data: userForm(params.userId),
        msg: "一切ok",
      };
    },
  },

  {
    url: "users/:userId",
    method: ["PUT"],
    body({ body }) {
      return {
        code: "00000",
        data: null,
        msg: "修改用户" + body.nickname + "成功",
      };
    },
  },

  {
    url: "users/:userId",
    method: ["DELETE"],
    body({ params }) {
      return {
        code: "00000",
        data: null,
        msg: "删除用户" + params.userId + "成功",
      };
    },
  },

  {
    url: "users/:userId/password/reset",
    method: ["PUT"],
    body({ query }) {
      return {
        code: "00000",
        data: null,
        msg: "重置密码成功，新密码为：" + query.password,
      };
    },
  },

  {
    url: "users/export",
    method: ["GET"],
    headers: {
      "Content-Disposition": "attachment; filename=%E7%94%A8%E6%88%B7%E5%88%97%E8%A1%A8.xlsx",
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  },

  {
    url: "users/profile",
    method: ["GET"],
    body: {
      code: "00000",
      data: {
        id: "2",
        username: "admin",
        nickname: "系统管理员",
        avatar: "",
        gender: null,
        mobile: "",
        email: null,
        deptName: "系统管理",
        roleNames: "系统管理员",
        createTime: "2026-09-26",
      },
    },
  },

  {
    url: "users/profile",
    method: ["PUT"],
    body() {
      return {
        code: "00000",
        data: null,
        msg: "修改个人信息成功",
      };
    },
  },

  {
    url: "users/password",
    method: ["PUT"],
    body() {
      return {
        code: "00000",
        data: null,
        msg: "修改密码成功",
      };
    },
  },
]);
