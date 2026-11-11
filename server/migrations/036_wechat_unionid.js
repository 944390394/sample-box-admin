/**
 * 绑定的微信记下 UnionID：小程序绑到微信开放平台账号后，code2Session 会一并返回，用户不用授权。
 * 同一开放平台下的小程序、App（多端应用）里同一个人的 UnionID 相同，App 微信登录靠它认出已经在小程序里绑过的人。
 * 小程序没绑开放平台时为空字符串。
 * 一个账号在小程序、App 各有一条绑定（openid 不同），唯一约束从「一个账号一条」改成「一个账号每个应用一条」。
 */
export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sys_user_wechat")
      : await db.all("PRAGMA table_info(sys_user_wechat)");
  const names = new Set(columns.map((r) => r.Field || r.name));
  if (!names.has("unionid")) {
    await db.run(
      `ALTER TABLE sys_user_wechat ADD COLUMN unionid ${db.dialect === "mysql" ? "VARCHAR(64) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''"}`
    );
  }
  if (db.dialect === "mysql") {
    const indexes = await db.all("SHOW INDEX FROM sys_user_wechat");
    const has = (name) => indexes.some((r) => r.Key_name === name);
    if (!has("idx_user_wechat_unionid"))
      await db.run("CREATE INDEX idx_user_wechat_unionid ON sys_user_wechat (unionid)");
    if (!has("uk_user_wechat_user_app"))
      await db.run(
        "CREATE UNIQUE INDEX uk_user_wechat_user_app ON sys_user_wechat (user_id, appid)"
      );
    if (has("uk_user_wechat_user"))
      await db.run("DROP INDEX uk_user_wechat_user ON sys_user_wechat");
  } else {
    await db.run("CREATE INDEX IF NOT EXISTS idx_user_wechat_unionid ON sys_user_wechat (unionid)");
    await db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS uk_user_wechat_user_app ON sys_user_wechat (user_id, appid)"
    );
    await db.run("DROP INDEX IF EXISTS uk_user_wechat_user");
  }
}
