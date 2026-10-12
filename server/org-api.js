import {
  buildDeptTree,
  DATA_SCOPE_LABEL,
  decorateUsers,
  filterDeptTree,
  filterUsers,
  paginate,
  toDeptOptions,
} from "../shared/org.js";
import { menuOptions } from "./menus.js";

function toDept(row) {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    code: row.code,
    sort: Number(row.sort),
    status: Number(row.status),
    createTime: row.create_time,
    updateTime: row.update_time,
  };
}

function toRole(row) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    status: Number(row.status),
    sort: Number(row.sort),
    dataScope: Number(row.data_scope),
    dataScopeLabel: DATA_SCOPE_LABEL[Number(row.data_scope)] || "",
    createTime: row.create_time,
    updateTime: row.update_time,
  };
}

async function loadDeptTree(db) {
  const rows = await db.all("SELECT * FROM sys_dept");
  return buildDeptTree(rows.map(toDept));
}

async function loadUsers(db) {
  const rows = await db.all("SELECT * FROM sys_user");
  const links = await db.all("SELECT user_id, role_id FROM sys_user_role");
  const roleIds = new Map();
  for (const link of links) {
    const list = roleIds.get(link.user_id) || [];
    list.push(Number(link.role_id));
    roleIds.set(link.user_id, list);
  }
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    email: row.email || "",
    status: Number(row.status),
    deptId: row.dept_id,
    roleIds: roleIds.get(row.id) || [],
    mobile: row.mobile || "",
    gender: row.gender,
    avatar: row.avatar || "",
    createTime: row.create_time,
  }));
}

async function nextId(db, table) {
  const rows = await db.all(`SELECT id FROM ${table}`);
  const max = rows.reduce((acc, row) => Math.max(acc, Number(row.id) || 0), 0);
  return String(max + 1);
}

export async function listDepts(ctx) {
  ctx.ok(filterDeptTree(await loadDeptTree(ctx.db), ctx.query));
}

export async function deptOptions(ctx) {
  ctx.ok(toDeptOptions(await loadDeptTree(ctx.db)));
}

export async function deptForm(ctx) {
  const row = await ctx.db.get("SELECT * FROM sys_dept WHERE id = ?", [ctx.params.id]);
  if (!row) return ctx.fail("部门不存在");
  const item = toDept(row);
  ctx.ok({
    id: item.id,
    name: item.name,
    code: item.code,
    parentId: item.parentId,
    status: item.status,
    sort: item.sort,
  });
}

