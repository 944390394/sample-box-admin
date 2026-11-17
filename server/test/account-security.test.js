import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase, migrate, seedOrg } from "../db.js";
import { AccountSecurity } from "../src/auth/AccountSecurity.js";
import { sessionMatches, sessionClaims, verifyPassword } from "../auth.js";
import { resetPassword } from "../org-api.js";

test("自助改密校验、限流、并发保护和会话撤销；管理员重置仍可恢复", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "account-security-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  try {
    await migrate(db);
    await seedOrg(db);
    let user = await db.get("SELECT * FROM sys_user WHERE username='admin'");
    let now = 1,
      invalidated = 0;
    const security = new AccountSecurity({ now: () => now });
    const call = async (body, handler = (ctx) => security.changePassword(ctx)) => {
      let result;
      await handler({
        db,
        user,
        body,
        params: { id: user.id },
        query: { password: "admin-reset-test-1" },
        invalidateSessions: () => invalidated++,
        ok: (data) => (result = { ok: true, data }),
        fail: (message, code, status) => (result = { message, code, status }),
      });
      return result;
    };
    const change = {
      oldPassword: "123456",
      newPassword: "isolated-new-password-1",
      confirmPassword: "isolated-new-password-1",
    };
    const old = sessionClaims(user),
      legacy = { userId: user.id },
      refresh = { ...old, typ: "refresh" };
    assert.ok(sessionMatches(old, user));
    assert.ok(sessionMatches(legacy, user));
    assert.ok(!sessionMatches(refresh, user));
    assert.ok(sessionMatches(refresh, user, "refresh"));
    assert.equal((await call({ ...change, confirmPassword: "different" })).status, 400);
    assert.equal((await call({ ...change, newPassword: "short" })).status, 400);
    for (let i = 0; i < 5; i++)
      assert.equal((await call({ ...change, oldPassword: "wrong" })).status, 400);
    assert.equal((await call(change)).status, 429);
    now += 15 * 60000;
    const results = await Promise.all([call(change), call(change)]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(invalidated, 1);
    const current = await db.get("SELECT * FROM sys_user WHERE id=?", [user.id]);
    assert.ok(verifyPassword(change.newPassword, current.password_hash));
    assert.ok(!verifyPassword("123456", current.password_hash));
    for (const token of [old, legacy, refresh])
      assert.ok(!sessionMatches(token, current, token.typ || "access"));
    assert.equal((await call(change)).status, 401);
    user = current;
    assert.ok((await call({}, resetPassword)).ok);
    const reset = await db.get("SELECT * FROM sys_user WHERE id=?", [user.id]);
    assert.ok(verifyPassword("admin-reset-test-1", reset.password_hash));
    assert.equal(Number(reset.must_change_password), 1);
    assert.ok(!sessionMatches(sessionClaims(user), reset));
    assert.equal(invalidated, 2);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
