import { buildDeptTree, collectDeptIds } from "../../../shared/org.js";
import { voltagePercent } from "../domain/BatteryEstimate.js";
import { ALL_PERMS, DEFAULT_ROLE_PERMS, grantsAll } from "./permCatalog.js";
import { firmwareSupportsRemote } from "../settings/boxConfig.js";

export const BOX = {
  list: "device:box:list",
  detail: "device:box:detail",
  power: "device:box:power",
  lid: "device:box:lid",
  opens: "device:box:opens",
  signal: "device:box:signal",
  charging: "device:box:charging",
  powerLog: "device:box:power-log",
  storage: "device:box:storage",
  location: "device:box:location",
  track: "device:box:track",
  battery: "device:box:battery",
  iccid: "device:box:iccid",
  imsi: "device:box:imsi",
  firmware: "device:box:firmware",
  eventLid: "device:box:event-lid",
  eventBoot: "device:box:event-boot",
  eventCharge: "device:box:event-charge",
  log: "device:box:log",
  raw: "device:box:raw",
  task: "device:box:task",
  activate: "device:box:activate",
  disable: "device:box:disable",
  enable: "device:box:enable",
  delete: "device:box:delete",
  wipe: "device:box:wipe",
  assignOrg: "device:box:assign-org",
  assignOwner: "device:box:assign-owner",
  export: "device:box:export",
  logExport: "device:box:logExport",
  dump: "device:box:dump",
  rename: "device:box:rename",
};

/** 一项权限遮哪几个字段。没有这项权限时，箱子 JSON 里直接拿掉这些字段，masked 里记下名字。 */
export const FIELD_GROUPS = [
  {
    perm: BOX.power,
    name: "power",
    fields: [
      "battery",
      "batterySoc",
      "batteryUsable",
      "batteryReserve",
      "batteryCycles",
      "batteryLearned",
      "batteryDevice",
      "batteryBasis",
    ],
  },
  { perm: BOX.lid, name: "lid", fields: ["lid"] },
  { perm: BOX.opens, name: "opens", fields: ["opens", "lastOpen"] },
  { perm: BOX.signal, name: "signal", fields: ["csq"] },
  { perm: BOX.charging, name: "charging", fields: ["charge", "unchargedAt"] },
  { perm: BOX.powerLog, name: "powerLog", fields: ["lastPowerOff", "bootedAt"] },
  { perm: BOX.storage, name: "storage", fields: ["storageFree"] },
  {
    perm: BOX.location,
    name: "location",
    fields: [
      "gpsInfo",
      "lbs",
      "lbsLng",
      "lbsLat",
      "lbsAt",
      "gps",
      "gpsLng",
      "gpsLat",
      "lbsAddress",
      "gpsAddress",
    ],
  },
  { perm: BOX.iccid, name: "iccid", fields: ["iccid"] },
  { perm: BOX.imsi, name: "imsi", fields: ["imsi"] },
  { perm: BOX.firmware, name: "firmware", fields: ["firmware"] },
];
const STATUS_GROUPS = ["power", "lid", "opens", "signal", "charging", "powerLog", "storage"];
const IDENTITY_GROUPS = ["iccid", "imsi", "firmware"];

export const FLAGS = ["alert", "offline", "low", "lid", "ready"];
/** 筛选、计数要看的字段权限：低电量、可调配看电量，开着盖看箱盖状态。 */
export const FLAG_PERMS = { low: BOX.power, ready: BOX.power, lid: BOX.lid };
export function flagAllowed(flag, perms) {
  return !perms || !FLAG_PERMS[flag] || perms.has(FLAG_PERMS[flag]);
}

/** 开关箱、上电、充电这几类报文各有一项记录权限，其余报文要「查看上报记录」。 */
export const EVENT_KINDS = ["boot", "pad", "shut", "chg"];
export const EVENT_PERMS = {
  pad: BOX.eventLid,
  shut: BOX.eventLid,
  boot: BOX.eventBoot,
  chg: BOX.eventCharge,
};
/** 能看哪几类事件。perms 为空（内部调用）时全部。 */
export function eventKindsFor(perms) {
  return EVENT_KINDS.filter((kind) => !perms || perms.has(EVENT_PERMS[kind]));
}

