import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase, migrate, seedOrg } from "../db.js";
import { forcePasswordChange, skipPasswordChange } from "../org-api.js";

test("免除首次改密只有系统管理员能做，做完不再要求改密", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skip-password-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await seedOrg(db);
    const target = await db.get(
      "SELECT * FROM sys_user WHERE username <> 'admin' ORDER BY id LIMIT 1"
    );
    const run = async (handler, roles) => {
      let result;
      await handler({
        db,
        user: { id: "1" },
        params: { id: target.id },
        body: {},
        access: {
          roles,
          perms: new Set(["sys:user:force-password"]),
          scope: { all: true, orgIds: [], ownerIds: [] },
        },
        ok: (data, msg) => (result = { ok: true, msg }),
        fail: (message) => (result = { ok: false, message }),
      });
      return result;
    };
    assert.ok((await run(forcePasswordChange, ["ADMIN"])).ok);
    assert.equal(
      Number(
        (await db.get("SELECT must_change_password m FROM sys_user WHERE id=?", [target.id])).m
      ),
      1
    );
    const denied = await run(skipPasswordChange, ["OPERATOR"]);
    assert.equal(denied.ok, false);
    assert.match(denied.message, /只有系统管理员/);
    assert.equal(
      Number(
        (await db.get("SELECT must_change_password m FROM sys_user WHERE id=?", [target.id])).m
      ),
      1
    );
    assert.ok((await run(skipPasswordChange, ["ADMIN"])).ok);
    assert.equal(
      Number(
        (await db.get("SELECT must_change_password m FROM sys_user WHERE id=?", [target.id])).m
      ),
      0
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
