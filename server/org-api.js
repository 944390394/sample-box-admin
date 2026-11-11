import {
  buildDeptTree,
  DATA_SCOPE_LABEL,
  decorateUsers,
  filterDeptTree,
  filterUsers,
  paginate,
  toDeptOptions,
} from "../shared/org.js";
import { audit } from "./src/log/audit.js";
import {
  ALL_PERMS,
  PERM_GROUPS,
  PERM_MODULES,
  ROLE_TEMPLATES,
  TIER_LABELS,
  permLabelOf,
} from "./src/auth/permCatalog.js";
import { resolveAccess, resolveDeptLimit } from "./src/auth/boxAccess.js";
import {
  checkPassword,
  describePolicy,
  lockedMinutes,
  passwordChangeReason,
  SECURITY_DEFAULTS,
} from "./src/settings/securityConfig.js";

/* 采样机构就是检测站：送到这里的任务签收后要逐台扫码「开始检测」，总览里单列。 */
const DEPT_TYPES = ["公司", "采样机构"];
const policyOf = (ctx) => ctx.security || SECURITY_DEFAULTS;
const isAdmin = (ctx) => !ctx.access || ctx.access.roles?.includes("ADMIN");
/**
 * 管人、管部门的范围：本部门（数据范围是「本单位及下级」时含下级），不含上级部门——下级管不了上级。
 * 看箱子的范围（scope.orgIds）另外还含上级单位，那是因为箱子挂在单位上，见 boxAccess.resolveScope。
 */
function manageIds(scope) {
  return scope.manageOrgIds ?? scope.orgIds;
}
function deptInManage(ctx, deptId) {
  const scope = ctx.access?.scope;
  if (!scope || scope.all || isAdmin(ctx)) return true;
  return manageIds(scope).includes(String(deptId ?? ""));
}
/** 非管理员只能管自己管理范围内的人：人员的部门在范围里，或者就是自己。 */
function userInScope(ctx, user) {
  const scope = ctx.access?.scope;
  if (!scope || scope.all) return true;
  return (
    manageIds(scope).includes(String(user.dept_id ?? user.deptId ?? "")) ||
    String(user.id) === String(ctx.user?.id)
  );
}
async function hasAdminRole(db, userId) {
  return Boolean(
    await db.get(
      "SELECT 1 AS x FROM sys_user_role ur JOIN sys_role r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.code = 'ADMIN'",
      [String(userId)]
    )
  );
}
/** 数据范围：1 全部、2 本单位及下级、3 本单位、4 仅本人，数字越小越宽。老数据里的 5 按本单位算。 */
function scopeRank(value) {
  const n = Number(value);
  if (n === 5) return 3;
  return n >= 1 && n <= 4 ? n : 4;
}
const hasPerm = (ctx, code) => isAdmin(ctx) || Boolean(ctx.access?.perms?.has(code));
/** 这项权限我能不能转授：系统管理员全部能；其他人要自己某个角色上这项开了「可转授」。 */
const canPass = (ctx, code) => isAdmin(ctx) || Boolean(ctx.access?.grantable?.has(code));
/**
 * 当前用户不能转授的项，逐项说明为什么（授权界面上灰掉的项悬停看原因）：
 * 被自己所在部门的上限挡住了、自己没有这项、有但没开可转授。管理员返回空对象。
 */
function lockReasons(ctx) {
  if (isAdmin(ctx)) return {};
  const access = ctx.access || {};
  const chain = access.limit?.chain || [];
  const out = {};
  for (const { code } of ALL_PERMS) {
    if (access.grantable?.has(code)) continue;
    if (access.rolePerms?.has(code) && !access.perms?.has(code)) {
      const by = chain.find((dept) => dept.limited && !(dept.perms || []).includes(code));
      out[code] =
        `被你所在部门${by ? "「" + by.name + "」" : ""}的上限挡住了，你自己也用不了，不能授给别人`;
    } else if (!access.perms?.has(code)) out[code] = "你自己没有这一项，不能授给别人";
    else out[code] = "你有这一项，但没有开「可转授」，不能授给别人";
  }
  return out;
}
/** 自己最宽的数据范围。管理员是全部。 */
async function myScopeRank(ctx) {
  if (isAdmin(ctx)) return 1;
  const rows = await ctx.db.all(
    "SELECT r.data_scope FROM sys_user_role ur JOIN sys_role r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.status = 1",
    [String(ctx.user?.id ?? "")]
  );
  const mine = rows.length ? Math.min(...rows.map((row) => scopeRank(row.data_scope))) : 4;
  const cap = ctx.access?.limit?.maxScope;
  return cap == null ? mine : Math.max(mine, cap);
}
async function permsOfRole(db, role) {
  if (role.code === "ADMIN") return ALL_PERMS.map((item) => item.code);
  return (await db.all("SELECT perm FROM sys_role_perm WHERE role_id = ?", [String(role.id)])).map(
    (row) => String(row.perm)
  );
}
/**
 * 非管理员给人加上或拿掉一个角色：角色里的权限都要是自己「可转授」的，数据范围不能比自己宽，
 * 否则等于把自己不能转授的权力交给别人。能做返回空串，不能做返回原因。
 */
async function cannotAssign(ctx, roleId, verb = "分配") {
  const role = await ctx.db.get("SELECT id, code, name, data_scope FROM sys_role WHERE id = ?", [
    String(roleId),
  ]);
  if (!role) return "角色不存在";
  if (isAdmin(ctx)) return "";
  if (role.code === "ADMIN") return `只有系统管理员可以${verb}系统管理员角色`;
  const beyond = (await permsOfRole(ctx.db, role)).filter((code) => !canPass(ctx, code));
  if (beyond.length)
    return `「${role.name}」里有你不能转授的权限（${beyond.slice(0, 3).map(permLabelOf).join("、")}${beyond.length > 3 ? `，共 ${beyond.length} 项` : ""}），不能${verb}`;
  if (scopeRank(role.data_scope) < (await myScopeRank(ctx)))
    return `「${role.name}」的数据范围比你的宽，不能${verb}`;
  return "";
}
/** 人员的角色有变化时：要有「给人员分配角色」，加上和拿掉的角色都要过 cannotAssign。返回失败原因。 */
async function checkRoleChange(ctx, wanted, current = []) {
  const before = new Set(current.map(String));
  const after = [...new Set((wanted || []).map(String))];
  const added = after.filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.includes(id));
  if (!added.length && !removed.length) return "";
  if (!hasPerm(ctx, "sys:user:role")) return "没有「给人员分配角色」权限，不能改人员的角色";
  for (const id of added) {
    const reason = await cannotAssign(ctx, id);
    if (reason) return reason;
  }
  for (const id of removed) {
    const reason = await cannotAssign(ctx, id, "收回");
    if (reason) return reason;
  }
  return "";
}
/** 管人员前的共同检查：用户存在、在范围里、非管理员不能动管理员。失败返回原因。 */
async function guardUser(ctx, id) {
  const user = await ctx.db.get("SELECT * FROM sys_user WHERE id = ?", [String(id)]);
  if (!user) return { error: "用户不存在" };
  if (!userInScope(ctx, user)) return { error: "只能管理自己数据范围内的人员" };
  if (!isAdmin(ctx) && (await hasAdminRole(ctx.db, user.id)))
    return { error: "只有系统管理员可以管理系统管理员账号" };
  return { user };
}
import { readCoords, readDeptLocation } from "./src/geo/place.js";
import { randomBytes } from "node:crypto";
import { readCameras, validateCameras } from "./src/settings/deptCameras.js";