export async function createDept(ctx) {
  const body = ctx.body || {};
  if (!body.name || !body.code) return ctx.fail("部门名称和编号不能为空");
  const parentId = String(body.parentId ?? "0");
  if (parentId !== "0") {
    const parent = await ctx.db.get("SELECT id FROM sys_dept WHERE id = ?", [parentId]);
    if (!parent) return ctx.fail("上级部门不存在");
  }
  const duplicated = await ctx.db.get("SELECT id FROM sys_dept WHERE code = ?", [body.code]);
  if (duplicated) return ctx.fail("部门编号已存在");
  const id = await nextId(ctx.db, "sys_dept");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await ctx.db.run(
    `INSERT INTO sys_dept (id, parent_id, name, code, sort, status, create_time, update_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, parentId, body.name, body.code, Number(body.sort) || 1, Number(body.status ?? 1), now, now]
  );
  ctx.ok(null, `新增部门${body.name}成功`);
}

export async function updateDept(ctx) {
  const body = ctx.body || {};
  const current = await ctx.db.get("SELECT * FROM sys_dept WHERE id = ?", [ctx.params.id]);
  if (!current) return ctx.fail("部门不存在");
  const parentId = String(body.parentId ?? current.parent_id);
  if (parentId === current.id) return ctx.fail("上级部门不能是自己");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await ctx.db.run(
    `UPDATE sys_dept SET parent_id = ?, name = ?, code = ?, sort = ?, status = ?, update_time = ? WHERE id = ?`,
    [
      parentId,
      body.name || current.name,
      body.code || current.code,
      Number(body.sort ?? current.sort),
      Number(body.status ?? current.status),
      now,
      current.id,
    ]
  );
  ctx.ok(null, `修改部门${body.name || current.name}成功`);
}

export async function deleteDepts(ctx) {
  const ids = String(ctx.params.id || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const id of ids) {
    const children = await ctx.db.get(
      "SELECT COUNT(*) AS total FROM sys_dept WHERE parent_id = ?",
      [id]
    );
    if (Number(children?.total || 0) > 0) return ctx.fail("请先删除下级部门");
    const users = await ctx.db.get("SELECT COUNT(*) AS total FROM sys_user WHERE dept_id = ?", [
      id,
    ]);
    if (Number(users?.total || 0) > 0) return ctx.fail("部门下还有用户，不能删除");
  }
  for (const id of ids) {
    await ctx.db.run("DELETE FROM sys_dept WHERE id = ?", [id]);
  }
  ctx.ok(null, "删除部门成功");
}

export async function listRoles(ctx) {
  const rows = (await ctx.db.all("SELECT * FROM sys_role")).map(toRole);
  const keywords = String(ctx.query.keywords || "").trim();
  const matched = rows
    .filter((item) => !keywords || item.name.includes(keywords) || item.code.includes(keywords))
    .sort((a, b) => a.sort - b.sort);
  ctx.ok(paginate(matched, ctx.query));
}

export async function roleOptions(ctx) {
  const rows = (await ctx.db.all("SELECT id, name, sort FROM sys_role ORDER BY sort")).map(
    (row) => ({
      value: Number(row.id),
      label: row.name,
    })
  );
  ctx.ok(rows);
}

export async function roleForm(ctx) {
  const row = await ctx.db.get("SELECT * FROM sys_role WHERE id = ?", [ctx.params.id]);
  if (!row) return ctx.fail("角色不存在");
  const item = toRole(row);
  ctx.ok({
    id: item.id,
    name: item.name,
    code: item.code,
    status: item.status,
    sort: item.sort,
    dataScope: item.dataScope,
  });
}

export async function createRole(ctx) {
  const body = ctx.body || {};
  if (!body.name || !body.code) return ctx.fail("角色名称和编码不能为空");
  const duplicated = await ctx.db.get("SELECT id FROM sys_role WHERE code = ?", [body.code]);
  if (duplicated) return ctx.fail("角色编码已存在");
  const id = await nextId(ctx.db, "sys_role");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await ctx.db.run(
    `INSERT INTO sys_role (id, name, code, data_scope, sort, status, create_time, update_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.name,
      body.code,
      Number(body.dataScope) || 1,
      Number(body.sort) || 1,
      Number(body.status ?? 1),
      now,
      now,
    ]
  );
  ctx.ok(null, `新增角色${body.name}成功`);
}

export async function updateRole(ctx) {
  const body = ctx.body || {};
  const current = await ctx.db.get("SELECT * FROM sys_role WHERE id = ?", [ctx.params.id]);
  if (!current) return ctx.fail("角色不存在");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await ctx.db.run(
    `UPDATE sys_role SET name = ?, code = ?, data_scope = ?, sort = ?, status = ?, update_time = ? WHERE id = ?`,
    [
      body.name || current.name,
      body.code || current.code,
      Number(body.dataScope ?? current.data_scope),
      Number(body.sort ?? current.sort),
      Number(body.status ?? current.status),
      now,
      current.id,
    ]
  );
  ctx.ok(null, `修改角色${body.name || current.name}成功`);
}

export async function deleteRoles(ctx) {
  const ids = String(ctx.params.id || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const id of ids) {
    const role = await ctx.db.get("SELECT code FROM sys_role WHERE id = ?", [id]);
    if (role?.code === "ADMIN") return ctx.fail("不能删除系统管理员");
    if (role?.code === "HOME_SWITCH") return ctx.fail("不能删除视角切换角色");
  }
  for (const id of ids) {
    await ctx.db.run("DELETE FROM sys_user_role WHERE role_id = ?", [id]);
    await ctx.db.run("DELETE FROM sys_role WHERE id = ?", [id]);
  }
  ctx.ok(null, "删除角色成功");
}

const boxPermsByRole = {
  2: [9101, 9102, 9103, 9104, 9105, 9106],
  8: [9101, 9102, 9103, 9104, 9105, 9106],
  9: [9101, 9102, 9104],
  10: [9101, 9102, 9104],
  11: [9101, 9102, 9104],
  13: [9101, 9102, 9104],
};

