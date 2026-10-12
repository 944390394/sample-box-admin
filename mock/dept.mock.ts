import { defineMock } from "./base";
import { deptForm, depts, filterDeptTree, toDeptOptions } from "../shared/org.js";

export default defineMock([
  {
    url: "depts/options",
    method: ["GET"],
    body: {
      code: "00000",
      data: toDeptOptions(depts),
      msg: "一切ok",
    },
  },

  {
    url: "depts",
    method: ["GET"],
    body({ query }) {
      return {
        code: "00000",
        data: filterDeptTree(depts, query || {}),
        msg: "一切ok",
      };
    },
  },

  {
    url: "depts",
    method: ["POST"],
    body({ body }) {
      return {
        code: "00000",
        data: null,
        msg: "新增部门" + body.name + "成功",
      };
    },
  },

  {
    url: "depts/:id/form",
    method: ["GET"],
    body: ({ params }) => {
      return {
        code: "00000",
        data: deptForm(params.id),
        msg: "一切ok",
      };
    },
  },

  {
    url: "depts/:id",
    method: ["PUT"],
    body({ body }) {
      return {
        code: "00000",
        data: null,
        msg: "修改部门" + body.name + "成功",
      };
    },
  },

  {
    url: "depts/:id",
    method: ["DELETE"],
    body({ params }) {
      return {
        code: "00000",
        data: null,
        msg: "删除部门" + params.id + "成功",
      };
    },
  },
]);