async function record(ctx, action, targetType, targetId, result) {
  try {
    let orgName = "";
    if (ctx.user?.dept_id) {
      const dept = await ctx.db.get("SELECT name FROM sys_dept WHERE id = ?", [
        String(ctx.user.dept_id),
      ]);
      orgName = dept?.name || "";
    }
    await audit(ctx.db, {
      orgId: String(ctx.user?.dept_id || ""),
      orgName,
      actorId: String(ctx.user?.id || ""),
      actorName: ctx.user?.nickname || ctx.user?.username || "",
      action,
      targetType,
      targetId: String(targetId || ""),
      result,
      ip: ctx.ip || "",
    });
  } catch (error) {
    console.error("操作日志写入失败", error instanceof Error ? error.message : "未知错误");
  }
}

function toDept(row) {
  const coords = readCoords({ lng: row.lng, lat: row.lat });
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    code: row.code,
    type: DEPT_TYPES.includes(row.type) ? row.type : "公司",
    sort: Number(row.sort),
    status: Number(row.status),
    address: row.address || "",
    lng: coords.lng,
    lat: coords.lat,
    contact: row.contact || "",
    phone: row.phone || "",
    leaderUserId: row.leader_user_id || "",
    leaderName: row.leader_name || "",
    leaderMobile: row.leader_mobile || "",
    cameras: readCameras(row.cameras),
    createTime: row.create_time,
    updateTime: row.update_time,
  };
}

const DEPT_WITH_LEADER = `SELECT d.*, u.nickname AS leader_name, u.mobile AS leader_mobile
  FROM sys_dept d LEFT JOIN sys_user u ON u.id = d.leader_user_id`;

/** 去掉容易看错的 0/O、1/l/I，给人抄写用。 */
function randomPassword(length = 10) {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join("");
}

/**
 * 表单里的负责人：undefined 不改，null 或 "" 清空，{ userId } 选已有用户，{ create } 新建账号。
 * 新建账号只在这里校验，真正写库放在部门的同一个事务里。
 */
async function readLeader(db, input, policy = SECURITY_DEFAULTS) {
  if (input === undefined) return { keep: true };
  if (input === null || input === "") return { userId: null };
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("负责人格式不正确");
  if (input.userId != null && input.userId !== "") {
    const user = await db.get("SELECT id FROM sys_user WHERE id = ? AND status = 1", [
      String(input.userId),
    ]);
    if (!user) throw new Error("负责人不存在或已停用");
    return { userId: String(user.id) };
  }
  const spec = input.create;
  if (!spec || typeof spec !== "object") return { userId: null };
  const nickname = typeof spec.nickname === "string" ? spec.nickname.trim() : "";
  const username = typeof spec.username === "string" ? spec.username.trim() : "";
  if (!nickname || nickname.length > 64) throw new Error("请填写负责人姓名");
  if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(username))
    throw new Error("用户名须为 3–64 位字母、数字或 _ . @ -");
  if (await db.get("SELECT id FROM sys_user WHERE username = ?", [username]))
    throw new Error("用户名已存在");
  const mobile = typeof spec.mobile === "string" ? spec.mobile.trim() : "";
  if (mobile.length > 32) throw new Error("手机号格式不正确");
  const roleIds = Array.isArray(spec.roleIds)
    ? [...new Set(spec.roleIds.map(String))].slice(0, 10)
    : [];
  for (const roleId of roleIds) {
    if (!(await db.get("SELECT id FROM sys_role WHERE id = ?", [roleId])))
      throw new Error("角色不存在");
  }
  let password = typeof spec.password === "string" ? spec.password : "";
  const generated = !password;
  if (generated) password = randomPassword();
  else {
    const problem = checkPassword(password, policy);
    if (problem) throw new Error(`初始密码不符合要求：${problem}`);
  }
  return { create: { nickname, username, mobile, roleIds, password, generated } };
}

/**
 * 部门表单里每块字段要各自的权限：基本信息、类型、地址和联系人、监控通道、负责人。
 * 顺手新建负责人账号等于新增人员：还要「新增人员」，给角色还要「给人员分配角色」并过可转授检查。
 * current 为空表示新建。返回失败原因或空串。
 */
async function checkDeptFields(ctx, body, current, { place, leader, cameras }) {
  const need = (perm) => (hasPerm(ctx, perm) ? "" : `没有「${permLabelOf(perm)}」权限`);
  const creating = !current;
  const changed = (key, value, before) =>
    body[key] !== undefined && String(value ?? "") !== String(before ?? "");
  if (!creating) {
    const basic =
      changed("name", body.name, current.name) ||
      changed("code", body.code, current.code) ||
      changed("parentId", body.parentId, current.parent_id) ||
      changed("sort", body.sort, current.sort) ||
      changed("status", body.status, current.status);
    if (basic) {
      const why = need("sys:dept:update");
      if (why) return why;
    }
  }
  const type = DEPT_TYPES.includes(body.type) ? body.type : null;
  if (type && type !== (creating ? "公司" : current.type || "公司")) {
    const why = need("sys:dept:type");
    if (why) return why;
  }
  const before = creating ? {} : current;
  const moved = ["address", "lng", "lat", "contact", "phone"].some(
    (key) => String(place[key] ?? "") !== String(before[key] ?? "")
  );
  if (moved) {
    const why = need("sys:dept:address");
    if (why) return why;
  }
  if (
    cameras &&
    (creating
      ? cameras.length > 0
      : JSON.stringify(cameras) !== JSON.stringify(readCameras(current.cameras)))
  ) {
    const why = need("sys:dept:camera");
    if (why) return why;
  }
  if (
    !leader.keep &&
    (leader.create || String(leader.userId ?? "") !== String(before.leader_user_id ?? ""))
  ) {
    const why = need("sys:dept:leader");
    if (why) return why;
  }
  if (leader.create) {
    const why = need("sys:user:create");
    if (why) return why;
    if (leader.create.roleIds.length) {
      if (!hasPerm(ctx, "sys:user:role"))
        return "没有「给人员分配角色」权限，不能给负责人账号分配角色";
      for (const roleId of leader.create.roleIds) {
        const reason = await cannotAssign(ctx, roleId);
        if (reason) return reason;
      }
    }
  }
  return "";
}

/** 在部门的事务里建负责人账号，返回新用户编号。 */
async function createLeader(db, deptId, spec) {
  const { hashPassword } = await import("./auth.js");
  const id = await nextId(db, "sys_user");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await db.run(
    `INSERT INTO sys_user (id, username, nickname, password_hash, dept_id, status, mobile, gender, email, avatar, create_time, update_time, must_change_password, password_changed_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, NULL, '', '', ?, ?, 1, ?)`,
    [
      id,
      spec.username,
      spec.nickname,
      hashPassword(spec.password),
      String(deptId),
      spec.mobile || null,
      now,
      now,
      new Date().toISOString(),
    ]
  );
  for (const roleId of spec.roleIds) {
    await db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", [id, roleId]);
  }
  return id;
}

