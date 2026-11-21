import {
  buildDeptTree,
  DATA_SCOPE_LABEL,
  decorateUsers,
  filterDeptTree,
  filterUsers,
  paginate,
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
import { menuPreviewFor } from "./menus.js";
import { operationScope } from "./src/log/operationLog.js";
import { formatTimestamp } from "./src/domain/Clock.js";
import {
  checkPassword,
  describePolicy,
  lockedMinutes,
  passwordChangeReason,
  SECURITY_DEFAULTS,
} from "./src/settings/securityConfig.js";

/* 组织简化（B1b）：部门类型只有 公司/检测站。分公司＝公司类型（自采）；
   检测站全局唯一且必须属总公司子树，送到这里的任务签收后要逐台扫码「开始检测」，总览里单列。 */
const DEPT_TYPES = ["公司", "检测站"];
const policyOf = (ctx) => ctx.security || SECURITY_DEFAULTS;
// #26 m-01：fail-closed——access 缺失一律按非管理员处理（旧写法 !ctx.access 恒真兜底是 fail-open 残留）。
// HTTP 路径全部 auth:true 且 dispatcher 先 requireAccess 再进 handler，正常请求必带 access；
// 未来新增路由/直调 handler 漏挂 access 时不再全量放行。与 hasPerm/canPass 的 ctx.access?. 写法同口径。
const isAdmin = (ctx) => Boolean(ctx.access?.roles?.includes("ADMIN"));
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
/**
 * #26 B1：范围类拒绝统一带码，和 sample 侧同口径（task-handover-scope 的 A0301/A0404）。
 * denyPerm = 没有这项权限/不能转授（A0301/403）；denyScope = 数据范围外（A0404/404，不泄露存在性）。
 */
const denyPerm = (ctx, msg) => ctx.fail(msg, "A0301", 403);
const denyScope = (ctx, msg) => ctx.fail(msg, "A0404", 404);
/**
 * 把 userInScope 的条件翻译成 SQL（L-P2-3）：可管单位里的人，加上自己。
 * 和 JS 版严格对齐——JS 里 NULL 部门算成空串，所以空串在范围内时要连 NULL 一起放行，
 * 免得提前筛把人筛没了、JS 权威判定却看不到了。
 */
function userScopeSql(scope, selfId) {
  if (!scope || scope.all) return { sql: "", params: [] };
  const ids = manageIds(scope).map(String);
  const parts = [];
  const params = [];
  if (ids.length) {
    parts.push(`dept_id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
    if (ids.includes("")) parts.push("dept_id IS NULL");
  }
  const self = String(selfId ?? "");
  if (self) {
    parts.push("id = ?");
    params.push(self);
  }
  if (!parts.length) return { sql: " WHERE 1 = 0", params };
  return { sql: ` WHERE ${parts.join(" OR ")}`, params };
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
/** 数据范围宽度比较用：1 全部、2 本单位及下级、3 本单位、4 仅本人。自定义 5 按本单位宽度参与比较（D3 另查）。 */
function scopeRank(value) {
  const n = Number(value);
  if (n === 5) return 3;
  return n >= 1 && n <= 4 ? n : 4;
}
/** 保留原始 5（自定义）的取值：写库/回显用，宽度比较仍走 scopeRank。 */
function rawScope(value) {
  const n = Number(value);
  return n === 5 ? 5 : scopeRank(value);
}
/** 角色的自定义部门（sys_role_dept）。旧库没有这张表时按空算。 */
async function roleDeptIdsOf(db, roleId) {
  try {
    return (
      await db.all("SELECT dept_id FROM sys_role_dept WHERE role_id = ?", [String(roleId)])
    ).map((row) => String(row.dept_id));
  } catch {
    return [];
  }
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
  // #26 D3：自定义范围（5）只有 scope≤2 的角色能授，且自定义部门要在自己的管理范围里
  if (Number(role.data_scope) === 5) {
    if ((await myScopeRank(ctx)) > 2)
      return `「${role.name}」是自定义数据范围，只有「本单位及下级」以上数据范围的角色能${verb}`;
    const picked = await roleDeptIdsOf(ctx.db, role.id);
    const mine = new Set(manageIds(ctx.access?.scope || {}).map(String));
    if (!ctx.access?.scope?.all && picked.some((id) => !mine.has(String(id))))
      return `「${role.name}」的自定义部门超出你的管理范围，不能${verb}`;
  }
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
/** 管人员前的共同检查：用户存在、在范围里、非管理员不能动管理员。失败返回原因和错误码（B1 带码）。 */
async function guardUser(ctx, id) {
  const user = await ctx.db.get("SELECT * FROM sys_user WHERE id = ?", [String(id)]);
  if (!user) return { error: "用户不存在", code: "A0404", status: 404 };
  if (!userInScope(ctx, user))
    return { error: "只能管理自己数据范围内的人员", code: "A0404", status: 404 };
  if (!isAdmin(ctx) && (await hasAdminRole(ctx.db, user.id)))
    return { error: "只有系统管理员可以管理系统管理员账号", code: "A0301", status: 403 };
  return { user };
}
import { readCoords, readDeptLocation } from "./src/geo/place.js";
import { randomBytes } from "node:crypto";
import { camerasAllowed, readCameras, validateCameras } from "./src/settings/deptCameras.js";
import { isUnderHq, otherStation } from "./src/settings/boxConfig.js";
import { badRequest, conflict } from "./src/domain/AppError.js";

async function record(ctx, action, targetType, targetId, result, detail) {
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
      // #26 B4：授权审计明细（grant diff / 范围前后 / 自定义部门 diff），落 sys_operation_log.detail
      detail,
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
  if (typeof input !== "object" || Array.isArray(input)) throw badRequest("负责人格式不正确");
  if (input.userId != null && input.userId !== "") {
    const user = await db.get("SELECT id FROM sys_user WHERE id = ? AND status = 1", [
      String(input.userId),
    ]);
    if (!user) throw badRequest("负责人不存在或已停用");
    return { userId: String(user.id) };
  }
  const spec = input.create;
  if (!spec || typeof spec !== "object") return { userId: null };
  const nickname = typeof spec.nickname === "string" ? spec.nickname.trim() : "";
  const username = typeof spec.username === "string" ? spec.username.trim() : "";
  if (!nickname || nickname.length > 64) throw badRequest("请填写负责人姓名");
  if (!/^[A-Za-z0-9_.@-]{3,64}$/.test(username))
    throw badRequest("用户名须为 3–64 位字母、数字或 _ . @ -");
  if (await db.get("SELECT id FROM sys_user WHERE username = ?", [username]))
    throw conflict("用户名已存在");
  const mobile = typeof spec.mobile === "string" ? spec.mobile.trim() : "";
  if (mobile.length > 32) throw badRequest("手机号格式不正确");
  const roleIds = Array.isArray(spec.roleIds)
    ? [...new Set(spec.roleIds.map(String))].slice(0, 10)
    : [];
  for (const roleId of roleIds) {
    if (!(await db.get("SELECT id FROM sys_role WHERE id = ?", [roleId])))
      throw badRequest("角色不存在");
  }
  let password = typeof spec.password === "string" ? spec.password : "";
  const generated = !password;
  if (generated) password = randomPassword();
  else {
    const problem = checkPassword(password, policy);
    if (problem) throw badRequest(`初始密码不符合要求：${problem}`);
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

/**
 * 组织简化（B1b）：类型＝检测站时校验全局唯一＋属总公司子树。
 * selfId 新建时为空；parentId 是（新）上级部门——新建看上级链、编辑看改挂后的链。
 * 返回失败原因或空串。
 */
async function checkStationType(ctx, type, parentId, selfId = "") {
  if (type !== "检测站") return "";
  const rows = await ctx.db.all("SELECT id, parent_id, sort, status, type FROM sys_dept");
  if (!isUnderHq(rows, selfId, parentId))
    return "检测站必须属总公司子树：请挂在总公司（或其下级部门）下面";
  const other = await otherStation(ctx.db, selfId);
  if (other) return `检测站全局唯一：「${other.name}」已是检测站，请先把它改回公司再设置本部门`;
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

/**
 * 人员列表要用的列（L-P2-3）。写明白，不再 SELECT *：
 * password_hash、salt、secret_key 这些凭据列根本不会进内存，也就没法被下一层的字段映射漏出去。
 */
const USER_COLUMNS = [
  "id",
  "username",
  "nickname",
  "email",
  "status",
  "dept_id",
  "must_change_password",
  "locked_until",
  "password_changed_at",
  "mobile",
  "gender",
  "avatar",
  "create_time",
];

/**
 * 读取人员。给了 scope 时把可见范围（可管单位 + 自己）下推到 SQL（L-P2-3），
 * userInScope 仍是权威判定，SQL 只做提前筛；两者结果一致。
 */
async function loadUsers(db, scope, selfId) {
  const where = userScopeSql(scope, selfId);
  const rows = await db.all(
    `SELECT ${USER_COLUMNS.join(", ")} FROM sys_user${where.sql}`,
    where.params
  );
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

/**
 * #26 B1（D2）：部门读的可见集 = manageOrgIds 子树 + 祖先只读壳。
 * 返回 null 表示不限（管理员/全部数据）；否则返回可见 id 集合。
 * 祖先壳保留组织上下文（名称/编码/层级），但不下发地址、联系人、负责人、监控这些明细。
 */
function readScopeIds(scope, tree) {
  if (!scope || scope.all) return null;
  const parent = new Map();
  const walk = (n) => {
    parent.set(String(n.id), String(n.parentId ?? ""));
    (n.children || []).forEach(walk);
  };
  (tree || []).forEach(walk);
  const allowed = new Set();
  for (const id of scope.manageOrgIds || []) {
    let cur = String(id);
    const seen = new Set();
    while (cur && cur !== "0" && !seen.has(cur)) {
      seen.add(cur);
      allowed.add(cur);
      cur = parent.get(cur);
    }
  }
  return allowed;
}

/** 祖先壳节点：只留组织上下文，明细清空，readOnly 告诉页面这不是可维护的部门。 */
function shellDept(node) {
  return {
    ...node,
    address: "",
    lng: null,
    lat: null,
    contact: "",
    phone: "",
    leaderUserId: "",
    leaderName: "",
    leaderMobile: "",
    cameras: [],
    readOnly: true,
  };
}

function scopeDeptTree(tree, scope) {
  const allowed = readScopeIds(scope, tree);
  if (!allowed) return tree;
  const manage = new Set((scope.manageOrgIds || []).map(String));
  const filter = (nodes) =>
    (nodes || [])
      .filter((n) => allowed.has(String(n.id)))
      .map((n) => {
        const children = filter(n.children);
        return manage.has(String(n.id)) ? { ...n, children } : shellDept({ ...n, children });
      });
  return filter(tree);
}

/** 选项树带上 readOnly（祖先壳不可选为归属/目标）；形状与 toDeptOptions 兼容。 */
function scopedDeptOptions(nodes) {
  return (nodes || []).map((node) => ({
    value: node.id,
    label: node.name,
    // R13：公司策略中心的公司选择器按 type 过滤顶级公司（additive 键，旧消费方不受影响）
    ...(node.type ? { type: node.type } : {}),
    ...(node.readOnly ? { readOnly: true } : {}),
    ...(node.children?.length ? { children: scopedDeptOptions(node.children) } : {}),
  }));
}

export async function listDepts(ctx) {
  ctx.ok(scopeDeptTree(filterDeptTree(await loadDeptTree(ctx.db), ctx.query), ctx.access?.scope));
}

export async function deptOptions(ctx) {
  ctx.ok(scopedDeptOptions(scopeDeptTree(await loadDeptTree(ctx.db), ctx.access?.scope)));
}

export async function deptForm(ctx) {
  const row = await ctx.db.get(`${DEPT_WITH_LEADER} WHERE d.id = ?`, [ctx.params.id]);
  // null = 不限；非 null 时不在可见集里一律 404，不泄露范围外部门的存在
  const allowed = readScopeIds(ctx.access?.scope, await loadDeptTree(ctx.db));
  if (!row || (allowed && !allowed.has(String(row.id))))
    return ctx.fail("部门不存在", "A0404", 404);
  const item = toDept(row);
  const readOnly = !deptInManage(ctx, item.id);
  const detail = readOnly ? shellDept(item) : item;
  ctx.ok({
    id: detail.id,
    name: detail.name,
    code: detail.code,
    parentId: detail.parentId,
    type: detail.type,
    status: detail.status,
    sort: detail.sort,
    address: detail.address,
    lng: detail.lng,
    lat: detail.lat,
    contact: detail.contact,
    phone: detail.phone,
    leaderUserId: detail.leaderUserId,
    leaderName: detail.leaderName,
    leaderMobile: detail.leaderMobile,
    cameras: detail.cameras,
    ...(readOnly ? { readOnly: true } : {}),
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
    return denyScope(ctx, "只能在自己管理范围内的部门下面新建");
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
    return denyPerm(ctx, denied);
  }
  // 组织简化（B1b）：检测站全局唯一＋属总公司子树；检测站禁配监控通道（摄像头在分公司采样现场）
  const type = DEPT_TYPES.includes(body.type) ? body.type : "公司";
  const stationWhy = await checkStationType(ctx, type, parentId);
  if (stationWhy) {
    await record(ctx, "新增部门", "dept", "", "失败");
    return ctx.fail(stationWhy);
  }
  if (!camerasAllowed(type) && cameras.length) {
    await record(ctx, "新增部门", "dept", "", "失败");
    return ctx.fail("检测站不设监控通道：摄像头请配在分公司（公司类型）采样现场");
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
    return denyScope(ctx, "部门不存在");
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
    return denyScope(ctx, "只能修改自己管理范围内的部门");
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
    return denyPerm(ctx, denied);
  }
  // 组织简化（B1b）：改类型为检测站同样过唯一＋总公司子树校验；
  // 摄像头 gate 反转——检测站禁配、公司可配：改成检测站时清理已有通道（显式带通道则拒绝）。
  const type = DEPT_TYPES.includes(body.type) ? body.type : current.type || "公司";
  const stationWhy = await checkStationType(ctx, type, parentId, current.id);
  if (stationWhy) {
    await record(ctx, "修改部门", "dept", current.id, "失败");
    return ctx.fail(stationWhy);
  }
  if (!camerasAllowed(type)) {
    if (cameras && cameras.length) {
      await record(ctx, "修改部门", "dept", current.id, "失败");
      return ctx.fail("检测站不设监控通道：摄像头请配在分公司（公司类型）采样现场");
    }
    cameras = [];
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
      return denyScope(ctx, "只能删除自己管理范围内的部门");
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
  // #26 m-03：事务内逐部门清理——部门上限、角色自定义范围引用（sys_role_dept）、部门本体一起删，
  // 免得删部门后 sys_role_dept 留悬空 dept_id（resolveScope 会纳入已删 id、审计回显名称落空）。
  await inTransaction(ctx.db, async (db) => {
    for (const id of ids) {
      await db.run("DELETE FROM sys_dept_perm WHERE dept_id = ?", [id]);
      await db.run("DELETE FROM sys_role_dept WHERE dept_id = ?", [id]);
      await db.run("DELETE FROM sys_dept WHERE id = ?", [id]);
    }
  });
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
  // 排序下推到 SQL：ORDER BY sort, id（sort 平手按 id，和 roleOptions/reorder 同一口径）
  const rows = (await ctx.db.all("SELECT * FROM sys_role ORDER BY sort, id")).map((row) => ({
    ...toRole(row),
    userCount: counts.get(String(row.id)) || 0,
  }));
  const keywords = String(ctx.query.keywords || "").trim();
  const matched = rows.filter(
    (item) => !keywords || item.name.includes(keywords) || item.code.includes(keywords)
  );
  ctx.ok(paginate(matched, ctx.query));
}

/** 人员表单里的角色选项。当前用户不能分配的标成 disabled，reason 说明原因。 */
export async function roleOptions(ctx) {
  const out = [];
  // 给哪个部门的人分配：部门有上限时，角色里超出的项不会生效（可以分配，只提示）
  const deptId = typeof ctx.query?.deptId === "string" ? ctx.query.deptId : "";
  const limit = deptId ? await resolveDeptLimit(ctx.db, deptId) : null;
  for (const row of await ctx.db.all(
    "SELECT id, name, code, sort FROM sys_role ORDER BY sort, id"
  )) {
    const reason = await cannotAssign(ctx, row.id);
    let cut = 0;
    if (limit?.perms && row.code !== "ADMIN")
      cut = (await permsOfRole(ctx.db, row)).filter((code) => !limit.perms.has(code)).length;
    out.push({
      value: Number(row.id),
      label: row.name,
      // 总览「模拟视角」按角色 code 取模拟口径，选项里带上 code（其余调用方不受影响）
      code: row.code,
      ...(reason ? { disabled: true, reason } : {}),
      ...(cut ? { cut } : {}),
    });
  }
  ctx.ok(out);
}

/**
 * 角色列表拖拽排序（左列表/角色下拉/人员表单同序的单一写入口）。
 * ids 必须是当前全部角色（启用＋停用）的一个排列：不缺、不重、不外来，否则整体拒绝不落库。
 * 事务内按序写 sort=10,20,…（留间隔，单角色编辑排序不必整表重排）；审计记前后 id 顺序。
 * 返回保存后的新顺序（与 listRoles/roleOptions 同一 ORDER BY sort, id）。
 */
export async function reorderRoles(ctx) {
  const fail = async (message, code, status, targetId = "") => {
    await record(ctx, "调整角色顺序", "role", targetId, "失败");
    return ctx.fail(message, code, status);
  };
  // 路由已按 sys:role:update 把关，这里再兜底一层（直调 handler/未来漏挂 perm 时 fail-closed）
  if (!hasPerm(ctx, "sys:role:update"))
    return fail("没有「编辑角色」权限，不能调整角色顺序", "A0301", 403);
  const raw = ctx.body?.ids;
  if (!Array.isArray(raw)) return fail("ids 必须是角色 id 数组", "A0400", 400);
  const ids = raw.map(String);
  const rows = await ctx.db.all("SELECT id FROM sys_role ORDER BY sort, id");
  const known = new Set(rows.map((row) => String(row.id)));
  const seen = new Set();
  for (const id of ids) {
    if (!known.has(id)) return fail("角色顺序里有不存在的角色", "A0400", 400, ids.join(","));
    if (seen.has(id)) return fail("角色顺序里有重复的角色", "A0400", 400, ids.join(","));
    seen.add(id);
  }
  if (ids.length !== known.size)
    return fail("角色顺序要包含全部角色（含停用的），不能缺", "A0400", 400, ids.join(","));
  const before = rows.map((row) => String(row.id));
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await inTransaction(ctx.db, async (db) => {
    for (const [index, id] of ids.entries())
      await db.run("UPDATE sys_role SET sort = ?, update_time = ? WHERE id = ?", [
        (index + 1) * 10,
        now,
        id,
      ]);
  });
  await record(ctx, "调整角色顺序", "role", ids.join(","), "成功", { before, after: ids });
  const ordered = await ctx.db.all("SELECT id FROM sys_role ORDER BY sort, id");
  ctx.ok({ ids: ordered.map((row) => String(row.id)) }, "角色顺序已保存");
}

export async function roleForm(ctx) {
  const row = await ctx.db.get("SELECT * FROM sys_role WHERE id = ?", [ctx.params.id]);
  if (!row) return denyScope(ctx, "角色不存在");
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

/** #26 B1：角色的自定义部门（读 sys_role_dept，055b 建表）。 */
export async function roleDeptIds(ctx) {
  const role = await ctx.db.get("SELECT id FROM sys_role WHERE id = ?", [ctx.params.id]);
  if (!role) return denyScope(ctx, "角色不存在");
  ctx.ok(await roleDeptIdsOf(ctx.db, role.id));
}

/**
 * #26 B4：菜单预览单源——角色已保存权限能看到的菜单，与侧栏 menusFor 同一实现
 * （menuPreviewFor 直接复用 menusFor 的裁剪结果标 on/off），前端不再自抄菜单表。
 * #26 m-06：另镜像前端 local-menus 的调拨/送检注入（开关 + device:box:task），预览=真实侧栏。
 */
export async function roleMenuPreview(ctx) {
  const role = await ctx.db.get("SELECT id, code FROM sys_role WHERE id = ?", [ctx.params.id]);
  if (!role) return denyScope(ctx, "角色不存在");
  ctx.ok({ menus: menuPreviewFor(new Set(await permsOfRole(ctx.db, role))) });
}

/** #26 B4：角色页未保存勾选的菜单预览——给定 codes 的纯函数，同样走 menusFor；未知码丢掉。 */
export async function draftMenuPreview(ctx) {
  const known = new Set(ALL_PERMS.map((item) => item.code));
  const codes = (Array.isArray(ctx.body?.codes) ? ctx.body.codes : []).filter((code) =>
    known.has(code)
  );
  ctx.ok({ menus: menuPreviewFor(new Set(codes)) });
}

/** 审计明细里的权限码 → {code,label}，部门 id → {id,name}（读时装饰，日志里只存码/id）。 */
function decorateAuditDetail(raw, deptNames) {
  if (!raw || typeof raw !== "object") return null;
  const perms = (list) =>
    (Array.isArray(list) ? list : []).map((code) => ({ code, label: permLabelOf(code) }));
  const depts = (list) =>
    (Array.isArray(list) ? list : []).map((id) => ({
      id: String(id),
      name: deptNames.get(String(id)) || String(id),
    }));
  const out = {};
  if (Array.isArray(raw.added)) out.added = perms(raw.added);
  if (Array.isArray(raw.removed)) out.removed = perms(raw.removed);
  if (Array.isArray(raw.grantOn)) out.grantOn = perms(raw.grantOn);
  if (Array.isArray(raw.grantOff)) out.grantOff = perms(raw.grantOff);
  if (raw.scopeBefore != null) out.scopeBefore = Number(raw.scopeBefore);
  if (raw.scopeAfter != null) out.scopeAfter = Number(raw.scopeAfter);
  if (raw.scope != null) out.scope = Number(raw.scope);
  if (Array.isArray(raw.deptBefore)) out.deptBefore = depts(raw.deptBefore);
  if (Array.isArray(raw.deptAfter)) out.deptAfter = depts(raw.deptAfter);
  if (Array.isArray(raw.deptIds)) out.deptIds = depts(raw.deptIds);
  // #26 m-07：部门上限变更明细（limited/maxScope 前后），与角色侧 scopeBefore/After 同口径
  if (typeof raw.limitedBefore === "boolean") out.limitedBefore = raw.limitedBefore;
  if (typeof raw.limitedAfter === "boolean") out.limitedAfter = raw.limitedAfter;
  if (raw.maxScopeBefore !== undefined)
    out.maxScopeBefore = raw.maxScopeBefore == null ? null : Number(raw.maxScopeBefore);
  if (raw.maxScopeAfter !== undefined)
    out.maxScopeAfter = raw.maxScopeAfter == null ? null : Number(raw.maxScopeAfter);
  return Object.keys(out).length ? out : null;
}

/**
 * #26 B4：授权审计抽屉（只读）——谁在何时把哪些权限/可转授/范围授给该角色。
 * 数据源 sys_operation_log（target_type=role）+ sys_role_perm.grantable 现状。
 * 日志按 operationScope 同一口径裁剪（D1 actor 子树；仅本人看自己的；空范围不给），
 * 明细 detail 读时装饰成带名称的 diff。最多回 200 条（抽屉够用，不做翻页）。
 */
export async function roleGrantAudit(ctx) {
  const role = await ctx.db.get("SELECT * FROM sys_role WHERE id = ?", [ctx.params.id]);
  if (!role) return denyScope(ctx, "角色不存在");
  const rows = await ctx.db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id = ?", [
    String(role.id),
  ]);
  const admin = role.code === "ADMIN";
  const codes = admin ? ALL_PERMS.map((item) => item.code) : rows.map((row) => String(row.perm));
  const grantable = admin
    ? codes
    : rows.filter((row) => Number(row.grantable) === 1).map((row) => String(row.perm));
  const customIds = await roleDeptIdsOf(ctx.db, role.id);

  const scope = await operationScope(ctx.db, ctx.user);
  let entries = [];
  const deptIds = scope.kind === "depts" ? (scope.ids || []).map(String).filter(Boolean) : [];
  if (
    scope.kind === "all" ||
    scope.kind === "actor" ||
    (scope.kind === "depts" && deptIds.length)
  ) {
    const where = ["target_type = 'role'", "target_id = ?"];
    const params = [String(role.id)];
    if (scope.kind === "depts") {
      where.push(`org_id IN (${deptIds.map(() => "?").join(", ")})`);
      params.push(...deptIds);
    } else if (scope.kind === "actor") {
      where.push("actor_id = ?");
      params.push(String(scope.actorId || ""));
    }
    entries = await ctx.db.all(
      `SELECT id, org_id, org_name, actor_id, actor_name, action, result, detail, created_at, ip
       FROM sys_operation_log WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT 200`,
      params
    );
  }
  // 明细里提到的部门一次查齐名字（含现状自定义部门）
  const mentioned = new Set(customIds.map(String));
  const parsed = entries.map((row) => {
    let raw = null;
    try {
      raw = row.detail ? JSON.parse(row.detail) : null;
    } catch {
      /* 坏明细当没有 */
    }
    for (const key of ["deptBefore", "deptAfter", "deptIds"])
      for (const id of raw?.[key] || []) mentioned.add(String(id));
    return raw;
  });
  const deptNames = new Map();
  if (mentioned.size) {
    const ids = [...mentioned];
    const found = await ctx.db.all(
      `SELECT id, name FROM sys_dept WHERE id IN (${ids.map(() => "?").join(", ")})`,
      ids
    );
    for (const row of found) deptNames.set(String(row.id), row.name);
  }
  ctx.ok({
    role: {
      id: String(role.id),
      name: role.name,
      code: role.code,
      dataScope: rawScope(role.data_scope),
      deptIds: customIds.map((id) => ({ id, name: deptNames.get(id) || id })),
    },
    current: {
      total: codes.length,
      grantable: grantable.map((code) => ({ code, label: permLabelOf(code) })),
    },
    entries: entries.map((row, i) => ({
      id: String(row.id),
      actorId: String(row.actor_id || ""),
      actorName: row.actor_name || "",
      orgName: row.org_name || "",
      action: row.action,
      result: row.result,
      createdAt:
        row.created_at instanceof Date ? formatTimestamp(row.created_at) : String(row.created_at),
      ip: row.ip || "",
      detail: decorateAuditDetail(parsed[i], deptNames),
    })),
  });
}

/**
 * #26 D3：自定义数据范围（5）的授予边界——仅 scope≤2 的角色可授 5；
 * 自定义部门 ⊆ 自己 manageOrgIds（管理员不限）；部门要存在。
 * 通过返回 { deptIds }，否则返回 { error, code, status }。
 */
async function checkCustomDeptIds(ctx, deptIds) {
  if ((await myScopeRank(ctx)) > 2)
    return {
      error: "只有「本单位及下级」以上数据范围的角色能设置自定义部门",
      code: "A0301",
      status: 403,
    };
  const ids = [...new Set((deptIds || []).map(String))];
  if (!isAdmin(ctx) && !ctx.access?.scope?.all) {
    const mine = new Set(manageIds(ctx.access?.scope || {}).map(String));
    if (ids.some((id) => !mine.has(id)))
      return { error: "自定义部门只能选自己管理范围内的部门", code: "A0301", status: 403 };
  }
  for (const id of ids) {
    if (!(await ctx.db.get("SELECT id FROM sys_dept WHERE id = ?", [id])))
      return { error: `部门不存在：${id}`, code: "A0404", status: 404 };
  }
  return { deptIds: ids };
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
  let customIds = [];
  if (hasPerm(ctx, "sys:role:scope")) {
    dataScope = rawScope(body.dataScope ?? 3);
    if (dataScope === 5) {
      const checked = await checkCustomDeptIds(ctx, body.deptIds);
      if (checked.error) {
        await record(ctx, "新增角色", "role", "", "失败");
        return ctx.fail(checked.error, checked.code, checked.status);
      }
      customIds = checked.deptIds;
    } else if (dataScope < (await myScopeRank(ctx))) {
      await record(ctx, "新增角色", "role", "", "失败");
      return denyPerm(ctx, "数据范围不能比你自己的宽");
    }
  }
  const id = await nextId(ctx.db, "sys_role");
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  await inTransaction(ctx.db, async (db) => {
    await db.run(
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
    for (const deptId of customIds)
      await db.run("INSERT INTO sys_role_dept (role_id, dept_id) VALUES (?, ?)", [id, deptId]);
  });
  await record(ctx, "新增角色", "role", id, "成功", { scope: dataScope, deptIds: customIds });
  ctx.ok(null, `新增角色${body.name}成功`);
}

export async function updateRole(ctx) {
  const body = ctx.body || {};
  const current = await ctx.db.get("SELECT * FROM sys_role WHERE id = ?", [ctx.params.id]);
  if (!current) {
    await record(ctx, "修改角色", "role", ctx.params.id, "失败");
    return denyScope(ctx, "角色不存在");
  }
  const fail = async (message, code, status) => {
    await record(ctx, "修改角色", "role", current.id, "失败");
    return ctx.fail(message, code, status);
  };
  const admin = current.code === "ADMIN";
  if (admin && !isAdmin(ctx)) return fail("只有系统管理员可以修改系统管理员角色", "A0301", 403);
  const status = Number(body.status ?? current.status);
  if (admin && status !== 1) return fail("系统管理员角色不能停用");
  // 没有「编辑角色」：名称、排序、启停都不能改
  if (!hasPerm(ctx, "sys:role:update")) {
    const renamed = body.name != null && body.name !== current.name;
    const moved = body.sort != null && Number(body.sort) !== Number(current.sort);
    if (renamed || moved || status !== Number(current.status))
      return fail("没有「编辑角色」权限，只能改数据范围", "A0301", 403);
  }
  // 数据范围单独授权：要有「设置角色数据范围」，不能比自己宽；系统管理员固定全部数据。
  // #26 B1：rawScope 保留自定义 5（scopeRank 会把 5 折成 3，写库会丢自定义语义）
  const currentScope = rawScope(current.data_scope);
  const scope = body.dataScope == null ? currentScope : rawScope(body.dataScope);
  const scopeChanged = scope !== currentScope;
  const deptIds = Array.isArray(body.deptIds) ? body.deptIds : null;
  // #26 m-05：空数组视同未传字段（合法 no-op——scope≠5 时下方事务的残留清理分支本就清自定义行，
  // 与旧客户端不带 deptIds 同语义）；非空 deptIds + 非自定义范围仍拒，统一带校验码 A0400/400。
  // 注意不能把 [] 归一成 null：scope5 + [] 仍要进下方 D3 分支清空自定义行（既有语义）。
  if (deptIds?.length && scope !== 5)
    return fail("自定义部门只在数据范围为「自定义部门数据」时生效", "A0400", 400);
  if (scopeChanged) {
    if (admin) return fail("系统管理员固定是全部数据");
    if (!hasPerm(ctx, "sys:role:scope"))
      return fail("没有「设置角色数据范围」权限，不能改数据范围", "A0301", 403);
    if (scope !== 5 && scope < (await myScopeRank(ctx)))
      return fail("数据范围不能比你自己的宽", "A0301", 403);
  }
  // 自定义范围：改成 5、或给已是 5 的角色改部门，都要过 D3（⊆ 自己 manage、仅 scope≤2 可授）
  let customIds = null;
  if (scope === 5 && (scopeChanged || deptIds)) {
    if (!hasPerm(ctx, "sys:role:scope"))
      return fail("没有「设置角色数据范围」权限，不能改自定义部门", "A0301", 403);
    const wanted = deptIds ?? (scopeChanged ? [] : await roleDeptIdsOf(ctx.db, current.id));
    const checked = await checkCustomDeptIds(ctx, wanted);
    if (checked.error) return fail(checked.error, checked.code, checked.status);
    customIds = checked.deptIds;
  }
  const now = new Date().toISOString().slice(0, 19).replace("T", " ");
  // 审计明细要对比改前的自定义部门，先读出来（事务里会删旧行）
  const deptBefore =
    currentScope === 5 || scope === 5 ? await roleDeptIdsOf(ctx.db, current.id) : [];
  // 角色编码建好后不能改：权限默认值、系统管理员判断都按编码来
  await inTransaction(ctx.db, async (db) => {
    await db.run(
      `UPDATE sys_role SET name = ?, data_scope = ?, sort = ?, status = ?, update_time = ? WHERE id = ?`,
      [
        body.name || current.name,
        scopeChanged ? scope : current.data_scope,
        Number(body.sort ?? current.sort),
        status,
        now,
        current.id,
      ]
    );
    if (scope === 5 && customIds) {
      await db.run("DELETE FROM sys_role_dept WHERE role_id = ?", [String(current.id)]);
      for (const deptId of customIds)
        await db.run("INSERT INTO sys_role_dept (role_id, dept_id) VALUES (?, ?)", [
          String(current.id),
          deptId,
        ]);
    } else if (scope !== 5) {
      // 改回非自定义：残留的自定义部门清掉，免得再改回 5 时带出旧选择
      await db.run("DELETE FROM sys_role_dept WHERE role_id = ?", [String(current.id)]);
    }
  });
  // #26 B4：授权审计明细——范围前后 + 自定义部门 diff；只改名/排序时不写空明细
  const deptAfter = scope === 5 ? (customIds ?? deptBefore) : [];
  const deptChanged =
    deptBefore.length !== deptAfter.length || deptBefore.some((id) => !deptAfter.includes(id));
  const detail = {};
  if (scopeChanged) {
    detail.scopeBefore = currentScope;
    detail.scopeAfter = scope;
  }
  if (deptChanged) {
    detail.deptBefore = deptBefore;
    detail.deptAfter = deptAfter;
  }
  await record(
    ctx,
    "修改角色",
    "role",
    current.id,
    "成功",
    Object.keys(detail).length ? detail : undefined
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
      return denyPerm(ctx, reason);
    }
  }
  for (const id of ids) {
    await ctx.db.run("DELETE FROM sys_user_role WHERE role_id = ?", [id]);
    await ctx.db.run("DELETE FROM sys_role_perm WHERE role_id = ?", [id]);
    await ctx.db.run("DELETE FROM sys_role_dept WHERE role_id = ?", [id]);
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
  const users = (await loadUsers(ctx.db, ctx.access?.scope, ctx.user?.id))
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
  if (!row || !userInScope(ctx, row)) return denyScope(ctx, "用户不存在");
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
  const fail = async (message, code, status) => {
    await record(ctx, "新增用户", "user", "", "失败");
    return ctx.fail(message, code, status);
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
    return fail("只能在自己数据范围内的部门新建人员", "A0404", 404);
  const roleIds = Array.isArray(body.roleIds) ? [...new Set(body.roleIds.map(String))] : [];
  const roleProblem = await checkRoleChange(ctx, roleIds, []);
  if (roleProblem) return fail(roleProblem, "A0301", 403);
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
    return ctx.fail(guard.error, guard.code, guard.status);
  }
  const current = guard.user;
  if (body.deptId && !userInScope(ctx, { dept_id: body.deptId }))
    return denyScope(ctx, "只能把人员放到自己数据范围内的部门");
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
      return denyPerm(ctx, problem);
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
    if (!hasPerm(ctx, perm)) return denyPerm(ctx, `没有「${permLabelOf(perm)}」权限`);
  }
  const edited =
    (body.nickname != null && body.nickname !== current.nickname) ||
    (body.deptId != null && String(body.deptId) !== String(current.dept_id)) ||
    (body.mobile !== undefined && (body.mobile || null) !== (current.mobile || null)) ||
    (body.gender !== undefined && body.gender !== current.gender) ||
    (body.email !== undefined && (body.email || "") !== (current.email || ""));
  if (edited && !hasPerm(ctx, "sys:user:update")) return denyPerm(ctx, "没有「编辑人员资料」权限");
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
        if (Number(admins?.n || 0) <= 1) return ctx.fail("不能删除最后一个系统管理员");
        return denyPerm(ctx, "只有系统管理员可以删除系统管理员");
      }
    }
    const guard = await guardUser(ctx, id);
    if (guard.error) return ctx.fail(guard.error, guard.code, guard.status);
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
  if (guard.error) return ctx.fail(guard.error, guard.code, guard.status);
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
  if (guard.error) return ctx.fail(guard.error, guard.code, guard.status);
  await ctx.db.run("UPDATE sys_user SET must_change_password = 1 WHERE id = ?", [ctx.params.id]);
  await record(ctx, "强制改密", "user", ctx.params.id, "成功");
  ctx.ok(null, "该账号下次操作时需要先修改密码");
}

/**
 * 免除首次改密：给小程序审核、演示这类多人共用的账号用，否则第一个人登录改了密码，后面的人就进不来。
 * 只有系统管理员能做，记操作日志；不改密码，也不踢下线。
 */
export async function skipPasswordChange(ctx) {
  if (!isAdmin(ctx)) return denyPerm(ctx, "只有系统管理员可以免除改密");
  const guard = await guardUser(ctx, ctx.params.id);
  if (guard.error) return ctx.fail(guard.error, guard.code, guard.status);
  await ctx.db.run(
    "UPDATE sys_user SET must_change_password = 0, password_changed_at = ? WHERE id = ?",
    [new Date().toISOString(), ctx.params.id]
  );
  await record(ctx, "免除改密", "user", ctx.params.id, "成功");
  ctx.ok(null, "该账号登录后不再要求改密");
}

export async function unlockUser(ctx) {
  const guard = await guardUser(ctx, ctx.params.id);
  if (guard.error) return ctx.fail(guard.error, guard.code, guard.status);
  await ctx.db.run("UPDATE sys_user SET failed_count = 0, locked_until = '' WHERE id = ?", [
    ctx.params.id,
  ]);
  await record(ctx, "解锁账号", "user", ctx.params.id, "成功");
  ctx.ok(null, "已解锁");
}

/** 强制下线：会话版本加一，已签发的令牌全部失效，实时连接断开；微信绑定一并解除，免得小程序又自动登录回来。 */
export async function kickUser(ctx) {
  const guard = await guardUser(ctx, ctx.params.id);
  if (guard.error) return ctx.fail(guard.error, guard.code, guard.status);
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
  if (guard.error) return ctx.fail(guard.error, guard.code, guard.status);
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
    // #26 B4（D3）：前端范围选择器预校验用——自己最宽的数据范围（1–4，管理员 1）
    myScope: await myScopeRank(ctx),
  });
}

/* ---------------- 部门权限上限 ---------------- */

const SCOPE_TEXT = {
  1: "全部数据",
  2: "本单位及下级",
  3: "本单位",
  4: "仅本人",
  5: "自定义部门数据",
};

/**
 * 部门的权限上限：自己的设置、上级的实际上限（下级只能在这个范围里勾）、自己的实际上限，
 * 以及当前用户能动哪些项（自己可转授的、且在上级范围里的）。
 * #26 B1（D2）：读也按 manage 子树 + 祖先壳收口，范围外 A0404。
 */
export async function deptLimit(ctx) {
  const dept = await ctx.db.get("SELECT * FROM sys_dept WHERE id = ?", [ctx.params.id]);
  const allowed = readScopeIds(ctx.access?.scope, await loadDeptTree(ctx.db));
  if (!dept || (allowed && !allowed.has(String(dept.id)))) return denyScope(ctx, "部门不存在");
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
  if (!dept) return denyScope(ctx, "部门不存在");
  const fail = async (message, code, status) => {
    await record(ctx, "设置部门权限上限", "dept", dept.id, "失败");
    return ctx.fail(message, code, status);
  };
  if (!deptInManage(ctx, dept.id)) return fail("只能设置自己管理范围内的部门", "A0404", 404);
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
        `上级部门没有这几项，下级不能勾：${beyond.slice(0, 5).map(permLabelOf).join("、")}${beyond.length > 5 ? "，共 " + beyond.length + " 项" : ""}`,
        "A0301",
        403
      );
  }
  if (maxScope != null && parent.maxScope != null && maxScope < parent.maxScope)
    return fail(`最大数据范围不能比上级部门的「${SCOPE_TEXT[parent.maxScope]}」宽`, "A0301", 403);
  // #26 m-07：改前的上限状态先读出来——非管理员校验和成功审计明细（前后 diff）共用
  const wasLimited = Number(dept.perm_limited) === 1;
  const before = new Set(
    (await ctx.db.all("SELECT perm FROM sys_dept_perm WHERE dept_id = ?", [String(dept.id)])).map(
      (row) => String(row.perm)
    )
  );
  const parentAll = parent.perms ? [...parent.perms] : ALL_PERMS.map((item) => item.code);
  if (!isAdmin(ctx)) {
    // 收紧（收回）只会让下级权力变小，管理范围里的部门都可以；放开（这个部门原来用不了、现在能用）要自己可转授
    const usable = wasLimited
      ? new Set(parentAll.filter((code) => before.has(code)))
      : new Set(parentAll);
    const after = limited ? codes : parentAll;
    const opened = after.filter((code) => !usable.has(code));
    const beyond = opened.filter((code) => !canPass(ctx, code));
    if (beyond.length)
      return fail(
        `这几项你不能转授，不能放开：${beyond.slice(0, 5).map(permLabelOf).join("、")}${beyond.length > 5 ? "，共 " + beyond.length + " 项" : ""}`,
        "A0301",
        403
      );
    // 最大数据范围放宽时不能比自己的宽
    const mine = await myScopeRank(ctx);
    const was = dept.max_data_scope == null ? null : scopeRank(dept.max_data_scope);
    const widened = maxScope == null ? was != null : was != null && maxScope < was;
    if (widened && (maxScope == null ? (parent.maxScope ?? 1) < mine : maxScope < mine))
      return fail("最大数据范围不能比你自己的宽", "A0301", 403);
    if (maxScope != null && maxScope < mine)
      return fail("最大数据范围不能比你自己的宽", "A0301", 403);
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
  // #26 m-07：部门上限变更审计明细——与 B4 grant detail 同口径（日志只存码/数值，读时装饰）。
  // perms diff 按「实际上限」比：不限 = 跟上级一样（parentAll），受限 = 自己勾的 codes；
  // 这样收紧/放开/改勾选各变了哪些项一目了然。没有任何变化时不写空明细（同 saveRolePerms）。
  const maxScopeBefore = dept.max_data_scope == null ? null : scopeRank(dept.max_data_scope);
  const beforeEffective = wasLimited ? [...before] : parentAll;
  const afterEffective = limited ? codes : parentAll;
  const added = afterEffective.filter((code) => !beforeEffective.includes(code));
  const removed = beforeEffective.filter(
    (code) => known.has(code) && !afterEffective.includes(code)
  );
  const changed =
    wasLimited !== limited || maxScopeBefore !== maxScope || added.length || removed.length;
  const detail = {
    limitedBefore: wasLimited,
    limitedAfter: limited,
    maxScopeBefore,
    maxScopeAfter: maxScope,
    added,
    removed,
  };
  await record(ctx, "设置部门权限上限", "dept", dept.id, "成功", changed ? detail : undefined);
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
  if (!user || !userInScope(ctx, user)) return denyScope(ctx, "用户不存在或不在你的管理范围内");
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
  if (!role) return denyScope(ctx, "角色不存在");
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
  if (!role) return denyScope(ctx, "角色不存在");
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
      return denyPerm(
        ctx,
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
  // #26 B4：授权审计明细——这次加了/收了哪些项、哪些项开关了可转授
  const added = codes.filter((code) => !before.has(code));
  const removed = [...before].filter((code) => known.has(code) && !codes.includes(code));
  const grantOn = codes.filter((code) => passed.has(code) && !passedBefore.has(code));
  const grantOff = codes.filter(
    (code) => before.has(code) && !passed.has(code) && passedBefore.has(code)
  );
  const detail = { added, removed, grantOn, grantOff };
  const changed = added.length || removed.length || grantOn.length || grantOff.length;
  await record(ctx, "分配角色权限", "role", role.id, "成功", changed ? detail : undefined);
  ctx.ok(null, `已保存【${role.name}】的 ${codes.length} 项权限，其中 ${passed.size} 项可转授`);
}