/** 只给还没有任何授权行的角色写默认值，已经在角色页保存过的不动。 */
export async function seedRolePerms(db) {
  const roles = await db.all("SELECT id, code FROM sys_role");
  const rows = await db.all("SELECT DISTINCT role_id FROM sys_role_perm");
  const seeded = new Set(rows.map((row) => String(row.role_id)));
  for (const role of roles) {
    if (seeded.has(String(role.id))) continue;
    const defaults = DEFAULT_ROLE_PERMS[role.code];
    if (!defaults) continue;
    // 能授权的角色（分公司管理员等）：自己的权限默认都可转授
    const grantable = grantsAll(defaults) ? 1 : 0;
    for (const perm of defaults) {
      await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES (?, ?, ?)", [
        String(role.id),
        perm,
        grantable,
      ]);
    }
  }
}

async function activeRoles(db, userId) {
  const rows = await db.all(
    `SELECT r.id, r.code, r.data_scope, r.status FROM sys_role r
     INNER JOIN sys_user_role ur ON ur.role_id = r.id
     WHERE ur.user_id = ?`,
    [String(userId)]
  );
  return rows.filter((row) => Number(row.status) === 1);
}

export async function resolvePerms(db, roles) {
  if (roles.some((role) => role.code === "ADMIN")) {
    return new Set(ALL_PERMS.map((item) => item.code));
  }
  const ids = roles.map((role) => String(role.id));
  if (!ids.length) return new Set();
  const rows = await db.all(
    `SELECT perm FROM sys_role_perm WHERE role_id IN (${ids.map(() => "?").join(", ")})`,
    ids
  );
  return new Set(rows.map((row) => String(row.perm)));
}

/**
 * 能转授的权限：自己某个角色上这项权限开了「可转授」。系统管理员全部可转授。
 * 授给别的角色、把含这项权限的角色分给别人，都只能在这个范围里。
 */
export async function resolveGrantable(db, roles) {
  if (roles.some((role) => role.code === "ADMIN"))
    return new Set(ALL_PERMS.map((item) => item.code));
  const ids = roles.map((role) => String(role.id));
  if (!ids.length) return new Set();
  const rows = await db.all(
    `SELECT perm FROM sys_role_perm WHERE grantable = 1 AND role_id IN (${ids.map(() => "?").join(", ")})`,
    ids
  );
  return new Set(rows.map((row) => String(row.perm)));
}

/** 数据范围：1 全部、2 本单位及下级、3 本单位、4 仅本人，数字越小越宽。老数据里的 5 按本单位算。 */
export function scopeRank(value) {
  const n = Number(value);
  if (n === 5) return 3;
  return n >= 1 && n <= 4 ? n : 4;
}

async function loadDepts(db) {
  return (await db.all("SELECT * FROM sys_dept")).map((row) => ({
    id: String(row.id),
    parentId: String(row.parent_id),
    name: row.name,
    sort: Number(row.sort) || 0,
    limited: Number(row.perm_limited) === 1,
    maxScope:
      row.max_data_scope == null || row.max_data_scope === ""
        ? null
        : scopeRank(row.max_data_scope),
  }));
}

/**
 * 部门权限上限（参考云平台的服务控制策略）：从所在部门往上走到顶级，
 * 开了「单独限制」的每一级的权限列表取交集，最大数据范围取最窄的。
 * 返回 { perms: Set | null（null 表示不限）, maxScope: 1–4 | null, chain: 从顶级到本部门每一级的设置 }。
 */