async function inTransaction(db, write) {
  if (typeof db.transaction === "function") return db.transaction(write);
  return write(db);
}

/** 表单没带位置字段时（旧页面）保留原值。 */
function deptLocation(body, current = {}) {
  const has = ["address", "lng", "lat", "contact", "phone"].some((key) => body[key] !== undefined);
  if (!has)
    return {
      address: current.address ?? null,
      lng: current.lng ?? null,
      lat: current.lat ?? null,
      contact: current.contact ?? null,
      phone: current.phone ?? null,
    };
  return readDeptLocation(body);
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
  const rows = await db.all(DEPT_WITH_LEADER);
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
    mustChangePassword: Number(row.must_change_password) === 1,
    lockedMinutes: lockedMinutes(row),
    passwordChangedAt: row.password_changed_at || "",
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
  const row = await ctx.db.get(`${DEPT_WITH_LEADER} WHERE d.id = ?`, [ctx.params.id]);
  if (!row) return ctx.fail("部门不存在");
  const item = toDept(row);
  ctx.ok({
    id: item.id,
    name: item.name,
    code: item.code,
    parentId: item.parentId,
    type: item.type,
    status: item.status,
    sort: item.sort,
    address: item.address,
    lng: item.lng,
    lat: item.lat,
    contact: item.contact,
    phone: item.phone,
    leaderUserId: item.leaderUserId,
    leaderName: item.leaderName,
    leaderMobile: item.leaderMobile,
    cameras: item.cameras,
  });
}

/** 新建了负责人账号时把账号和一次性初始密码带回页面；随机生成的密码只在这一次返回。 */
function leaderResult(leader, userId) {
  if (!leader.create) return null;
  return {
    leader: {
      userId,
      username: leader.create.username,
      nickname: leader.create.nickname,
      password: leader.create.generated ? leader.create.password : "",
    },
  };
}

