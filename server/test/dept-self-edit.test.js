/**
 * R27 自部门基本信息编辑（任务 #89，用户拍板「管理角色自部门基本信息编辑，结构归总部」）＋066 服务端契约：
 * - 066 幂等/两角色补码：BRANCH_ADMIN/STATION_ADMIN 缺 sys:dept:update 者补；grantable 沿该角色现有 max
 *   （无授权行时 0）；已有 update 不改不重；ADMIN 短路不落行；自定义角色/STATION_STAFF 不动；
 *   角色不存在跳过（不建角色）；_bak_066 双表留底；含 sys:dept:view 的受限部门上限同补防交集裁掉；重跑不变。
 * - 模板/新种子口径：DEFAULT_ROLE_PERMS.BRANCH_ADMIN 含 update 且不连带 type/address/camera/leader/enable/disable
 *   （SPLIT_045/061 会把 update 拆出这些码，升级链后置追加绕开）；seedRolePerms/ROLE_TEMPLATES 单源同口径；
 *   其他非 ADMIN 模板不借批补 update。
 * - updateDept 字段级守卫（isDeptSelfEdit：角色 code ∈ {BRANCH_ADMIN,STATION_ADMIN}＋非 ADMIN＋持 update）：
 *   改本单位 address/name 200 落库（update 即覆盖地址块，不另要地址码）；改 type/parent/status/code 403
 *   「组织结构调整请联系系统管理员」；回显结构原值不拦（整表保存仍可改资料）；改他单位仍 A0404/404（保持现状）；
 *   cameras 持 sys:dept:camera 放行、无码拒；station admin 本站 address 200、改 type 403；ADMIN 改 type 不回归。
 *   自定义角色（DESK/EDITOR）持 update 仍走原字段权限桶（dept-limit/perm-status-split 基线锁定，不借批扩面）。
 * - 审计：updateDept 成功 detail 带 before/after 差集（有变化才写，无变化不写空明细）。
 * - resolveAccess 端到端：066 后 BRANCH_ADMIN 真实用户 perms 含 update（含 view 的部门上限同补不被交集裁掉）。
 * 一次性临时库，不碰开发/线上库、不占服务端口（主夹具 8010 不写不碰）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ROLE_PERMS, ROLE_TEMPLATES, DEPT_SELF_EDIT_066 } from "../src/auth/permCatalog.js";
import { openDatabase, migrate } from "../db.js";
import { resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";
import * as org from "../org-api.js";
import { up as up066 } from "../migrations/066_dept_self_edit.js";

const UPDATE = "sys:dept:update";
/** 066 不借拆码扩面：update 不应连带这些结构/独立桶码进 BRANCH_ADMIN 模板。 */
const SPLIT_SIDE_CODES = [
  "sys:dept:type",
  "sys:dept:address",
  "sys:dept:camera",
  "sys:dept:leader",
  "sys:dept:enable",
  "sys:dept:disable",
];
const STRUCTURE_MSG = /组织结构调整请联系系统管理员/;