export async function resolveDeptLimit(db, deptId, depts = null) {
  const rows = depts || (await loadDepts(db));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const chain = [];
  const seen = new Set();
  for (
    let cursor = byId.get(String(deptId ?? ""));
    cursor && !seen.has(cursor.id);
    cursor = byId.get(cursor.parentId)
  ) {
    seen.add(cursor.id);
    chain.unshift(cursor);
  }
  let perms = null;
  let maxScope = null;
  const limited = chain.filter((dept) => dept.limited);
  const lists = new Map();
  if (limited.length) {
    const ids = limited.map((dept) => dept.id);
    const found = await db.all(
      `SELECT dept_id, perm FROM sys_dept_perm WHERE dept_id IN (${ids.map(() => "?").join(", ")})`,
      ids
    );
    for (const id of ids) lists.set(id, new Set());
    for (const row of found) lists.get(String(row.dept_id))?.add(String(row.perm));
  }
  for (const dept of chain) {
    if (dept.limited) {
      const own = lists.get(dept.id) || new Set();
      perms = perms ? new Set([...perms].filter((code) => own.has(code))) : own;
    }
    if (dept.maxScope != null)
      maxScope = maxScope == null ? dept.maxScope : Math.max(maxScope, dept.maxScope);
  }
  return {
    perms,
    maxScope,
    chain: chain.map((dept) => ({
      id: dept.id,
      name: dept.name,
      limited: dept.limited,
      maxScope: dept.maxScope,
      perms: dept.limited ? [...(lists.get(dept.id) || [])] : null,
    })),
  };
}

/**
 * 两种范围：
 * - 看箱子（orgIds）：箱子挂在单位上（总公司、分公司、机构），人挂在单位下面的科室里，
 *   所以「本单位」「本单位及下级」都把上级单位算进来，调度室的人才看得到本分公司名下的箱子；
 * - 管人和部门（manageOrgIds）：只有本部门（及下级），不含上级，下级管不了上级的人。
 * 数据范围被部门的「最大数据范围」封顶（cap）。没分配过的箱子 org_id 为空，归第一个顶级部门（总公司）。
 */
export async function resolveScope(db, user, roles, cap = null, depts = null) {
  const isAdmin = roles.some((role) => role.code === "ADMIN");
  const ranks = roles.map((role) =>
    cap == null || isAdmin ? scopeRank(role.data_scope) : Math.max(scopeRank(role.data_scope), cap)
  );
  if (isAdmin || ranks.includes(1))
    return { all: true, orgIds: [], ownerIds: [], manageOrgIds: [] };
  const rows = depts || (await loadDepts(db));
  const tree = buildDeptTree(rows);
  const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
  const deptId = String(user.dept_id ?? user.deptId ?? "");
  const orgIds = new Set();
  const manage = new Set();
  const ownerIds = new Set();
  for (const rank of ranks) {
    if (rank === 4) {
      ownerIds.add(String(user.id));
      continue;
    }
    if (!deptId) continue;
    let cursor = parentOf.get(deptId);
    while (cursor && cursor !== "0" && !orgIds.has(cursor)) {
      orgIds.add(cursor);
      cursor = parentOf.get(cursor);
    }
    const own = rank === 2 ? collectDeptIds(tree, deptId) || [deptId] : [deptId];
    for (const id of own) {
      orgIds.add(id);
      manage.add(id);
    }
  }
  const hq = tree[0]?.id;
  if (hq && orgIds.has(hq)) orgIds.add("");
  return { all: false, orgIds: [...orgIds], ownerIds: [...ownerIds], manageOrgIds: [...manage] };
}

/**
 * 一个人最终的权限：
 * - perms =（角色权限之和）∩ 部门上限；grantable =（角色上开了可转授的）∩ 部门上限；
 * - scope 按部门「最大数据范围」封顶；
 * - 系统管理员不受部门上限约束。
 * rolePerms、limit 留给「实际权限」页面解释每项从哪来。
 */
