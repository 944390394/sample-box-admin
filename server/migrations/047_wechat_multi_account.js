/**
 * 一个微信可以绑多个账号：绑定表的主键从 openid 改成（openid, user_id）。
 * 一个账号在同一个应用里仍只绑一个微信（uk_user_wechat_user_app 不变）。
 * SQLite 改不了主键，按新结构建表、搬数据、换名；MySQL 直接换主键。已经是新结构的跳过。
 *
 * 迁移号 047 重复（R-8，论证保留）：本文件与 047_task_opens_from_create.js 共用数字前缀 047，
 * 是两条独立改动并行落盘的历史产物。db.js migrate() 以「全文件名」作 schema_migrations.version
 * （不是数字前缀），按文件名字典序执行：047_task_opens_from_create 排在 047_wechat_multi_account 之前，
 * 两者都会执行、顺序确定、各自幂等（本文件先查主键是否已含 user_id，已是新结构直接 return），
 * 不存在「一个被当成已应用而跳过」。**不改名/不改号**：已应用过的库以全文件名为 version 键，
 * 改名会让生产把它当新迁移重跑（本脚本幂等可安全重跑，但没必要制造重跑）。序号只用于人工排序，版本号=文件名。
 * 守卫用例见 server/test/migration-047-prefix.test.js。
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
