/** 部门、角色、用户的初始名单。Mock 和安装脚本都读这一份。 */

export const DATA_SCOPE_LABEL = {
  1: "全部数据",
  2: "部门及子部门数据",
  3: "本部门数据",
  4: "本人数据",
  5: "自定义部门数据",
};

const updated = "2026-09-26 09:00:00";

function dept(id, parentId, name, code, sort, children = []) {
  return {
    id,
    parentId,
    name,
    code,
    sort,
    status: 1,
    children,
    createTime: null,
    updateTime: updated,
  };
}

export const depts = [
  dept("1", "0", "总公司", "HQ", 1, [
    dept("11", "1", "系统管理", "HQ_SYS", 1),
    dept("12", "1", "资产管理", "HQ_ASSET", 2),
    dept("13", "1", "核验中心", "HQ_CHECK", 3),
    dept("14", "1", "监测值班", "HQ_DUTY", 4),
  ]),
  dept("2", "0", "华南分公司", "SOUTH", 2, [dept("21", "2", "调度室", "SOUTH_DISP", 1)]),
  dept("3", "0", "华东分公司", "EAST", 3, [dept("31", "3", "调度室", "EAST_DISP", 1)]),
  dept("4", "0", "西南分公司", "WEST", 4, [dept("41", "4", "调度室", "WEST_DISP", 1)]),
  dept("5", "0", "合作采样机构", "PARTNER", 5, [
    dept("51", "5", "采样机构甲", "AGENCY_A", 1, [
      dept("511", "51", "甲现场组", "AGENCY_A_FIELD", 1),
    ]),
    dept("52", "5", "采样机构乙", "AGENCY_B", 2, [
      dept("521", "52", "乙现场组", "AGENCY_B_FIELD", 1),
    ]),
  ]),
];

function role(id, name, code, dataScope, sort) {
  return {
    id: String(id),
    name,
    code,
    status: 1,
    sort,
    dataScope,
    dataScopeLabel: DATA_SCOPE_LABEL[dataScope],
    createTime: updated,
    updateTime: null,
  };
}

export const roles = [
  role(2, "系统管理员", "ADMIN", 1, 1),
  role(8, "资产管理员", "ASSET", 1, 2),
  role(9, "核验员", "VERIFY", 1, 3),
  role(10, "值班员", "DUTY", 1, 4),
  role(11, "领导查看", "LEADER", 1, 5),
  role(12, "分公司管理员", "BRANCH_ADMIN", 2, 6),
  role(13, "调度员", "DISPATCH", 2, 7),
  role(14, "机构负责人", "AGENCY_LEAD", 2, 8),
  role(15, "现场采样员", "SAMPLER", 4, 9),
  role(16, "视角切换", "HOME_SWITCH", 1, 10),
];

function user(id, username, nickname, deptId, roleIds, status = 1) {
  return {
    id: String(id),
    username,
    nickname,
    email: "",
    status,
    deptId,
    roleIds,
    createTime: updated,
  };
}

export const users = [
  user(2, "admin", "系统管理员", "11", [2, 16]),
  user(4, "zhou.ning", "周宁", "12", [8]),
  user(5, "wu.di", "吴迪", "13", [9]),
  user(6, "chen.ke", "陈可", "21", [13]),
  user(7, "lin.xia", "林夏", "511", [15]),
  user(8, "zhao.heng", "赵衡", "521", [15], 0),
];

export function flattenDepts(nodes, acc = []) {
  for (const node of nodes) {
    const { children, ...rest } = node;
    acc.push(rest);
    if (children?.length) flattenDepts(children, acc);
  }
  return acc;
}