async function tempDb(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  return {
    db,
    close: async () => {
      await db.close?.();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const addRole = (db, id, code, scope = 2) =>
  db.run("INSERT INTO sys_role (id,name,code,data_scope,sort,status) VALUES (?,?,?,?,90,1)", [
    id,
    code,
    code,
    scope,
  ]);
const addRolePerm = (db, roleId, perm, grantable = 0) =>
  db.run("INSERT INTO sys_role_perm (role_id,perm,grantable) VALUES (?,?,?)", [
    roleId,
    perm,
    grantable,
  ]);
const addDept = (db, id, parent, name, type = "公司") =>
  db.run("INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,1,1,?)", [
    id,
    parent,
    name,
    `D${id}`,
    type,
  ]);
const addUser = (db, id, username, deptId, roles) =>
  db
    .run(
      "INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES (?,?,?,'x',?,1)",
      [id, username, username, deptId]
    )
    .then(() =>
      Promise.all(
        roles.map((r) =>
          db.run("INSERT INTO sys_user_role (user_id,role_id) VALUES (?,?)", [id, r])
        )
      )
    );
async function ctxOf(db, id) {
  const row = await db.get("SELECT * FROM sys_user WHERE id = ?", [id]);
  return { db, user: row, access: await resolveAccess(db, row) };
}
const adminCtx = (db) => ({
  db,
  user: { id: "1", dept_id: "1" },
  access: {
    roles: ["ADMIN"],
    perms: new Set(),
    grantable: new Set(),
    scope: { all: true, orgIds: [], ownerIds: [], manageOrgIds: [] },
  },
});
async function call(fn, ctx) {
  let out;
  await fn({
    query: {},
    params: {},
    body: {},
    ...ctx,
    ok: (data, message) => (out = { ok: true, data, message }),
    fail: (message, code, status) => (out = { ok: false, error: message, code, status }),
  });
  return out;
}

/* ── 066 迁移 ── */

test("066：两角色补码/grantable 沿现有 max/已有不改/ADMIN 短路/自定义与 STATION_STAFF 不动/部门上限同补/留底；重跑幂等", async () => {
  const env = await tempDb("dept-self-edit-066-");
  const { db } = env;
  try {
    // legacy 现状：BRANCH_ADMIN 缺 update（grantable=1）；STATION_ADMIN 已有 update（grantable=0，
    // 另有 list 行 grantable=1 → max=1，但已有 update 不应被改/重）；STATION_STAFF 缺 update 但非目标；
    // ADMIN/CUSTOM 对照。
    await addRole(db, "14", "BRANCH_ADMIN");
    await addRole(db, "91", "STATION_ADMIN", 3);
    await addRole(db, "92", "STATION_STAFF", 3);
    await addRole(db, "1", "ADMIN", 1);
    await addRole(db, "90", "CUSTOM");
    for (const perm of ["sys:dept:view", "sys:user:view"]) await addRolePerm(db, "14", perm, 1);
    await addRolePerm(db, "91", "device:box:list", 1);
    await addRolePerm(db, "91", UPDATE, 0); // 已有 update（grantable=0）
    await addRolePerm(db, "91", "sys:dept:view", 0);
    for (const perm of ["sys:dept:view", "device:box:list"]) await addRolePerm(db, "92", perm, 0);
    await addRolePerm(db, "1", "sys:role:view", 1);
    await addRolePerm(db, "90", "sys:dept:view", 0);
    // 受限部门上限：21 含 view（同补 update）；22 含 view 且已有 update（不动）；13 无 view（不动）
    for (const perm of ["sys:dept:view", "sys:user:view"])
      await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('21',?)", [perm]);
    for (const perm of ["sys:dept:view", UPDATE])
      await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('22',?)", [perm]);
    await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('13','device:box:detail')");
    // 清掉 migrate 期（空角色）留下的 066 备份，让本次 up 的备份捕获 legacy 现状
    await db.run("DROP TABLE IF EXISTS _bak_066_sys_role_perm");
    await db.run("DROP TABLE IF EXISTS _bak_066_sys_dept_perm");

    const snapshot = async () => ({
      role: await db.all(
        "SELECT role_id, perm, grantable FROM sys_role_perm ORDER BY role_id, perm"
      ),
      dept: await db.all("SELECT dept_id, perm FROM sys_dept_perm ORDER BY dept_id, perm"),
      roles: await db.all("SELECT id, code FROM sys_role ORDER BY id"),
    });
    await up066(db);
    const after1 = await snapshot();
    const permsOf = (roleId) =>
      new Set(after1.role.filter((r) => r.role_id === roleId).map((r) => r.perm));
    const rowsOf = (roleId, perm) =>
      after1.role.filter((r) => r.role_id === roleId && r.perm === perm);

    // BRANCH_ADMIN：补 update，grantable 沿现有 max=1
    assert.ok(permsOf("14").has(UPDATE), "BRANCH_ADMIN 应补 update");
    assert.deepEqual(
      rowsOf("14", UPDATE).map((r) => Number(r.grantable)),
      [1],
      "BRANCH_ADMIN 补码 grantable 沿现有 max=1，且不重复"
    );
    // STATION_ADMIN：已有 update 不改不重（grantable 保持 0，不借 max=1 抬升）
    assert.deepEqual(
      rowsOf("91", UPDATE).map((r) => Number(r.grantable)),
      [0],
      "已有 update 行不改（只补不删不改）"
    );
    // STATION_STAFF 非目标：不补 update
    assert.ok(!permsOf("92").has(UPDATE), "STATION_STAFF 不在本批，不补 update");
    // ADMIN 短路不落行；自定义角色不动
    assert.deepEqual(
      after1.role.filter((r) => r.role_id === "1").map((r) => r.perm),
      ["sys:role:view"],
      "ADMIN 不落行"
    );
    assert.deepEqual(
      after1.role.filter((r) => r.role_id === "90").map((r) => r.perm),
      ["sys:dept:view"],
      "自定义角色不动"
    );
    // 部门上限：21 同补 update；22 已有不动；13 无 view 不动
    const deptPerms = (id) => after1.dept.filter((d) => d.dept_id === id).map((d) => d.perm);
    assert.ok(deptPerms("21").includes(UPDATE), "部门21上限含 view 应补 update");
    assert.deepEqual(
      deptPerms("22").filter((p) => p === UPDATE),
      [UPDATE],
      "部门22上限已有 update 不重复"
    );
    assert.deepEqual(deptPerms("13"), ["device:box:detail"], "无 view 的部门上限不动");
    // 备份留底＝legacy 现状（BRANCH_ADMIN 不含 update；部门21 不含 update）
    const bakRole = await db.all("SELECT perm FROM _bak_066_sys_role_perm WHERE role_id='14'");
    assert.ok(!bakRole.some((r) => r.perm === UPDATE), "角色备份应为补码前现状");
    const bakDept = await db.all("SELECT perm FROM _bak_066_sys_dept_perm WHERE dept_id='21'");
    assert.ok(!bakDept.some((r) => r.perm === UPDATE), "部门备份应为补码前现状");
    // 重跑幂等：结果完全不变（含角色本体行数、备份不被覆盖）
    await up066(db);
    assert.deepEqual(await snapshot(), after1, "066 重跑结果应不变");
    const bakAgain = await db.all("SELECT perm FROM _bak_066_sys_role_perm WHERE role_id='14'");
    assert.ok(!bakAgain.some((r) => r.perm === UPDATE), "_bak_066 不被重跑覆盖");
  } finally {
    await env.close();
  }
});

test("066：角色不存在跳过（不建角色）；无授权行的目标角色补码 grantable=0；无 sys_role 的老库直接返回", async () => {
  const env = await tempDb("dept-self-edit-066-missing-");
  const { db } = env;
  try {
    // 只有 BRANCH_ADMIN（无任何授权行）＋ADMIN；STATION_ADMIN 不存在
    await addRole(db, "14", "BRANCH_ADMIN");
    await addRole(db, "1", "ADMIN", 1);
    await addRolePerm(db, "1", "sys:role:view", 1);
    await up066(db);
    const rows = await db.all(
      "SELECT perm, grantable FROM sys_role_perm WHERE role_id='14' ORDER BY perm"
    );
    assert.deepEqual(
      rows.map((r) => [r.perm, Number(r.grantable)]),
      [[UPDATE, 0]],
      "无授权行的 BRANCH_ADMIN 补 update 且 grantable=0"
    );
    const roles = await db.all("SELECT code FROM sys_role ORDER BY id");
    assert.deepEqual(
      roles.map((r) => r.code),
      ["ADMIN", "BRANCH_ADMIN"],
      "不存在的 STATION_ADMIN 不新建"
    );
    // 老库没有 sys_role 表：按 045/062/063/065 先例直接返回，不抛错、不再动权限行
    const before = await db.all(
      "SELECT role_id, perm, grantable FROM sys_role_perm ORDER BY role_id, perm"
    );
    await db.run("DROP TABLE sys_role");
    await up066(db);
    assert.deepEqual(
      await db.all("SELECT role_id, perm, grantable FROM sys_role_perm ORDER BY role_id, perm"),
      before,
      "无 sys_role 时直接返回，权限行不变"
    );
  } finally {
    await env.close();
  }
});

test("模板/新种子：BRANCH_ADMIN 含 update 不连带结构/独立桶码；seedRolePerms/ROLE_TEMPLATES 单源；其他模板不借批补 update", async () => {
  // 模板口径（升级链后置追加，绕开 SPLIT_045/061 的 update 连带拆码）
  const branch = DEFAULT_ROLE_PERMS.BRANCH_ADMIN;
  for (const code of DEPT_SELF_EDIT_066) assert.ok(branch.includes(code), `模板应含 ${code}`);
  for (const code of SPLIT_SIDE_CODES)
    assert.ok(!branch.includes(code), `模板补 update 不连带 ${code}（超出拍板口径）`);
  assert.equal(new Set(branch).size, branch.length, "模板码集无重复");
  const template = ROLE_TEMPLATES.find((t) => t.key === "BRANCH_ADMIN");
  assert.ok(template.codes.includes(UPDATE), "ROLE_TEMPLATES 单源随模板");
  for (const key of ["SAMPLER", "DUTY", "VERIFY", "LEADER", "DISPATCH", "ASSET"])
    assert.ok(!DEFAULT_ROLE_PERMS[key].includes(UPDATE), `${key} 模板不借批补 update`);

  // 新库种子：BRANCH_ADMIN 走模板（grantable=1，grantsAll）；DB-only 的 STATION_ADMIN 无模板
  // 默认值（seedRolePerms 跳过），由 066 补码——生产路径＝先有角色行再跑迁移。
  const env = await tempDb("dept-self-edit-seed-");
  const { db } = env;
  try {
    await addRole(db, "14", "BRANCH_ADMIN");
    await addRole(db, "91", "STATION_ADMIN", 3);
    await seedRolePerms(db);
    const seeded = await db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id='14'");
    const have = new Set(seeded.map((r) => r.perm));
    assert.ok(have.has(UPDATE), "新库 BRANCH_ADMIN 应含 update");
    for (const code of SPLIT_SIDE_CODES) assert.ok(!have.has(code), `新库种子不连带 ${code}`);
    for (const row of seeded.filter((r) => r.perm === UPDATE))
      assert.equal(Number(row.grantable), 1, "种子 grantable=1（grantsAll）");
    assert.equal(
      (await db.all("SELECT perm FROM sys_role_perm WHERE role_id='91'")).length,
      0,
      "DB-only 角色无模板默认值（seedRolePerms 跳过）"
    );
    await up066(db);
    const station = new Set(
      (await db.all("SELECT perm FROM sys_role_perm WHERE role_id='91'")).map((r) => r.perm)
    );
    assert.ok(station.has(UPDATE), "066 应给 DB-only 角色补 update");
  } finally {
    await env.close();
  }
});

/* ── updateDept 字段级守卫 ── */

/** 守卫测试夹具：总公司1／华南分公司2（子21/22）／华东分公司3（他单位）／总部检测站13。 */
async function seedGuard(db) {
  await addDept(db, "1", "0", "总公司");
  await addDept(db, "2", "1", "华南分公司");
  await addDept(db, "21", "2", "调度一室");
  await addDept(db, "22", "2", "调度二室");
  await addDept(db, "3", "1", "华东分公司");
  await addDept(db, "13", "1", "总部检测站", "检测站");
  await addRole(db, "1", "ADMIN", 1);
  // 分公司管理员：仅 view＋update（无地址/类型/启停/监控码）——验证 update 即覆盖地址块
  await addRole(db, "14", "BRANCH_ADMIN", 2);
  await addRolePerm(db, "14", "sys:dept:view", 0);
  await addRolePerm(db, "14", UPDATE, 0);
  // 站点管理员：仅 view＋update（DB-only 角色形态）
  await addRole(db, "91", "STATION_ADMIN", 3);
  await addRolePerm(db, "91", "sys:dept:view", 0);
  await addRolePerm(db, "91", UPDATE, 0);
  await addUser(db, "1", "admin", "1", ["1"]);
  await addUser(db, "10", "branch", "2", ["14"]);
  await addUser(db, "91", "station", "13", ["91"]);
}

test("守卫：branch 改本单位 address/name 200 落库；type/parent/status/code 403 结构文案；他单位 A0404；回显原值不拦", async () => {
  const env = await tempDb("dept-self-edit-guard-");
  const { db } = env;
  try {
    await seedGuard(db);
    const branch = await ctxOf(db, "10");
    assert.ok(branch.access.perms.has(UPDATE), "branch 持 update");
    assert.ok(
      !branch.access.perms.has("sys:dept:address"),
      "branch 无地址码（验证 update 即覆盖）"
    );
    assert.deepEqual(
      branch.access.scope.manageOrgIds.sort(),
      ["2", "21", "22"],
      "manage＝本单位子树"
    );

    // 改地址（仅持 update）→ 200 落库
    const addr = await call(org.updateDept, {
      ...branch,
      params: { id: "2" },
      body: {
        address: "深圳某路 1 号",
        lng: 114.1,
        lat: 22.6,
        contact: "张三",
        phone: "13800000000",
      },
    });
    assert.equal(addr.ok, true, addr.error);
    const row = await db.get("SELECT address, contact, phone FROM sys_dept WHERE id='2'");
    assert.equal(row.address, "深圳某路 1 号", "地址落库");
    assert.equal(row.contact, "张三");
    assert.equal(row.phone, "13800000000");
    // 改名 → 200
    assert.equal(
      (await call(org.updateDept, { ...branch, params: { id: "2" }, body: { name: "华南一" } })).ok,
      true
    );
    assert.equal((await db.get("SELECT name FROM sys_dept WHERE id='2'")).name, "华南一");
    // 改排序 → 200（allowlist 内）
    assert.equal(
      (await call(org.updateDept, { ...branch, params: { id: "2" }, body: { sort: 5 } })).ok,
      true
    );

    // 改类型 → 403 结构文案（即使无 type 码也回统一文案，置于桶前）
    const type = await call(org.updateDept, {
      ...branch,
      params: { id: "2" },
      body: { type: "检测站" },
    });
    assert.equal(type.ok, false);
    assert.equal(type.code, "A0301");
    assert.equal(type.status, 403);
    assert.match(type.error, STRUCTURE_MSG);
    // 改上级（21 改挂 22，均在本单位子树内，范围校验通过）→ 403 结构文案
    const parent = await call(org.updateDept, {
      ...branch,
      params: { id: "21" },
      body: { parentId: "22" },
    });
    assert.equal(parent.ok, false);
    assert.equal(parent.status, 403);
    assert.match(parent.error, STRUCTURE_MSG);
    // 改启停 → 403 结构文案
    for (const status of [0, 1]) {
      const st = await call(org.updateDept, {
        ...branch,
        params: { id: "2" },
        body: { status },
      });
      // status=1 与现状相同→不拦（回显）；status=0 变更→拦
      if (status === 0) {
        assert.equal(st.ok, false);
        assert.equal(st.status, 403);
        assert.match(st.error, STRUCTURE_MSG);
      }
    }
    // 改编码 → 403 结构文案（身份字段归总部）
    const code = await call(org.updateDept, {
      ...branch,
      params: { id: "2" },
      body: { code: "NEWCODE" },
    });
    assert.equal(code.ok, false);
    assert.equal(code.status, 403);
    assert.match(code.error, STRUCTURE_MSG);

    // 改他单位（华东分公司3，范围外）→ 保持现状 A0404/404（不泄露存在性）
    const other = await call(org.updateDept, {
      ...branch,
      params: { id: "3" },
      body: { name: "改他单位" },
    });
    assert.equal(other.ok, false);
    assert.equal(other.code, "A0404");
    assert.equal(other.status, 404);

    // 整表保存回显结构原值（type/status/parentId/code 均未变）＋改名 → 200（不误拦）
    const echo = await call(org.updateDept, {
      ...branch,
      params: { id: "2" },
      body: { name: "华南二", type: "公司", status: 1, parentId: "1", code: "D2", sort: 5 },
    });
    assert.equal(echo.ok, true, echo.error);
    assert.equal((await db.get("SELECT name FROM sys_dept WHERE id='2'")).name, "华南二");
  } finally {
    await env.close();
  }
});

test("守卫：cameras 持码放行/无码拒；station admin 本站 address 200、改 type 403；ADMIN 改 type 不回归", async () => {
  const env = await tempDb("dept-self-edit-guard2-");
  const { db } = env;
  try {
    await seedGuard(db);
    const branch = await ctxOf(db, "10");
    // 无 camera 码改监控 → 原桶拒（403「监控通道」）
    const camDenied = await call(org.updateDept, {
      ...branch,
      params: { id: "2" },
      body: { cameras: [{ name: "通道1" }] },
    });
    assert.equal(camDenied.ok, false);
    assert.equal(camDenied.status, 403);
    assert.match(camDenied.error, /监控通道/);
    // 补 camera 码后放行（持 sys:dept:camera 即可，沿现状）
    await addRolePerm(db, "14", "sys:dept:camera", 0);
    const branchCam = await ctxOf(db, "10");
    const camOk = await call(org.updateDept, {
      ...branchCam,
      params: { id: "2" },
      body: { cameras: [{ name: "通道1" }] },
    });
    assert.equal(camOk.ok, true, camOk.error);
    assert.equal(
      (await call(org.deptForm, { ...branchCam, params: { id: "2" } })).data.cameras.length,
      1
    );

    // 站点管理员：本站（检测站13）改地址 → 200 落库
    const station = await ctxOf(db, "91");
    assert.deepEqual(station.access.scope.manageOrgIds, ["13"], "station manage＝本站");
    const stAddr = await call(org.updateDept, {
      ...station,
      params: { id: "13" },
      body: { address: "检测站路 9 号", contact: "李四" },
    });
    assert.equal(stAddr.ok, true, stAddr.error);
    assert.equal(
      (await db.get("SELECT address FROM sys_dept WHERE id='13'")).address,
      "检测站路 9 号"
    );
    // 站点管理员改类型（检测站→公司）→ 403 结构文案
    const stType = await call(org.updateDept, {
      ...station,
      params: { id: "13" },
      body: { type: "公司" },
    });
    assert.equal(stType.ok, false);
    assert.equal(stType.status, 403);
    assert.match(stType.error, STRUCTURE_MSG);

    // ADMIN 改类型不回归：检测站13→公司 200（释放唯一名额，org-b1b 同款）
    const admin = adminCtx(db);
    const adminType = await call(org.updateDept, {
      ...admin,
      params: { id: "13" },
      body: { type: "公司" },
    });
    assert.equal(adminType.ok, true, adminType.error);
    assert.equal((await db.get("SELECT type FROM sys_dept WHERE id='13'")).type, "公司");
    // ADMIN 改启停/上级/编码全字段不受守卫限
    assert.equal(
      (await call(org.updateDept, { ...admin, params: { id: "2" }, body: { status: 0 } })).ok,
      true
    );
    assert.equal(
      (await call(org.updateDept, { ...admin, params: { id: "2" }, body: { code: "D2X" } })).ok,
      true
    );
  } finally {
    await env.close();
  }
});

test("守卫：自定义角色（DESK）持 update 仍走原字段权限桶——改地址要地址码（不借 066 扩面）", async () => {
  const env = await tempDb("dept-self-edit-desk-");
  const { db } = env;
  try {
    await addDept(db, "2", "0", "华南分公司");
    await addDept(db, "21", "2", "调度室");
    await addRole(db, "7", "DESK", 3);
    for (const perm of ["sys:dept:view", UPDATE, "sys:dept:create"])
      await addRolePerm(db, "7", perm, 0);
    await addUser(db, "10", "desk", "21", ["7"]);
    const desk = await ctxOf(db, "10");
    // DESK 非 BRANCH_ADMIN/STATION_ADMIN：改地址仍要 sys:dept:address（dept-limit 基线口径）
    const addr = await call(org.updateDept, {
      ...desk,
      params: { id: "21" },
      body: { address: "深圳某路" },
    });
    assert.equal(addr.ok, false);
    assert.match(addr.error, /设置部门地址和联系人/);
    // 改名仍要 update（持有）→ 200
    assert.equal(
      (await call(org.updateDept, { ...desk, params: { id: "21" }, body: { name: "调度一室" } }))
        .ok,
      true
    );
  } finally {
    await env.close();
  }
});

test("审计：updateDept 成功 detail 带 before/after 差集；无变化不写空明细", async () => {
  const env = await tempDb("dept-self-edit-audit-");
  const { db } = env;
  try {
    await seedGuard(db);
    const branch = await ctxOf(db, "10");
    await call(org.updateDept, {
      ...branch,
      params: { id: "2" },
      body: { address: "新地址 8 号", name: "华南改" },
    });
    const log = await db.get(
      "SELECT detail FROM sys_operation_log WHERE target_type='dept' AND target_id='2' AND action='修改部门' AND result='成功' ORDER BY id DESC LIMIT 1"
    );
    assert.ok(log && log.detail, "成功审计应带 detail");
    const detail = JSON.parse(log.detail);
    assert.equal(detail.address.before, null, "改前地址为空（夹具未设）");
    assert.equal(detail.address.after, "新地址 8 号");
    assert.equal(detail.name.before, "华南分公司");
    assert.equal(detail.name.after, "华南改");
    assert.ok(!detail.status, "未变更字段不进差集");
    // 无变化保存（回显原值）→ 不写空明细
    await call(org.updateDept, {
      ...branch,
      params: { id: "2" },
      body: { name: "华南改", address: "新地址 8 号" },
    });
    const noop = await db.get(
      "SELECT detail FROM sys_operation_log WHERE target_type='dept' AND target_id='2' AND action='修改部门' AND result='成功' ORDER BY id DESC LIMIT 1"
    );
    assert.equal(noop.detail, "", "无变化不写空明细");
  } finally {
    await env.close();
  }
});

test("resolveAccess 端到端：066 后 BRANCH_ADMIN 真实用户 perms 含 update；含 view 的部门上限同补不被交集裁掉", async () => {
  const env = await tempDb("dept-self-edit-access-");
  const { db } = env;
  try {
    await addDept(db, "1", "0", "总公司");
    await addDept(db, "2", "1", "华南分公司");
    await addDept(db, "3", "1", "华东分公司");
    // 部门2 开单独限制、上限含 view（066 同补 update）；部门3 上限仅 view 也补；
    // 另设部门4 上限不含 view（不动，update 被裁）
    await addDept(db, "4", "1", "西北分公司");
    for (const id of ["2", "3", "4"])
      await db.run("UPDATE sys_dept SET perm_limited = 1 WHERE id = ?", [id]);
    for (const perm of ["sys:dept:view", "sys:user:view"])
      await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('2',?)", [perm]);
    await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('3','sys:dept:view')");
    await db.run("INSERT INTO sys_dept_perm (dept_id,perm) VALUES ('4','device:box:detail')");
    await addRole(db, "14", "BRANCH_ADMIN", 2);
    await addRolePerm(db, "14", "sys:dept:view", 0);
    await addUser(db, "10", "branch", "2", ["14"]);
    await addUser(db, "11", "branch4", "4", ["14"]);
    const user10 = await db.get("SELECT * FROM sys_user WHERE id='10'");
    const before = await resolveAccess(db, user10);
    assert.ok(!before.perms.has(UPDATE), "066 前 BRANCH_ADMIN 无 update（根因态）");

    await up066(db);
    const after = await resolveAccess(db, user10);
    assert.ok(after.rolePerms.has(UPDATE), "角色层面已补 update");
    assert.ok(after.perms.has(UPDATE), "066 后含 view 上限部门2 同补 update，不被交集裁掉");
    // 部门4 上限不含 view → 066 不动该上限；角色虽补 update，仍被交集裁掉（上限是上界不是授权）
    const user11 = await db.get("SELECT * FROM sys_user WHERE id='11'");
    const cut = await resolveAccess(db, user11);
    assert.ok(cut.rolePerms.has(UPDATE), "角色层面已补 update");
    assert.ok(!cut.perms.has(UPDATE), "无 view 上限部门仍裁掉 update");

    // 全链：066 → resolveAccess → updateDept 自编辑地址 200
    const ctx = { db, user: user10, access: after };
    const res = await call(org.updateDept, {
      ...ctx,
      params: { id: "2" },
      body: { address: "端到端地址 1 号" },
    });
    assert.equal(res.ok, true, res.error);
    assert.equal(
      (await db.get("SELECT address FROM sys_dept WHERE id='2'")).address,
      "端到端地址 1 号"
    );
  } finally {
    await env.close();
  }
});