export async function createDept(ctx) {
  const body = ctx.body || {};
  if (!body.name || !body.code) {
    await record(ctx, "新增部门", "dept", "", "失败");
    return ctx.fail("部门名称和编号不能为空");
  }
  const parentId = String(body.parentId ?? "0");
  if (parentId !== "0") {
    const parent = await ctx.db.get("SELECT id FROM sys_dept WHERE id = ?", [parentId]);
    if (!parent) {
      await record(ctx, "新增部门", "dept", "", "失败");
      return ctx.fail("上级部门不存在");
    }
  }
  const duplicated = await ctx.db.get("SELECT id FROM sys_dept WHERE code = ?", [body.code]);
  if (duplicated) {
    await record(ctx, "新增部门", "dept", "", "失败");
    return ctx.fail("部门编号已存在");
  }
  // 只能在自己管理范围里的部门下面建；顶级部门只有全部数据范围的人能建
  if (!(parentId === "0" ? isAdmin(ctx) || ctx.access?.scope?.all : deptInManage(ctx, parentId))) {
    await record(ctx, "新增部门", "dept", "", "失败");
    return ctx.fail("只能在自己管理范围内的部门下面新建");
  }
  let place, leader, cameras;
  try {
    place = deptLocation(body);
    leader = await readLeader(ctx.db, body.leader, policyOf(ctx));
    cameras = validateCameras(body.cameras);
  } catch (error) {
    await record(ctx, "新增部门", "dept", "", "失败");
    return ctx.fail(error.message);
  }
  const denied = await checkDeptFields(ctx, body, null, { place, leader, cameras });
  if (denied) {
    await record(ctx, "新增部门", "dept", "", "失败");
    return ctx.fail(denied);
  }
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  // 部门、负责人账号、负责人关系一起成功或一起失败
  const { id, leaderId } = await inTransaction(ctx.db, async (db) => {
    const id = await nextId(db, "sys_dept");
    await db.run(
      `INSERT INTO sys_dept (id, parent_id, name, code, type, sort, status, address, lng, lat, contact, phone, create_time, update_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        parentId,
        body.name,
        body.code,
        DEPT_TYPES.includes(body.type) ? body.type : "公司",
        Number(body.sort) || 1,
        Number(body.status ?? 1),
        place.address,
        place.lng,
        place.lat,
        place.contact,
        place.phone,
        now,
        now,
      ]
    );
    const leaderId = leader.create
      ? await createLeader(db, id, leader.create)
      : (leader.userId ?? null);
    if (leaderId)
      await db.run("UPDATE sys_dept SET leader_user_id = ? WHERE id = ?", [leaderId, id]);
    if (cameras.length)
      await db.run("UPDATE sys_dept SET cameras = ? WHERE id = ?", [JSON.stringify(cameras), id]);
    return { id, leaderId };
  });
  await record(ctx, "新增部门", "dept", id, "成功");
  if (leader.create) await record(ctx, "新增用户（部门负责人）", "user", leaderId, "成功");
  ctx.ok(leaderResult(leader, leaderId), `新增部门${body.name}成功`);
}

export async function updateDept(ctx) {
  const body = ctx.body || {};
  const current = await ctx.db.get("SELECT * FROM sys_dept WHERE id = ?", [ctx.params.id]);
  if (!current) {
    await record(ctx, "修改部门", "dept", ctx.params.id, "失败");
    return ctx.fail("部门不存在");
  }
  const parentId = String(body.parentId ?? current.parent_id);
  if (parentId === current.id) {
    await record(ctx, "修改部门", "dept", current.id, "失败");
    return ctx.fail("上级部门不能是自己");
  }
  if (
    !deptInManage(ctx, current.id) ||
    (parentId !== String(current.parent_id) &&
      !(parentId === "0" ? isAdmin(ctx) || ctx.access?.scope?.all : deptInManage(ctx, parentId)))
  ) {
    await record(ctx, "修改部门", "dept", current.id, "失败");
    return ctx.fail("只能修改自己管理范围内的部门");
  }
  let place, leader, cameras;
  try {
    place = deptLocation(body, current);
    leader = await readLeader(ctx.db, body.leader, policyOf(ctx));
    // 不带 cameras 的旧表单不动原来的通道
    cameras = body.cameras === undefined ? null : validateCameras(body.cameras);
  } catch (error) {
    await record(ctx, "修改部门", "dept", current.id, "失败");
    return ctx.fail(error.message);
  }
  const denied = await checkDeptFields(ctx, body, current, { place, leader, cameras });
  if (denied) {
    await record(ctx, "修改部门", "dept", current.id, "失败");
    return ctx.fail(denied);
  }
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const leaderId = await inTransaction(ctx.db, async (db) => {
    const leaderId = leader.keep
      ? (current.leader_user_id ?? null)
      : leader.create
        ? await createLeader(db, current.id, leader.create)
        : leader.userId;
    await db.run(
      `UPDATE sys_dept SET parent_id = ?, name = ?, code = ?, type = ?, sort = ?, status = ?, address = ?, lng = ?, lat = ?, contact = ?, phone = ?, leader_user_id = ?, update_time = ? WHERE id = ?`,
      [
        parentId,
        body.name || current.name,
        body.code || current.code,
        DEPT_TYPES.includes(body.type) ? body.type : current.type || "公司",
        Number(body.sort ?? current.sort),
        Number(body.status ?? current.status),
        place.address,
        place.lng,
        place.lat,
        place.contact,
        place.phone,
        leaderId,
        now,
        current.id,
      ]
    );
    if (cameras)
      await db.run("UPDATE sys_dept SET cameras = ? WHERE id = ?", [
        JSON.stringify(cameras),
        current.id,
      ]);
    return leaderId;
  });
  await record(ctx, "修改部门", "dept", current.id, "成功");
  if (leader.create) await record(ctx, "新增用户（部门负责人）", "user", leaderId, "成功");
  ctx.ok(leaderResult(leader, leaderId), `修改部门${body.name || current.name}成功`);
}

export async function deleteDepts(ctx) {
  const ids = String(ctx.params.id || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!deptInManage(ctx, id)) {
      await record(ctx, "删除部门", "dept", id, "失败");
      return ctx.fail("只能删除自己管理范围内的部门");
    }
    const children = await ctx.db.get(
      "SELECT COUNT(*) AS total FROM sys_dept WHERE parent_id = ?",
      [id]
    );
    if (Number(children?.total || 0) > 0) {
      await record(ctx, "删除部门", "dept", id, "失败");
      return ctx.fail("请先删除下级部门");
    }
    const users = await ctx.db.get("SELECT COUNT(*) AS total FROM sys_user WHERE dept_id = ?", [
      id,
    ]);
    if (Number(users?.total || 0) > 0) {
      await record(ctx, "删除部门", "dept", id, "失败");
      return ctx.fail("部门下还有用户，不能删除");
    }
  }
  for (const id of ids) {
    await ctx.db.run("DELETE FROM sys_dept_perm WHERE dept_id = ?", [id]);
    await ctx.db.run("DELETE FROM sys_dept WHERE id = ?", [id]);
  }
  await record(ctx, "删除部门", "dept", ids.join(","), "成功");
  ctx.ok(null, "删除部门成功");
}

export async function listRoles(ctx) {
  // 每个角色有几个人：角色页保存权限前提示「拥有这个角色的 N 个人会受影响」
  const counts = new Map(
    (await ctx.db.all("SELECT role_id, COUNT(*) AS n FROM sys_user_role GROUP BY role_id")).map(
      (row) => [String(row.role_id), Number(row.n)]
    )
  );
  const rows = (await ctx.db.all("SELECT * FROM sys_role")).map((row) => ({
    ...toRole(row),
    userCount: counts.get(String(row.id)) || 0,
  }));
  const keywords = String(ctx.query.keywords || "").trim();
  const matched = rows
    .filter((item) => !keywords || item.name.includes(keywords) || item.code.includes(keywords))
    .sort((a, b) => a.sort - b.sort);
  ctx.ok(paginate(matched, ctx.query));
}

/** 人员表单里的角色选项。当前用户不能分配的标成 disabled，reason 说明原因。 */
export async function roleOptions(ctx) {
  const out = [];
  // 给哪个部门的人分配：部门有上限时，角色里超出的项不会生效（可以分配，只提示）
  const deptId = typeof ctx.query?.deptId === "string" ? ctx.query.deptId : "";
  const limit = deptId ? await resolveDeptLimit(ctx.db, deptId) : null;
  for (const row of await ctx.db.all("SELECT id, name, code, sort FROM sys_role ORDER BY sort")) {
    const reason = await cannotAssign(ctx, row.id);
    let cut = 0;
    if (limit?.perms && row.code !== "ADMIN")
      cut = (await permsOfRole(ctx.db, row)).filter((code) => !limit.perms.has(code)).length;
    out.push({
      value: Number(row.id),
      label: row.name,
      ...(reason ? { disabled: true, reason } : {}),
      ...(cut ? { cut } : {}),
    });
  }
  ctx.ok(out);
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
  if (!body.name || !body.code) {
    await record(ctx, "新增角色", "role", "", "失败");
    return ctx.fail("角色名称和编码不能为空");
  }
  const duplicated = await ctx.db.get("SELECT id FROM sys_role WHERE code = ?", [body.code]);
  if (duplicated) {
    await record(ctx, "新增角色", "role", "", "失败");
    return ctx.fail("角色编码已存在");
  }
  // 数据范围也是授权：没有「设置角色数据范围」时新角色只看本人，有也不能比自己宽
  let dataScope = 4;
  if (hasPerm(ctx, "sys:role:scope")) {
    dataScope = scopeRank(body.dataScope ?? 3);
    if (dataScope < (await myScopeRank(ctx))) {
      await record(ctx, "新增角色", "role", "", "失败");
      return ctx.fail("数据范围不能比你自己的宽");
    }
  }
  const id = await nextId(ctx.db, "sys_role");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await ctx.db.run(
    `INSERT INTO sys_role (id, name, code, data_scope, sort, status, create_time, update_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.name,
      body.code,
      dataScope,
      Number(body.sort) || 1,
      Number(body.status ?? 1),
      now,
      now,
    ]
  );
  await record(ctx, "新增角色", "role", id, "成功");
  ctx.ok(null, `新增角色${body.name}成功`);
}

export async function updateRole(ctx) {
  const body = ctx.body || {};
  const current = await ctx.db.get("SELECT * FROM sys_role WHERE id = ?", [ctx.params.id]);
  if (!current) {
    await record(ctx, "修改角色", "role", ctx.params.id, "失败");
    return ctx.fail("角色不存在");
  }
  const fail = async (message) => {
    await record(ctx, "修改角色", "role", current.id, "失败");
    return ctx.fail(message);
  };
  const admin = current.code === "ADMIN";
  if (admin && !isAdmin(ctx)) return fail("只有系统管理员可以修改系统管理员角色");
  const status = Number(body.status ?? current.status);
  if (admin && status !== 1) return fail("系统管理员角色不能停用");
  // 没有「编辑角色」：名称、排序、启停都不能改
  if (!hasPerm(ctx, "sys:role:update")) {
    const renamed = body.name != null && body.name !== current.name;
    const moved = body.sort != null && Number(body.sort) !== Number(current.sort);
    if (renamed || moved || status !== Number(current.status))
      return fail("没有「编辑角色」权限，只能改数据范围");
  }
  // 数据范围单独授权：要有「设置角色数据范围」，不能比自己宽；系统管理员固定全部数据
  const scope = body.dataScope == null ? scopeRank(current.data_scope) : scopeRank(body.dataScope);
  if (scope !== scopeRank(current.data_scope)) {
    if (admin) return fail("系统管理员固定是全部数据");
    if (!hasPerm(ctx, "sys:role:scope"))
      return fail("没有「设置角色数据范围」权限，不能改数据范围");
    if (scope < (await myScopeRank(ctx))) return fail("数据范围不能比你自己的宽");
  }
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  // 角色编码建好后不能改：权限默认值、系统管理员判断都按编码来
  await ctx.db.run(
    `UPDATE sys_role SET name = ?, data_scope = ?, sort = ?, status = ?, update_time = ? WHERE id = ?`,
    [
      body.name || current.name,
      scope === scopeRank(current.data_scope) ? current.data_scope : scope,
      Number(body.sort ?? current.sort),
      status,
      now,
      current.id,
    ]
  );
  await record(ctx, "修改角色", "role", current.id, "成功");
  ctx.ok(null, `修改角色${body.name || current.name}成功`);
}

export async function deleteRoles(ctx) {
  const ids = String(ctx.params.id || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const id of ids) {
    const role = await ctx.db.get("SELECT code FROM sys_role WHERE id = ?", [id]);
    if (role?.code === "ADMIN") {
      await record(ctx, "删除角色", "role", id, "失败");
      return ctx.fail("不能删除系统管理员");
    }
    if (role?.code === "HOME_SWITCH") {
      await record(ctx, "删除角色", "role", id, "失败");
      return ctx.fail("不能删除视角切换角色");
    }
    // 删角色等于从所有人身上收回它的权限：非管理员只能删权限不超过自己的角色
    const reason = role ? await cannotAssign(ctx, id, "删除") : "";
    if (reason) {
      await record(ctx, "删除角色", "role", id, "失败");
      return ctx.fail(reason);
    }
  }
  for (const id of ids) {
    await ctx.db.run("DELETE FROM sys_user_role WHERE role_id = ?", [id]);
    await ctx.db.run("DELETE FROM sys_role_perm WHERE role_id = ?", [id]);
    await ctx.db.run("DELETE FROM sys_role WHERE id = ?", [id]);
  }
  await record(ctx, "删除角色", "role", ids.join(","), "成功");
  ctx.ok(null, "删除角色成功");
}

/** 人员列表：非管理员只看到自己数据范围内的人。带账号安全状态：锁定、须改密、密码到期。 */
export async function listUsers(ctx) {
  const tree = await loadDeptTree(ctx.db);
  const roles = (await ctx.db.all("SELECT * FROM sys_role")).map(toRole);
  const policy = policyOf(ctx);
  const wechat = new Map(
    (await ctx.db.all("SELECT user_id, nickname FROM sys_user_wechat")).map((row) => [
      String(row.user_id),
      row.nickname || "",
    ])
  );
  const users = (await loadUsers(ctx.db))
    .filter((user) => userInScope(ctx, user))
    .map((user) => {
      const reason = passwordChangeReason(
        {
          must_change_password: user.mustChangePassword ? 1 : 0,
          password_changed_at: user.passwordChangedAt,
        },
        policy
      );
      return {
        ...user,
        passwordExpired: reason === "expired",
        wechatBound: wechat.has(String(user.id)),
        wechatNickname: wechat.get(String(user.id)) || "",
      };
    });
  const decorated = decorateUsers(users, tree, roles);
  ctx.ok(paginate(filterUsers(decorated, ctx.query, tree), ctx.query));
}

export async function userForm(ctx) {
  const users = await loadUsers(ctx.db);
  const row = users.find((item) => item.id === ctx.params.id);
  if (!row || !userInScope(ctx, row)) return ctx.fail("用户不存在");
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

/** 新建账号：密码按策略校验，不填就随机生成并只返回这一次。新账号首次登录必须改密。 */
export async function createUser(ctx) {
  const body = ctx.body || {};
  const fail = async (message) => {
    await record(ctx, "新增用户", "user", "", "失败");
    return ctx.fail(message);
  };
  if (body.avatar != null && body.avatar !== "") {
    await record(ctx, "新增用户", "user", "", "失败");
    return ctx.fail("头像上传未开通", "B0400", 400);
  }
  const username = String(body.username || "").trim();
  if (!username || !body.nickname || !body.deptId) return fail("用户名、姓名和部门不能为空");
  if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(username))
    return fail("用户名须为 3–64 位字母、数字或 _ . @ -");
  if (!userInScope(ctx, { dept_id: body.deptId }))
    return fail("只能在自己数据范围内的部门新建人员");
  const roleIds = Array.isArray(body.roleIds) ? [...new Set(body.roleIds.map(String))] : [];
  const roleProblem = await checkRoleChange(ctx, roleIds, []);
  if (roleProblem) return fail(roleProblem);
  if (await ctx.db.get("SELECT id FROM sys_user WHERE username = ?", [username]))
    return fail("用户名已存在");
  let password = typeof body.password === "string" ? body.password : "";
  const generated = !password;
  if (generated) password = randomPassword();
  else {
    const problem = checkPassword(password, policyOf(ctx));
    if (problem) return fail(problem);
  }
  const id = await nextId(ctx.db, "sys_user");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  const { hashPassword } = await import("./auth.js");
  await ctx.db.run(
    `INSERT INTO sys_user
      (id, username, nickname, password_hash, dept_id, status, mobile, gender, email, avatar, create_time, update_time, must_change_password, password_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      id,
      username,
      body.nickname,
      hashPassword(password),
      String(body.deptId),
      Number(body.status ?? 1),
      body.mobile || null,
      body.gender ?? null,
      body.email || "",
      "",
      now,
      now,
      new Date().toISOString(),
    ]
  );
  for (const roleId of roleIds) {
    await ctx.db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", [id, roleId]);
  }
  await record(ctx, "新增用户", "user", id, "成功");
  ctx.ok({ id, username, password: generated ? password : "" }, `新增用户${body.nickname}成功`);
}

export async function updateUser(ctx) {
  const body = ctx.body || {};
  if (body.avatar != null && body.avatar !== "") {
    await record(ctx, "修改用户", "user", ctx.params.id, "失败");
    return ctx.fail("头像上传未开通", "B0400", 400);
  }
  const guard = await guardUser(ctx, ctx.params.id);
  if (guard.error) {
    await record(ctx, "修改用户", "user", ctx.params.id, "失败");
    return ctx.fail(guard.error);
  }
  const current = guard.user;
  if (body.deptId && !userInScope(ctx, { dept_id: body.deptId }))
    return ctx.fail("只能把人员放到自己数据范围内的部门");
  // 表单总会带上 roleIds；和现在一样就不算分配角色，没有「给人员分配角色」也能改别的资料
  let roleIds = null;
  if (Array.isArray(body.roleIds)) {
    const before = (
      await ctx.db.all("SELECT role_id FROM sys_user_role WHERE user_id = ?", [current.id])
    ).map((row) => String(row.role_id));
    roleIds = [...new Set(body.roleIds.map(String))];
    const problem = await checkRoleChange(ctx, roleIds, before);
    if (problem) {
      await record(ctx, "修改用户", "user", current.id, "失败");
      return ctx.fail(problem);
    }
    if (roleIds.length === before.length && roleIds.every((id) => before.includes(id)))
      roleIds = null;
  }
  const nextStatus = Number(body.status ?? current.status);
  if (String(current.id) === String(ctx.user?.id) && nextStatus !== 1)
    return ctx.fail("不能停用自己的账号");
  // 一个动作一个权限：改资料要「编辑人员资料」，改状态要「停用与启用账号」，改角色要「给人员分配角色」（上面已查）
  if (nextStatus !== Number(current.status)) {
    const perm = nextStatus === 1 ? "sys:user:enable" : "sys:user:disable";
    if (!hasPerm(ctx, perm)) return ctx.fail(`没有「${permLabelOf(perm)}」权限`);
  }
  const edited =
    (body.nickname != null && body.nickname !== current.nickname) ||
    (body.deptId != null && String(body.deptId) !== String(current.dept_id)) ||
    (body.mobile !== undefined && (body.mobile || null) !== (current.mobile || null)) ||
    (body.gender !== undefined && body.gender !== current.gender) ||
    (body.email !== undefined && (body.email || "") !== (current.email || ""));
  if (edited && !hasPerm(ctx, "sys:user:update")) return ctx.fail("没有「编辑人员资料」权限");
  const action =
    nextStatus !== Number(current.status) ? (nextStatus === 1 ? "激活" : "停用") : "修改用户";
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  // 停用时让已有登录立即失效
  const stopping = nextStatus !== 1 && Number(current.status) === 1;
  await ctx.db.run(
    `UPDATE sys_user
     SET nickname = ?, dept_id = ?, status = ?, mobile = ?, gender = ?, email = ?, update_time = ?, session_version = session_version + ?
     WHERE id = ?`,
    [
      body.nickname || current.nickname,
      String(body.deptId || current.dept_id),
      nextStatus,
      body.mobile || null,
      body.gender ?? current.gender,
      body.email ?? current.email,
      now,
      stopping ? 1 : 0,
      current.id,
    ]
  );
  if (stopping) ctx.invalidateSessions?.(String(current.id));
  if (roleIds) {
    await ctx.db.run("DELETE FROM sys_user_role WHERE user_id = ?", [current.id]);
    for (const roleId of roleIds) {
      await ctx.db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", [
        current.id,
        roleId,
      ]);
    }
    // 角色变了，权限跟着变：让这个人已有的登录重新取权限
    ctx.invalidateSessions?.(String(current.id));
    await record(ctx, "分配角色", "user", current.id, "成功");
  }
  await record(ctx, action, "user", current.id, "成功");
  ctx.ok(null, `修改用户${body.nickname || current.nickname}成功`);
}

export async function deleteUsers(ctx) {
  const ids = String(ctx.params.id || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (String(id) === String(ctx.user?.id)) return ctx.fail("不能删除自己的账号");
    if (await hasAdminRole(ctx.db, id)) {
      const admins = await ctx.db.get(
        "SELECT COUNT(*) AS n FROM sys_user_role ur JOIN sys_role r ON r.id = ur.role_id WHERE r.code = 'ADMIN'"
      );
      if (!isAdmin(ctx) || Number(admins?.n || 0) <= 1) {
        await record(ctx, "删除用户", "user", id, "失败");
        return ctx.fail(
          Number(admins?.n || 0) <= 1
            ? "不能删除最后一个系统管理员"
            : "只有系统管理员可以删除系统管理员"
        );
      }
    }
    const guard = await guardUser(ctx, id);
    if (guard.error) return ctx.fail(guard.error);
  }
  for (const id of ids) {
    await ctx.db.run("DELETE FROM sys_user_role WHERE user_id = ?", [id]);
    await ctx.db.run("DELETE FROM sys_user WHERE id = ?", [id]);
    await ctx.db.run("UPDATE sys_dept SET leader_user_id = NULL WHERE leader_user_id = ?", [id]);
    ctx.invalidateSessions?.(String(id));
  }
  await record(ctx, "删除用户", "user", ids.join(","), "成功");
  ctx.ok(null, "删除用户成功");
}

/** 重置密码：填了按策略校验，不填随机生成并只返回这一次；重置后下次登录必须改密，已有登录全部失效。 */
export async function resetPassword(ctx) {
  const guard = await guardUser(ctx, ctx.params.id);
  if (guard.error) return ctx.fail(guard.error);
  let password = String(ctx.body?.password ?? ctx.query.password ?? "");
  const generated = !password;
  if (generated) password = randomPassword();
  else {
    const problem = checkPassword(password, policyOf(ctx));
    if (problem) {
      await record(ctx, "重置密码", "user", ctx.params.id, "失败");
      return ctx.fail(problem);
    }
  }
  const { hashPassword } = await import("./auth.js");
  await ctx.db.run(
    "UPDATE sys_user SET password_hash = ?, must_change_password = 1, password_changed_at = ?, failed_count = 0, locked_until = '', session_version = session_version + 1 WHERE id = ?",
    [hashPassword(password), new Date().toISOString(), ctx.params.id]
  );
  ctx.invalidateSessions?.(String(ctx.params.id));
  await record(ctx, "重置密码", "user", ctx.params.id, "成功");
  ctx.ok({ password: generated ? password : "" }, "已重置，该账号下次登录需要改密");
}

/** 强制下次登录改密，不改现在的密码，也不踢下线。 */
export async function forcePasswordChange(ctx) {
  const guard = await guardUser(ctx, ctx.params.id);
  if (guard.error) return ctx.fail(guard.error);
  await ctx.db.run("UPDATE sys_user SET must_change_password = 1 WHERE id = ?", [ctx.params.id]);
  await record(ctx, "强制改密", "user", ctx.params.id, "成功");
  ctx.ok(null, "该账号下次操作时需要先修改密码");
}

/**
 * 免除首次改密：给小程序审核、演示这类多人共用的账号用，否则第一个人登录改了密码，后面的人就进不来。
 * 只有系统管理员能做，记操作日志；不改密码，也不踢下线。
 */
export async function skipPasswordChange(ctx) {
  if (!isAdmin(ctx)) return ctx.fail("只有系统管理员可以免除改密");
  const guard = await guardUser(ctx, ctx.params.id);
  if (guard.error) return ctx.fail(guard.error);
  await ctx.db.run(
    "UPDATE sys_user SET must_change_password = 0, password_changed_at = ? WHERE id = ?",
    [new Date().toISOString(), ctx.params.id]
  );
  await record(ctx, "免除改密", "user", ctx.params.id, "成功");
  ctx.ok(null, "该账号登录后不再要求改密");
}

export async function unlockUser(ctx) {
  const guard = await guardUser(ctx, ctx.params.id);
  if (guard.error) return ctx.fail(guard.error);
  await ctx.db.run("UPDATE sys_user SET failed_count = 0, locked_until = '' WHERE id = ?", [
    ctx.params.id,
  ]);
  await record(ctx, "解锁账号", "user", ctx.params.id, "成功");
  ctx.ok(null, "已解锁");
}

/** 强制下线：会话版本加一，已签发的令牌全部失效，实时连接断开；微信绑定一并解除，免得小程序又自动登录回来。 */
export async function kickUser(ctx) {
  const guard = await guardUser(ctx, ctx.params.id);
  if (guard.error) return ctx.fail(guard.error);
  if (String(ctx.params.id) === String(ctx.user?.id))
    return ctx.fail("不能让自己下线，请直接退出登录");
  await ctx.db.run("UPDATE sys_user SET session_version = session_version + 1 WHERE id = ?", [
    ctx.params.id,
  ]);
  await ctx.db.run("DELETE FROM sys_user_wechat WHERE user_id = ?", [String(ctx.params.id)]);
  ctx.invalidateSessions?.(String(ctx.params.id));
  await record(ctx, "强制下线", "user", ctx.params.id, "成功");
  ctx.ok(null, "已强制下线");
}

/** 解绑微信：手机丢了或换人用时，管理员解掉，之后要重新输账号密码才能在小程序登录。 */
export async function unbindWechat(ctx) {
  const guard = await guardUser(ctx, ctx.params.id);
  if (guard.error) return ctx.fail(guard.error);
  await ctx.db.run("DELETE FROM sys_user_wechat WHERE user_id = ?", [String(ctx.params.id)]);
  await record(ctx, "解绑微信", "user", ctx.params.id, "成功");
  ctx.ok(null, "已解绑微信");
}

/** 新角色页：权限分组目录（只有权限码和文字），以及当前密码规则说明。 */
export async function permCatalog(ctx) {
  ctx.ok({
    modules: PERM_MODULES,
    tiers: TIER_LABELS,
    groups: PERM_GROUPS,
    templates: ROLE_TEMPLATES,
    passwordRule: describePolicy(policyOf(ctx)),
  });
}

/* ---------------- 部门权限上限 ---------------- */

const SCOPE_TEXT = { 1: "全部数据", 2: "本单位及下级", 3: "本单位", 4: "仅本人" };

/**
 * 部门的权限上限：自己的设置、上级的实际上限（下级只能在这个范围里勾）、自己的实际上限，
 * 以及当前用户能动哪些项（自己可转授的、且在上级范围里的）。
 */
export async function deptLimit(ctx) {
  const dept = await ctx.db.get("SELECT * FROM sys_dept WHERE id = ?", [ctx.params.id]);
  if (!dept) return ctx.fail("部门不存在");
  const own = (
    await ctx.db.all("SELECT perm FROM sys_dept_perm WHERE dept_id = ?", [String(dept.id)])
  ).map((row) => String(row.perm));
  const parent =
    String(dept.parent_id) === "0"
      ? { perms: null, maxScope: null, chain: [] }
      : await resolveDeptLimit(ctx.db, dept.parent_id);
  const effective = await resolveDeptLimit(ctx.db, dept.id);
  const users = Number(
    (await ctx.db.get("SELECT COUNT(*) AS n FROM sys_user WHERE dept_id = ?", [String(dept.id)])).n
  );
  const editable = hasPerm(ctx, "sys:dept:limit") && deptInManage(ctx, dept.id);
  const assignable = !editable ? [] : isAdmin(ctx) ? null : [...(ctx.access?.grantable || [])];
  ctx.ok({
    id: String(dept.id),
    name: dept.name,
    limited: Number(dept.perm_limited) === 1,
    perms: own,
    maxScope: dept.max_data_scope == null ? null : scopeRank(dept.max_data_scope),
    parent: {
      perms: parent.perms ? [...parent.perms] : null,
      maxScope: parent.maxScope,
      chain: parent.chain,
    },
    effective: {
      perms: effective.perms ? [...effective.perms] : null,
      maxScope: effective.maxScope,
    },
    users,
    editable,
    assignable,
    reasons: editable ? lockReasons(ctx) : {},
    myScope: await myScopeRank(ctx),
  });
}

/**
 * 保存部门权限上限。和云平台的服务控制策略一样只封顶不授权：
 * - 勾的项必须在上级部门的实际上限里，最大数据范围不比上级宽；
 * - 非管理员：部门要在自己管理范围里；改动的项都要是自己可转授的；最大数据范围不比自己宽；
 *   改成「跟上级一样」等于放开到上级的范围，要能转授上级范围里的每一项。
 */
export async function saveDeptLimit(ctx) {
  const dept = await ctx.db.get("SELECT * FROM sys_dept WHERE id = ?", [ctx.params.id]);
  if (!dept) return ctx.fail("部门不存在");
  const fail = async (message) => {
    await record(ctx, "设置部门权限上限", "dept", dept.id, "失败");
    return ctx.fail(message);
  };
  if (!deptInManage(ctx, dept.id)) return fail("只能设置自己管理范围内的部门");
  const known = new Set(ALL_PERMS.map((item) => item.code));
  const limited = Boolean(ctx.body?.limited);
  const codes = [
    ...new Set(
      (Array.isArray(ctx.body?.perms) ? ctx.body.perms : []).filter((code) => known.has(code))
    ),
  ];
  const maxScope =
    ctx.body?.maxScope == null || ctx.body.maxScope === "" ? null : scopeRank(ctx.body.maxScope);
  const parent =
    String(dept.parent_id) === "0"
      ? { perms: null, maxScope: null }
      : await resolveDeptLimit(ctx.db, dept.parent_id);
  if (limited && parent.perms) {
    const beyond = codes.filter((code) => !parent.perms.has(code));
    if (beyond.length)
      return fail(
        `上级部门没有这几项，下级不能勾：${beyond.slice(0, 5).map(permLabelOf).join("、")}${beyond.length > 5 ? "，共 " + beyond.length + " 项" : ""}`
      );
  }
  if (maxScope != null && parent.maxScope != null && maxScope < parent.maxScope)
    return fail(`最大数据范围不能比上级部门的「${SCOPE_TEXT[parent.maxScope]}」宽`);
  if (!isAdmin(ctx)) {
    // 收紧（收回）只会让下级权力变小，管理范围里的部门都可以；放开（这个部门原来用不了、现在能用）要自己可转授
    const wasLimited = Number(dept.perm_limited) === 1;
    const before = new Set(
      (await ctx.db.all("SELECT perm FROM sys_dept_perm WHERE dept_id = ?", [String(dept.id)])).map(
        (row) => String(row.perm)
      )
    );
    const parentAll = parent.perms ? [...parent.perms] : ALL_PERMS.map((item) => item.code);
    const usable = wasLimited
      ? new Set(parentAll.filter((code) => before.has(code)))
      : new Set(parentAll);
    const after = limited ? codes : parentAll;
    const opened = after.filter((code) => !usable.has(code));
    const beyond = opened.filter((code) => !canPass(ctx, code));
    if (beyond.length)
      return fail(
        `这几项你不能转授，不能放开：${beyond.slice(0, 5).map(permLabelOf).join("、")}${beyond.length > 5 ? "，共 " + beyond.length + " 项" : ""}`
      );
    // 最大数据范围放宽时不能比自己的宽
    const mine = await myScopeRank(ctx);
    const was = dept.max_data_scope == null ? null : scopeRank(dept.max_data_scope);
    const widened = maxScope == null ? was != null : was != null && maxScope < was;
    if (widened && (maxScope == null ? (parent.maxScope ?? 1) < mine : maxScope < mine))
      return fail("最大数据范围不能比你自己的宽");
    if (maxScope != null && maxScope < mine) return fail("最大数据范围不能比你自己的宽");
  }
  await inTransaction(ctx.db, async (db) => {
    await db.run("UPDATE sys_dept SET perm_limited = ?, max_data_scope = ? WHERE id = ?", [
      limited ? 1 : 0,
      maxScope,
      String(dept.id),
    ]);
    if (limited) {
      await db.run("DELETE FROM sys_dept_perm WHERE dept_id = ?", [String(dept.id)]);
      for (const code of codes)
        await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES (?, ?)", [
          String(dept.id),
          code,
        ]);
    }
  });
  await record(ctx, "设置部门权限上限", "dept", dept.id, "成功");
  ctx.ok(
    null,
    limited
      ? `已保存【${dept.name}】的权限上限：最多 ${codes.length} 项`
      : `【${dept.name}】改成跟上级一样`
  );
}

/**
 * 一个人的实际权限，逐项说明来源：哪些角色给的、有没有被哪一级部门的上限挡住；数据范围怎么算出来的。
 */
export async function effectivePerms(ctx) {
  const user = await ctx.db.get("SELECT * FROM sys_user WHERE id = ?", [String(ctx.params.id)]);
  if (!user || !userInScope(ctx, user)) return ctx.fail("用户不存在或不在你的管理范围内");
  const access = await resolveAccess(ctx.db, user);
  const roles = await ctx.db.all(
    "SELECT r.id, r.name, r.code, r.data_scope, r.status FROM sys_role r JOIN sys_user_role ur ON ur.role_id = r.id WHERE ur.user_id = ?",
    [String(user.id)]
  );
  const active = roles.filter((role) => Number(role.status) === 1);
  const admin = active.some((role) => role.code === "ADMIN");
  const fromRoles = new Map();
  for (const role of active) {
    const codes =
      role.code === "ADMIN"
        ? ALL_PERMS.map((item) => item.code)
        : (
            await ctx.db.all("SELECT perm FROM sys_role_perm WHERE role_id = ?", [String(role.id)])
          ).map((row) => String(row.perm));
    for (const code of codes) {
      if (!fromRoles.has(code)) fromRoles.set(code, []);
      fromRoles.get(code).push(role.name);
    }
  }
  const chain = access.limit?.chain || [];
  const cutBy = (code) =>
    chain.find((dept) => dept.limited && !(dept.perms || []).includes(code))?.name || "";
  const items = ALL_PERMS.map((perm) => {
    const roleNames = fromRoles.get(perm.code) || [];
    const blocked = roleNames.length && !access.perms.has(perm.code) ? cutBy(perm.code) : "";
    return {
      code: perm.code,
      has: access.perms.has(perm.code),
      roles: roleNames,
      cutBy: blocked,
      grantable: access.grantable.has(perm.code),
    };
  });
  const roleScope = active.length
    ? Math.min(...active.map((role) => scopeRank(role.data_scope)))
    : 4;
  const cap = access.limit?.maxScope ?? null;
  ctx.ok({
    user: { id: String(user.id), name: user.nickname, username: user.username },
    admin,
    roles: roles.map((role) => ({
      id: String(role.id),
      name: role.name,
      active: Number(role.status) === 1,
      scope: SCOPE_TEXT[scopeRank(role.data_scope)],
    })),
    chain: chain.map((dept) => ({
      id: dept.id,
      name: dept.name,
      limited: dept.limited,
      count: dept.perms ? dept.perms.length : null,
      maxScope: dept.maxScope == null ? "" : SCOPE_TEXT[dept.maxScope],
    })),
    scope: {
      roles: SCOPE_TEXT[roleScope],
      cap: cap == null ? "" : SCOPE_TEXT[cap],
      effective: SCOPE_TEXT[admin ? 1 : cap == null ? roleScope : Math.max(roleScope, cap)],
    },
    items,
  });
}

/**
 * 角色的权限：codes 拥有的权限码，grantOption 其中开了「可转授」的；
 * assignable 是当前用户能勾、能取消、能改可转授的权限码（自己可转授的），null 表示全部（系统管理员），
 * 没有「给角色分配权限」时是空数组。
 */
export async function rolePerms(ctx) {
  const role = await ctx.db.get("SELECT id, code FROM sys_role WHERE id = ?", [ctx.params.id]);
  if (!role) return ctx.fail("角色不存在");
  const assignable = !hasPerm(ctx, "sys:role:grant")
    ? []
    : isAdmin(ctx)
      ? null
      : [...(ctx.access?.grantable || [])];
  if (role.code === "ADMIN") {
    const all = ALL_PERMS.map((item) => item.code);
    return ctx.ok({ codes: all, grantOption: all, fixed: true, assignable, reasons: {} });
  }
  const rows = await ctx.db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id = ?", [
    String(role.id),
  ]);
  const reasons = hasPerm(ctx, "sys:role:grant") ? lockReasons(ctx) : {};
  ctx.ok({
    codes: rows.map((row) => String(row.perm)),
    grantOption: rows.filter((row) => Number(row.grantable) === 1).map((row) => String(row.perm)),
    fixed: false,
    assignable,
    reasons,
  });
}

/**
 * 按权限码保存，未知的码丢掉。codes 是拥有的，grantOption 是其中开「可转授」的（不传时保留原来的开关）。
 * 非管理员只能动自己「可转授」的权限：加上、拿掉、开关可转授都算；
 * 只比较这次变了的，角色上原来就有、自己不能转授的权限保持不动也能保存。
 */
export async function saveRolePerms(ctx) {
  const role = await ctx.db.get("SELECT id, code, name FROM sys_role WHERE id = ?", [
    ctx.params.id,
  ]);
  if (!role) return ctx.fail("角色不存在");
  if (role.code === "ADMIN") return ctx.fail("系统管理员固定拥有全部权限");
  const known = new Set(ALL_PERMS.map((item) => item.code));
  const wanted = Array.isArray(ctx.body?.codes) ? ctx.body.codes : [];
  const codes = [...new Set(wanted.filter((code) => known.has(code)))];
  const rows = await ctx.db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id = ?", [
    String(role.id),
  ]);
  const before = new Set(rows.map((row) => String(row.perm)));
  const passedBefore = new Set(
    rows.filter((row) => Number(row.grantable) === 1).map((row) => String(row.perm))
  );
  const passed = new Set(
    Array.isArray(ctx.body?.grantOption)
      ? ctx.body.grantOption.filter((code) => codes.includes(code))
      : codes.filter((code) => passedBefore.has(code))
  );
  if (!isAdmin(ctx)) {
    const changed = new Set([
      ...codes.filter((code) => !before.has(code)),
      ...[...before].filter((code) => known.has(code) && !codes.includes(code)),
      ...codes.filter((code) => before.has(code) && passed.has(code) !== passedBefore.has(code)),
    ]);
    const beyond = [...changed].filter((code) => !canPass(ctx, code));
    if (beyond.length) {
      await record(ctx, "分配角色权限", "role", role.id, "失败");
      return ctx.fail(
        `这几项你不能转授，不能授予、收回或改可转授：${beyond.map(permLabelOf).join("、")}`
      );
    }
  }
  await inTransaction(ctx.db, async (db) => {
    await db.run("DELETE FROM sys_role_perm WHERE role_id = ?", [String(role.id)]);
    for (const code of codes)
      await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES (?, ?, ?)", [
        String(role.id),
        code,
        passed.has(code) ? 1 : 0,
      ]);
  });
  await record(ctx, "分配角色权限", "role", role.id, "成功");
  ctx.ok(null, `已保存【${role.name}】的 ${codes.length} 项权限，其中 ${passed.size} 项可转授`);
}