export function filterDeptTree(nodes, query = {}) {
  const keywords = String(query.keywords || "").trim();
  const hasStatus = query.status !== undefined && query.status !== null && query.status !== "";
  const statusNum = Number(query.status);

  function walk(list) {
    const result = [];
    for (const node of list) {
      const children = walk(node.children || []);
      const text = `${node.name}${node.code}`;
      const nameOk = !keywords || text.includes(keywords);
      const statusOk = !hasStatus || Number(node.status) === statusNum;
      if (children.length || (nameOk && statusOk)) {
        result.push({ ...node, children });
      }
    }
    return result;
  }

  return walk(nodes);
}

export function toDeptOptions(nodes) {
  return nodes.map((node) => {
    const children = node.children?.length ? toDeptOptions(node.children) : undefined;
    return children
      ? { value: node.id, label: node.name, children }
      : { value: node.id, label: node.name };
  });
}

export function findDept(nodes, deptId) {
  for (const node of nodes) {
    if (String(node.id) === String(deptId)) return node;
    const nested = findDept(node.children || [], deptId);
    if (nested) return nested;
  }
  return null;
}

export function collectDeptIds(nodes, deptId) {
  if (deptId === undefined || deptId === null || deptId === "") return null;
  const node = findDept(nodes, deptId);
  if (!node) return [String(deptId)];
  const ids = [];
  const walk = (current) => {
    ids.push(String(current.id));
    (current.children || []).forEach(walk);
  };
  walk(node);
  return ids;
}

export function buildDeptTree(rows) {
  const nodes = rows.map((row) => ({ ...row, children: [] }));
  const byId = new Map(nodes.map((node) => [String(node.id), node]));
  const roots = [];
  for (const node of nodes) {
    const parent = byId.get(String(node.parentId));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortList = (list) => {
    list.sort((a, b) => a.sort - b.sort || String(a.id).localeCompare(String(b.id)));
    list.forEach((node) => sortList(node.children));
  };
  sortList(roots);
  return roots;
}

export function decorateUsers(userList, deptNodes, roleList) {
  const deptName = Object.fromEntries(flattenDepts(deptNodes).map((item) => [item.id, item.name]));
  const roleName = Object.fromEntries(roleList.map((item) => [String(item.id), item.name]));
  return userList.map((item) => ({
    ...item,
    deptName: deptName[item.deptId] || "",
    roleNames: (item.roleIds || [])
      .map((roleId) => roleName[String(roleId)] || "")
      .filter(Boolean)
      .join(","),
  }));
}

export function filterUsers(userList, query, deptNodes) {
  const deptIds = collectDeptIds(deptNodes, query.deptId);
  const keywords = String(query.keywords || "").trim();
  const hasStatus = query.status !== undefined && query.status !== null && query.status !== "";
  const range = Array.isArray(query.createTime) ? query.createTime : [];

  return userList.filter((item) => {
    if (deptIds && !deptIds.includes(String(item.deptId))) return false;
    if (hasStatus && Number(item.status) !== Number(query.status)) return false;
    if (keywords) {
      const text = `${item.username}${item.nickname}${item.mobile || ""}`;
      if (!text.includes(keywords)) return false;
    }
    if (range[0] && range[1]) {
      const day = String(item.createTime || "").slice(0, 10);
      if (day < range[0] || day > range[1]) return false;
    }
    return true;
  });
}

export function paginate(list, query = {}) {
  const page = Number(query.pageNum) || 1;
  const size = Number(query.pageSize) || 10;
  const start = (page - 1) * size;
  return { list: list.slice(start, start + size), total: list.length };
}

export function deptForm(id) {
  const row = flattenDepts(depts).find((item) => item.id === String(id));
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    parentId: row.parentId,
    status: row.status,
    sort: row.sort,
  };
}

export function roleForm(id) {
  const row = roles.find((item) => item.id === String(id));
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    status: row.status,
    sort: row.sort,
    dataScope: row.dataScope,
  };
}

export function userForm(id) {
  const row = users.find((item) => item.id === String(id));
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    email: row.email || "",
    status: row.status,
    deptId: row.deptId,
    roleIds: row.roleIds,
  };
}