export async function resolveAccess(db, user) {
  const roles = await activeRoles(db, user.id);
  const isAdmin = roles.some((role) => role.code === "ADMIN");
  const depts = await loadDepts(db);
  const limit = isAdmin
    ? { perms: null, maxScope: null, chain: [] }
    : await resolveDeptLimit(db, user.dept_id ?? user.deptId, depts);
  const rolePerms = await resolvePerms(db, roles);
  const roleGrantable = await resolveGrantable(db, roles);
  const cut = (set) =>
    limit.perms ? new Set([...set].filter((code) => limit.perms.has(code))) : set;
  return {
    userId: String(user.id),
    roles: roles.map((role) => role.code),
    perms: cut(rolePerms),
    grantable: cut(roleGrantable),
    scope: await resolveScope(db, user, roles, limit.maxScope, depts),
    rolePerms,
    limit,
  };
}

export function canSee(access, box) {
  if (!access) return true;
  const { scope } = access;
  if (scope.all) return true;
  if (scope.orgIds.includes(String(box.orgId ?? ""))) return true;
  return Boolean(box.ownerId) && scope.ownerIds.includes(String(box.ownerId));
}

/** 拼进 WHERE 的范围条件。范围为空时一台都不给。 */
export function scopeSql(scope) {
  if (!scope || scope.all) return null;
  const parts = [];
  const params = [];
  if (scope.orgIds.length) {
    parts.push(`org_id IN (${scope.orgIds.map(() => "?").join(", ")})`);
    params.push(...scope.orgIds);
  }
  if (scope.ownerIds.length) {
    parts.push(`owner_id IN (${scope.ownerIds.map(() => "?").join(", ")})`);
    params.push(...scope.ownerIds);
  }
  if (!parts.length) return { sql: "1 = 0", params: [] };
  return { sql: `(${parts.join(" OR ")})`, params };
}

/**
 * 没有权限的字段直接拿掉，masked 告诉页面哪几块是无权查看而不是没数据（按 FIELD_GROUPS 的名字）。
 * 工况七项都没有时另记 status，设备标识三项都没有时另记 identity，旧页面照样能判断。
 * remote：设备固件支不支持远程抹除、读本机日志。不受「查看固件版本」影响，页面不用再看版本号。
 */
export function maskBox(json, perms) {
  const remote = firmwareSupportsRemote(json.firmware);
  if (!perms) return { ...json, remote };
  const copy = { ...json, remote };
  const masked = [];
  for (const group of FIELD_GROUPS) {
    if (perms.has(group.perm)) continue;
    for (const field of group.fields) delete copy[field];
    masked.push(group.name);
  }
  if (STATUS_GROUPS.every((name) => masked.includes(name))) masked.push("status");
  if (IDENTITY_GROUPS.every((name) => masked.includes(name))) masked.push("identity");
  if (!perms.has("device:box:policyRead")) delete copy.reportPolicyStatus;
  copy.masked = masked;
  return copy;
}

export function maskUplink(item, perms) {
  if (!perms || perms.has(BOX.location)) return item;
  const copy = { ...item };
  for (const field of ["lbsLng", "lbsLat", "gpsLng", "gpsLat"]) copy[field] = null;
  return copy;
}

/**
 * 按默认曲线把可用电量换成电压阈值，库里只存了电压。学习过曲线的箱子会差几个百分点。
 */
export function usableMv(usable, reserve) {
  const target = reserve + (usable / 100) * (100 - reserve);
  for (let mv = 3300; mv <= 4200; mv += 10) {
    if (voltagePercent(mv) >= target) return mv;
  }
  return 4200;
}

export function flagMatch(box, flag, limits) {
  const last = String(box.last || "");
  const online = Boolean(last) && last >= limits.onlineSince;
  const mv = Number(box.batteryMv);
  if (flag === "alert") return Boolean(box.alert);
  if (flag === "offline") return !online;
  if (flag === "low") return mv > 0 && mv < limits.lowMv;
  if (flag === "lid") return Number(box.lid) === 1;
  if (flag === "ready") {
    return box.life === "未使用" && !box.alert && online && mv >= limits.readyMv;
  }
  return true;
}