export async function roleMenuIds(ctx) {
  const ids = [];
  for (const group of menuOptions) {
    ids.push(group.value);
    for (const child of group.children || []) ids.push(child.value);
  }
  const extra = boxPermsByRole[String(ctx.params.id)] || [];
  ctx.ok([...ids, ...extra]);
}

export async function listUsers(ctx) {
  const tree = await loadDeptTree(ctx.db);
  const roles = (await ctx.db.all("SELECT * FROM sys_role")).map(toRole);
  const decorated = decorateUsers(await loadUsers(ctx.db), tree, roles);
  ctx.ok(paginate(filterUsers(decorated, ctx.query, tree), ctx.query));
}

export async function userForm(ctx) {
  const users = await loadUsers(ctx.db);
  const row = users.find((item) => item.id === ctx.params.id);
  if (!row) return ctx.fail("用户不存在");
  ctx.ok({
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    email: row.email,
    status: row.status,
    deptId: row.deptId,
    roleIds: row.roleIds,
    mobile: row.mobile,
    gender: row.gender,
    avatar: row.avatar,
  });
}

export async function createUser(ctx) {
  const body = ctx.body || {};
  if (!body.username || !body.nickname || !body.deptId)
    return ctx.fail("用户名、昵称和部门不能为空");
  const duplicated = await ctx.db.get("SELECT id FROM sys_user WHERE username = ?", [
    body.username,
  ]);
  if (duplicated) return ctx.fail("用户名已存在");
  const id = await nextId(ctx.db, "sys_user");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const { hashPassword } = await import("./auth.js");
  await ctx.db.run(
    `INSERT INTO sys_user
      (id, username, nickname, password_hash, dept_id, status, mobile, gender, email, avatar, create_time, update_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.username,
      body.nickname,
      hashPassword(body.password || "123456"),
      String(body.deptId),
      Number(body.status ?? 1),
      body.mobile || null,
      body.gender ?? null,
      body.email || "",
      body.avatar || "",
      now,
      now,
    ]
  );
  for (const roleId of body.roleIds || []) {
    await ctx.db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", [
      id,
      String(roleId),
    ]);
  }
  ctx.ok(null, `新增用户${body.nickname}成功`);
}

export async function updateUser(ctx) {
  const body = ctx.body || {};
  const current = await ctx.db.get("SELECT * FROM sys_user WHERE id = ?", [ctx.params.id]);
  if (!current) return ctx.fail("用户不存在");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await ctx.db.run(
    `UPDATE sys_user
     SET nickname = ?, dept_id = ?, status = ?, mobile = ?, gender = ?, email = ?, avatar = ?, update_time = ?
     WHERE id = ?`,
    [
      body.nickname || current.nickname,
      String(body.deptId || current.dept_id),
      Number(body.status ?? current.status),
      body.mobile || null,
      body.gender ?? current.gender,
      body.email ?? current.email,
      body.avatar ?? current.avatar,
      now,
      current.id,
    ]
  );
  if (Array.isArray(body.roleIds)) {
    await ctx.db.run("DELETE FROM sys_user_role WHERE user_id = ?", [current.id]);
    for (const roleId of body.roleIds) {
      await ctx.db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", [
        current.id,
        String(roleId),
      ]);
    }
  }
  ctx.ok(null, `修改用户${body.nickname || current.nickname}成功`);
}

export async function deleteUsers(ctx) {
  const ids = String(ctx.params.id || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.includes("2")) return ctx.fail("不能删除系统管理员");
  for (const id of ids) {
    await ctx.db.run("DELETE FROM sys_user_role WHERE user_id = ?", [id]);
    await ctx.db.run("DELETE FROM sys_user WHERE id = ?", [id]);
  }
  ctx.ok(null, "删除用户成功");
}

export async function resetPassword(ctx) {
  const password = ctx.query.password;
  if (!password || String(password).length < 6) return ctx.fail("密码至少需要6位字符");
  const { hashPassword } = await import("./auth.js");
  await ctx.db.run("UPDATE sys_user SET password_hash = ? WHERE id = ?", [
    hashPassword(String(password)),
    ctx.params.id,
  ]);
  ctx.ok(null, `重置密码成功，新密码为：${password}`);
}
