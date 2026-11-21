import { buildDeptTree, collectDeptIds } from "../../../shared/org.js";
import { voltagePercent } from "../domain/BatteryEstimate.js";
import { ALL_PERMS, DEFAULT_ROLE_PERMS, grantsAll } from "./permCatalog.js";
import { firmwareSupportsRemote } from "../settings/boxConfig.js";
import { boxGraceSec, boxReserve } from "../settings/companyPolicy.js";

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
      "lastGpsAt",
      "lastLbsAt",
    ],
  },
  { perm: BOX.iccid, name: "iccid", fields: ["iccid"] },
  { perm: BOX.imsi, name: "imsi", fields: ["imsi"] },
  { perm: BOX.firmware, name: "firmware", fields: ["firmware"] },
];
const STATUS_GROUPS = ["power", "lid", "opens", "signal", "charging", "powerLog", "storage"];
const IDENTITY_GROUPS = ["iccid", "imsi", "firmware"];
/**
 * 「设备标识」这一项的口径。老库里是一项 device:box:identity，迁移 045 拆成了
 * iccid / imsi / firmware 三项（见 permCatalog 的 SPLIT_045），所以「有没有设备标识权限」
 * 只能按拆完的三项判断：三项都有才算有。IMEI 也归这项管——现场采样员默认只有工况和位置，
 * 不该看到整队箱子的 IMEI。
 */
const IDENTITY_PERMS = [BOX.iccid, BOX.imsi, BOX.firmware];
export function identityGranted(perms) {
  return !perms || IDENTITY_PERMS.every((perm) => perms.has(perm));
}

/** IMEI 打码：留前 3 位和后 4 位，够现场对上尾号，又抄不走整串。 */
export function maskImei(imei) {
  const text = String(imei || "");
  if (!text) return "";
  if (text.length < 8) return "****";
  return `${text.slice(0, 3)}${"*".repeat(text.length - 7)}${text.slice(-4)}`;
}

/** 现在的箱子编号就是 15 位 IMEI（独立代理键还没落地），凡是这个形态的串都按设备标识处理。 */
const IMEI_LIKE = /^\d{15}$/;

/**
 * 「名称」单元格：没起名时 toJSON 会把编号回显进来，而编号就是整串 IMEI（M-1）。
 * 有设备标识权限的照原样给；没有的要么空着（页面自己写占位），要么给打码副本，绝不下发整串。
 * 下载文件名不能出现打码串里的星号，所以第二个参数传 false。
 */
export function boxNameCell(json, perms, maskedFallback = true) {
  const name = String(json?.name ?? "");
  const id = String(json?.id ?? "");
  if (!name || name !== id || !IMEI_LIKE.test(id)) return name;
  if (identityGranted(perms)) return name;
  return maskedFallback ? maskImei(id) : "";
}

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

