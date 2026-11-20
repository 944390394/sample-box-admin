/**
 * #26 B1：部门读 scope（D2 = manage 子树 + 祖先只读壳）。
 * listDepts/deptOptions/deptForm/deptLimit读 按 manageOrgIds 子树 + 祖先壳过滤；
 * 写保持 deptInManage；范围类拒绝带码 A0404/404，权限类 A0301/403。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrate, openDatabase, seedOrg } from "../db.js";
import * as org from "../org-api.js";
import { resolveAccess, seedRolePerms } from "../src/auth/boxAccess.js";

async function fresh() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dept-read-scope-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  await migrate(db);
  await seedOrg(db);
  await seedRolePerms(db);
  return {
    db,
    close: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

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

async function ctxOf(db, username) {
  const user = await db.get("SELECT * FROM sys_user WHERE username = ?", [username]);
  return { db, user, access: await resolveAccess(db, user), security: null };
}

const idsOf = (nodes) => nodes.map((node) => String(node.id));

test("部门树/选项只含 manage 子树 + 祖先只读壳（D2），兄弟与旁支不泄露", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    // chen.ke 在 21 调度室（DISPATCH scope2）：manage=[21]，祖先 2 是只读壳
    const desk = await ctxOf(db, "chen.ke");
    const tree = (await call(org.listDepts, desk)).data;
    assert.deepEqual(idsOf(tree), ["2"]);
    assert.equal(tree[0].readOnly, true, "祖先部门是只读壳");
    assert.deepEqual(idsOf(tree[0].children), ["21"]);
    assert.ok(!tree[0].children[0].readOnly, "manage 子树内不是壳");

    const options = (await call(org.deptOptions, desk)).data;
    assert.deepEqual(
      options.map((node) => node.value),
      ["2"]
    );
    assert.equal(options[0].readOnly, true);
    assert.deepEqual(
      options[0].children.map((node) => node.value),
      ["21"]
    );

    // 组织简化（B1b）：机构层删除、AGENCY_LEAD 并入 BRANCH_ADMIN——
    // 分公司管理员挂华东调度室 31（BRANCH_ADMIN scope2）：3 是只读壳，31 可管，兄弟分公司不出现
    await db.run(
      "INSERT INTO sys_user (id, username, nickname, password_hash, dept_id, status) VALUES ('90', 'branch.lead', 'branch.lead', 'x', '31', 1)"
    );
    await db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES ('90', '12')");
    const lead = await ctxOf(db, "branch.lead");
    const leadTree = (await call(org.listDepts, lead)).data;
    assert.deepEqual(idsOf(leadTree), ["3"]);
    assert.equal(leadTree[0].readOnly, true);
    assert.deepEqual(idsOf(leadTree[0].children), ["31"]);

    // 管理员全量；采样员（仅本人）没有部门范围
    const admin = await ctxOf(db, "admin");
    const full = (await call(org.listDepts, admin)).data;
    assert.deepEqual(idsOf(full).sort(), ["1", "2", "3", "4"]);
    assert.ok(!full.some((node) => node.readOnly));
    // 默认种子：13 总部检测站 type=检测站（唯一），机构子树 5/51/52/511/521 不再种
    const station = full.find((node) => node.id === "1").children.find((node) => node.id === "13");
    assert.equal(station.name, "总部检测站");
    assert.equal(station.type, "检测站");
    assert.ok(!full.some((node) => node.id === "5"));
    const sampler = await ctxOf(db, "lin.xia");
    assert.deepEqual((await call(org.listDepts, sampler)).data, []);
    assert.deepEqual((await call(org.deptOptions, sampler)).data, []);
  } finally {
    await env.close();
  }
});

test("deptForm/deptLimit读：范围内与祖先壳可读，范围外 A0404/404；写仍按 manage 拒绝", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    const desk = await ctxOf(db, "chen.ke");
    // 祖先壳可读（保留组织上下文），但标只读
    const shell = await call(org.deptForm, { ...desk, params: { id: "2" } });
    assert.equal(shell.ok, true, shell.error);
    assert.equal(shell.data.readOnly, true);
    const own = await call(org.deptForm, { ...desk, params: { id: "21" } });
    assert.equal(own.ok, true, own.error);
    assert.ok(!own.data.readOnly);

    for (const id of ["3", "4", "11", "13"]) {
      const denied = await call(org.deptForm, { ...desk, params: { id } });
      assert.equal(denied.ok, false, `部门 ${id} 竟然可读`);
      assert.equal(denied.code, "A0404", `部门 ${id} 实际 ${denied.code}`);
      assert.equal(denied.status, 404);
      const limit = await call(org.deptLimit, { ...desk, params: { id } });
      assert.equal(limit.code, "A0404");
      assert.equal(limit.status, 404);
    }

    // 祖先壳的 limit 可读但不可编辑
    const shellLimit = await call(org.deptLimit, { ...desk, params: { id: "2" } });
    assert.equal(shellLimit.ok, true, shellLimit.error);
    assert.equal(shellLimit.data.editable, false);

    // 写保持 deptInManage：改祖先部门 → A0404
    const write = await call(org.updateDept, {
      ...desk,
      params: { id: "2" },
      body: { name: "改上级" },
    });
    assert.equal(write.ok, false);
    assert.equal(write.code, "A0404");
    assert.equal(write.status, 404);

    // 人员范围拒绝同样带码；权限类拒绝 A0301
    const outsider = await call(org.updateUser, {
      ...desk,
      params: { id: "2" },
      body: { nickname: "改总部的人" },
    });
    assert.equal(outsider.code, "A0404");
    assert.equal(outsider.status, 404);
  } finally {
    await env.close();
  }
});

test("权限类拒绝带码 A0301/403（编辑人员资料为例）", async () => {
  const env = await fresh();
  const { db } = env;
  try {
    // 只有查看权限的值班角色：能进人员页，改资料被 A0301 挡
    await db.run(
      "INSERT INTO sys_role (id, name, code, data_scope, sort, status) VALUES ('90', '只读人员', 'USER_VIEW', 3, 90, 1)"
    );
    await db.run("INSERT INTO sys_role_perm (role_id, perm) VALUES ('90', 'sys:user:view')");
    await db.run(
      "INSERT INTO sys_user (id, username, nickname, password_hash, dept_id, status) VALUES ('91', 'viewer', 'viewer', 'x', '21', 1)"
    );
    await db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES ('91', '90')");
    const viewer = await ctxOf(db, "viewer");
    const denied = await call(org.updateUser, {
      ...viewer,
      params: { id: "6" },
      body: { nickname: "改名" },
    });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /编辑人员资料/);
    assert.equal(denied.code, "A0301");
    assert.equal(denied.status, 403);
  } finally {
    await env.close();
  }
});
