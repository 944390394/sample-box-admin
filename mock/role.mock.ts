import { defineMock } from "./base";
import { paginate, roleForm, roles } from "../shared/org.js";

export default defineMock([
  {
    url: "roles/options",
    method: ["GET"],
    body: {
      code: "00000",
      data: roles.map((item) => ({ value: Number(item.id), label: item.name })),
      msg: "一切ok",
    },
  },

  {
    url: "roles",
    method: ["GET"],
    body({ query }) {
      const keywords = String(query?.keywords || "").trim();
      const matched = roles.filter((item) => {
        if (!keywords) return true;
        return item.name.includes(keywords) || item.code.includes(keywords);
      });
      return {
        code: "00000",
        data: paginate(matched, query),
        msg: "一切ok",
      };
    },
  },

  {
    url: "roles",
    method: ["POST"],
    body({ body }) {
      return {
        code: "00000",
        data: null,
        msg: "新增角色" + body.name + "成功",
      };
    },
  },

  {
    url: "roles/:id/form",
    method: ["GET"],
    body: ({ params }) => {
      return {
        code: "00000",
        data: roleForm(params.id),
        msg: "一切ok",
      };
    },
  },

  {
    url: "roles/:id",
    method: ["PUT"],
    body({ body }) {
      return {
        code: "00000",
        data: null,
        msg: "修改角色" + body.name + "成功",
      };
    },
  },

  {
    url: "roles/:id",
    method: ["DELETE"],
    body({ params }) {
      return {
        code: "00000",
        data: null,
        msg: "删除角色" + params.id + "成功",
      };
    },
  },

  {
    url: "roles/:id/menu-ids",
    method: ["GET"],
    body: ({ params }) => {
      const full = ["9101", "9102", "9103", "9104", "9105", "9106"];
      const read = ["9101", "9102", "9104"];
      const byRole = {
        "2": full,
        "8": full,
        "9": read,
        "10": read,
        "11": read,
        "13": read,
      };
      return {
        code: "00000",
        data: byRole[String(params.id)] || [],
        msg: "一切ok",
      };
    },
  },

  {
    url: "roles/:id/menus",
    method: ["PUT"],
    body: {
      code: "00000",
      data: null,
      msg: "一切ok",
    },
  },

  {
    url: "roles/:id/dept-ids",
    method: ["GET"],
    body: () => {
      return {
        code: "00000",
        data: [],
        msg: "一切ok",
      };
    },
  },
]);