/** 数据范围：1 全部、2 本单位及下级、3 本单位、4 仅本人、5 自定义(sys_role_dept)，数字越小越宽。旧数据 5 已由 055b 转 3。 */
export function scopeRank(value) {
  const n = Number(value);
  return n >= 1 && n <= 5 ? n : 4;
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
  const capEff = cap === 5 ? 3 : cap;
  const ranks = roles.map((role) => {
    const rk = scopeRank(role.data_scope);
    if (cap == null || isAdmin) return rk;
    // 自定义宽度在 rank5 分支内与 cap 取交集；被封顶到「仅本人」时直接按 rank4 算
    if (rk === 5) return capEff >= 4 ? 4 : 5;
    return Math.max(rk, capEff);
  });
  if (isAdmin || ranks.includes(1))
    return { all: true, orgIds: [], ownerIds: [], manageOrgIds: [] };
  const rows = depts || (await loadDepts(db));
  const tree = buildDeptTree(rows);
  const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
  const deptId = String(user.dept_id ?? user.deptId ?? "");
  const orgIds = new Set();
  const manage = new Set();
  const ownerIds = new Set();
  // #26 D3：自定义部门一次查齐（055b 建 sys_role_dept；更老的库没有这张表时按空算）
  let customRows = [];
  const customRoleIds = roles.filter((_, i) => ranks[i] === 5).map((role) => String(role.id));
  if (customRoleIds.length) {
    try {
      customRows = await db.all(
        `SELECT role_id, dept_id FROM sys_role_dept WHERE role_id IN (${customRoleIds.map(() => "?").join(",")})`,
        customRoleIds
      );
    } catch {
      customRows = [];
    }
  }
  for (const rank of ranks) {
    if (rank === 4) {
      ownerIds.add(String(user.id));
      continue;
    }
    if (rank === 5) {
      // 自定义范围 = sys_role_dept 各单位子树并集，再按部门上限封顶
      let union = new Set();
      for (const c of customRows)
        for (const id of collectDeptIds(tree, String(c.dept_id)) || [String(c.dept_id)])
          union.add(id);
      if (capEff != null && capEff !== 1) {
        const capIds =
          capEff === 2 ? collectDeptIds(tree, deptId) || [deptId] : capEff === 3 ? [deptId] : [];
        union = new Set([...union].filter((id) => capIds.includes(id)));
      }
      for (const id of union) {
        orgIds.add(id);
        manage.add(id);
      }
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

/**
 * 范围条件的唯一实现（L-P2-2）：单位、保管人、箱子三类 id 拼成 (a IN (?) OR b IN (?))。
 * 列名由 cols 显式给，不给裸列名做正则替换——正则改 SQL 一旦调用点带进 boxIds，
 * 裸 id 会静默绑到 sample_box.id 上，范围判断就错了。
 */
function scopeCondition(scope, cols) {
  if (!scope || scope.all) return null;
  const parts = [];
  const params = [];
  // boxIds 是工作台口径：经手进行中任务的箱子也算范围内（箱子可能已改挂单位/保管人）
  for (const [ids, col] of [
    [scope.orgIds, cols.org],
    [scope.ownerIds, cols.owner],
    [scope.boxIds, cols.box],
  ]) {
    if (!ids?.length) continue;
    parts.push(`${col} IN (${ids.map(() => "?").join(", ")})`);
    params.push(...ids);
  }
  if (!parts.length) return { sql: "1 = 0", params: [] };
  return { sql: `(${parts.join(" OR ")})`, params };
}

/**
 * 拼进 WHERE 的范围条件。范围为空时一台都不给。
 * prefix 给列名加表别名（sample_box 有别名的查询传 "b."），避免各调用点再手抄一份列名。
 */
export function scopeSql(scope, prefix = "") {
  return scopeCondition(scope, {
    org: `${prefix}org_id`,
    owner: `${prefix}owner_id`,
    box: `${prefix}id`,
  });
}

/**
 * 任务绑定箱子的历史快照口径：箱子的单位和保管人以 sample_task_box 建单时的快照为准，
 * 现在改挂了也还认那份快照，所以取 COALESCE(现在的箱子, 快照)；箱子编号只认快照表。
 */
export function historicalScopeSql(scope) {
  return scopeCondition(scope, {
    org: "COALESCE(b.org_id,m.org_id,'')",
    owner: "COALESCE(b.owner_id,m.owner_id,'')",
    box: "m.box_id",
  });
}

/**
 * 没有权限的字段直接拿掉，masked 告诉页面哪几块是无权查看而不是没数据（按 FIELD_GROUPS 的名字）。
 * 工况七项都没有时另记 status，设备标识三项都没有时另记 identity，旧页面照样能判断。
 * remote：设备固件支不支持远程抹除、读本机日志。不受「查看固件版本」影响，页面不用再看版本号。
 *
 * imei 是唯一不删只打码的：箱子编号现在就是 IMEI，页面导航、筛选、二维码全靠 id，删了整个页面就散了，
 * 所以无权限时把 imei 换成打码副本、masked 里记 "imei"。等编号换成独立代理键（见 refactor-plans）
 * 之后 id 不再等于 IMEI，这里就能直接删。
 * name 也跟着收口（M-1）：没起名时 BoxState.toJSON 把编号回显进 name，无权限时这个回显要清空，
 * 否则「名称」列、导出 CSV 的名称列等于又下发一遍整串 IMEI。
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
  if (!identityGranted(perms)) {
    copy.imei = maskImei(copy.imei || copy.id);
    masked.push("imei");
    // M-1：编号是 15 位纯数字、name 又和编号一模一样，才是 toJSON 的回显；
    // 真起过名的、老数据 BOX-001 那种非 IMEI 编号都不动，别把正常内容清掉。
    if (IMEI_LIKE.test(copy.id) && copy.name === copy.id) copy.name = "";
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

/**
 * 在线判定单一实现（与 SqlBoxStore.onlineSql 同口径）：仅充电且未充电豁免；有自身周期用
 * 3×周期，否则用 onlineSince；占用且从未上报走建单宽限（B3/#18）。
 * flagMatch 与列表 JSON 的 online 字段共用这一份——后者在查询时刻算好随箱下发，
 * 页面直接显示，不再拿可能过期的本地快照重算（快照比轮询间隔旧时会假离线）。
 * R13：宽限按箱解析公司层（limits.company，检测站期间＝寄出公司），无公司覆盖用全局。
 */
export function boxOnline(box, limits) {
  const last = String(box.last || "");
  const reportedAt = last ? Date.parse(last.replace(" ", "T")) : NaN;
  const seconds = Number(box.reportPeriodSec);
  const period = Number.isInteger(seconds) && seconds >= 5 ? seconds : null;
  const exempt = Boolean(box.reportOnlyWhenCharging) && Number(box.charge) === 0;
  const within =
    period == null
      ? last >= limits.onlineSince
      : Number.isFinite(reportedAt) && Date.now() - reportedAt <= period * 3000;
  // B3/#18 宽限：占用且从未上报，建单后 grace 内不算离线（与 onlineSql 同口径）
  const boundAt = String(box.boundTaskAt || "");
  const boundPending =
    !last &&
    Boolean(boundAt) &&
    Date.now() - Date.parse(boundAt.replace(" ", "T")) <= boxGraceSec(box, limits) * 1000;
  return (Boolean(last) && (exempt || within)) || boundPending;
}

/** 低电/可调配阈值按箱解析公司电量预留（R13 P1）：无公司覆盖时用调用点算好的全局值。 */
export function boxLowMv(box, limits) {
  return limits?.company ? usableMv(20, boxReserve(box, limits)) : limits.lowMv;
}
export function boxReadyMv(box, limits) {
  return limits?.company ? usableMv(50, boxReserve(box, limits)) : limits.readyMv;
}

export function flagMatch(box, flag, limits) {
  const online = boxOnline(box, limits);
  const mv = Number(box.batteryMv);
  if (flag === "alert") return Boolean(box.alert);
  if (flag === "offline") return !online;
  if (flag === "low") return mv > 0 && mv < boxLowMv(box, limits);
  if (flag === "lid") return Number(box.lid) === 1;
  if (flag === "ready") {
    return box.life === "未使用" && !box.alert && online && mv >= boxReadyMv(box, limits);
  }
  return true;
}

/**
 * #26 B1：组织维度 scope 的单一 SQL 片段（部门/日志/统计共用），与 scopeSql 同族。
 * mode='manage' 用 manageOrgIds（管人/管部门/日志 actor 口径），'view' 用 orgIds（看箱口径含祖先+HQ""）。
 * 列名显式传入并校验（沿用 L-P2-2 防正则改 SQL 教训）；空范围→1=0 不泄露；不限→1=1。
 * 手工构造的 scope 可能没有 manageOrgIds（如总览测试），manage 口径退回 orgIds，再退回空。
 */
export function orgScopeSql(scope, { col = "org_id", mode = "manage" } = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(col))
    throw new Error("非法标识符");
  if (!scope || scope.all) return { sql: "1=1", params: [] };
  const ids = ((mode === "manage" ? (scope.manageOrgIds ?? scope.orgIds) : scope.orgIds) || [])
    .map(String)
    .filter(Boolean);
  if (!ids.length) return { sql: "1=0", params: [] };
  return { sql: `${col} IN (${ids.map(() => "?").join(",")})`, params: ids };
}

/**
 * #26 B1：所有 auth 路由统一解析 ctx.access（消除「无 perm 路由 access=undefined → isAdmin 恒真」）。
 * 已解析则复用（per-request 缓存），未解析则 resolveAccess 并挂到 ctx。
 */
export async function requireAccess(db, ctx) {
  if (ctx.access) return ctx.access;
  ctx.access = await resolveAccess(db, ctx.user);
  return ctx.access;
}
