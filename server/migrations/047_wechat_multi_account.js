/**
 * 一个微信可以绑多个账号：绑定表的主键从 openid 改成（openid, user_id）。
 * 一个账号在同一个应用里仍只绑一个微信（uk_user_wechat_user_app 不变）。
 * SQLite 改不了主键，按新结构建表、搬数据、换名；MySQL 直接换主键。已经是新结构的跳过。
 */
export async function up(db) {
  if (db.dialect === "mysql") {
    const keys = await db.all("SHOW INDEX FROM sys_user_wechat WHERE Key_name = 'PRIMARY'");
    if (keys.some((r) => r.Column_name === "user_id")) return;
    await db.run("ALTER TABLE sys_user_wechat DROP PRIMARY KEY, ADD PRIMARY KEY (openid, user_id)");
    const indexes = await db.all("SHOW INDEX FROM sys_user_wechat");
    if (!indexes.some((r) => r.Key_name === "idx_user_wechat_openid"))
      await db.run("CREATE INDEX idx_user_wechat_openid ON sys_user_wechat (openid)");
    return;
  }
  const columns = await db.all("PRAGMA table_info(sys_user_wechat)");
  if (columns.some((c) => c.name === "user_id" && Number(c.pk) > 0)) return;
  await db.transaction(async (tx) => {
    await tx.run(`CREATE TABLE sys_user_wechat_next (
      openid VARCHAR(64) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      appid VARCHAR(64) NOT NULL DEFAULT '',
      bound_at VARCHAR(32) NOT NULL,
      last_login_at VARCHAR(32),
      unionid TEXT NOT NULL DEFAULT '',
      nickname TEXT NOT NULL DEFAULT '',
      avatar TEXT,
      PRIMARY KEY (openid, user_id)
    )`);
    await tx.run(`INSERT INTO sys_user_wechat_next (openid, user_id, appid, bound_at, last_login_at, unionid, nickname, avatar)
      SELECT openid, user_id, appid, bound_at, last_login_at, COALESCE(unionid, ''), COALESCE(nickname, ''), avatar FROM sys_user_wechat`);
    await tx.run("DROP TABLE sys_user_wechat");
    await tx.run("ALTER TABLE sys_user_wechat_next RENAME TO sys_user_wechat");
    await tx.run("CREATE INDEX IF NOT EXISTS idx_user_wechat_unionid ON sys_user_wechat (unionid)");
    await tx.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS uk_user_wechat_user_app ON sys_user_wechat (user_id, appid)"
    );
    await tx.run("CREATE INDEX IF NOT EXISTS idx_user_wechat_openid ON sys_user_wechat (openid)");
  });
}
