import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase, migrate, seedOrg } from "../db.js";
import { createUser, updateUser, resetPassword } from "../org-api.js";
import { verifyPassword } from "../auth.js";

test("avatar writes are rejected while user edits and administrator password reset still work", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sample-avatar-test-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "test.db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await seedOrg(db);
    const admin = await db.get("SELECT * FROM sys_user WHERE username = ?", ["admin"]);
    const invoke = async (handler, body = {}, query = {}, id = admin.id) => {
      let result;
      await handler({
        db,
        user: admin,
        body,
        query,
        params: { id },
        ok: (data) => {
          result = { ok: true, data };
        },
        fail: (message, code, status) => {
          result = { ok: false, message, code, status };
        },
      });
      return result;
    };
    const beforeCount = (await db.all("SELECT id FROM sys_user")).length;
    for (const avatar of [
      "https://example.invalid/avatar.png",
      "data:image/png;base64,AAAA",
      false,
      {},
      [],
    ]) {
      for (const handler of [createUser, updateUser]) {
        const result = await invoke(handler, {
          username: "blocked",
          nickname: "不可写入",
          deptId: admin.dept_id,
          avatar,
        });
        assert.equal(result.status, 400);
        assert.equal(result.message, "头像上传未开通");
      }
    }
    assert.equal((await db.all("SELECT id FROM sys_user")).length, beforeCount);
    assert.equal(
      (await db.get("SELECT nickname FROM sys_user WHERE id = ?", [admin.id])).nickname,
      admin.nickname
    );

    const legacy = "https://example.invalid/legacy.png";
    await db.run("UPDATE sys_user SET avatar = ? WHERE id = ?", [legacy, admin.id]);
    for (const avatar of [undefined, "", null]) {
      const result = await invoke(updateUser, {
        nickname: "更新昵称",
        mobile: "13800000000",
        email: "test@example.invalid",
        avatar,
      });
      assert.equal(result.ok, true);
      const stored = await db.get("SELECT * FROM sys_user WHERE id = ?", [admin.id]);
      assert.equal(stored.avatar, legacy);
      assert.equal(stored.nickname, "更新昵称");
      assert.equal(stored.mobile, "13800000000");
      assert.equal(stored.email, "test@example.invalid");
    }
    for (const [i, avatar] of [undefined, "", null].entries()) {
      assert.equal(
        (
          await invoke(createUser, {
            username: `new-user-${i}`,
            nickname: "新用户",
            deptId: admin.dept_id,
            avatar,
          })
        ).ok,
        true
      );
      assert.equal(
        (await db.get("SELECT avatar FROM sys_user WHERE username = ?", [`new-user-${i}`])).avatar,
        ""
      );
    }
    assert.equal((await invoke(resetPassword, {}, { password: "test-password-2026" })).ok, true);
    const updated = await db.get("SELECT * FROM sys_user WHERE id = ?", [admin.id]);
    assert.notEqual(updated.password_hash, admin.password_hash);
    assert.equal(verifyPassword("test-password-2026", updated.password_hash), true);
    assert.equal(updated.avatar, legacy);
  } finally {
    await db.close();
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(dir, { recursive: true, force: true });
  }
});
