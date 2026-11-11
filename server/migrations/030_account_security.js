/** 账号安全：下次登录须改密、密码修改时间（定期更换）、连续失败次数和锁定截止时间。 */
export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sys_user")
      : await db.all("PRAGMA table_info(sys_user)");
  const names = new Set(columns.map((r) => r.Field || r.name));
  const add = async (name, sqlite, mysql) => {
    if (!names.has(name))
      await db.run(
        `ALTER TABLE sys_user ADD COLUMN ${name} ${db.dialect === "mysql" ? mysql : sqlite}`
      );
  };
  await add("must_change_password", "INTEGER NOT NULL DEFAULT 0", "INT NOT NULL DEFAULT 0");
  await add("password_changed_at", "TEXT NOT NULL DEFAULT ''", "VARCHAR(32) NOT NULL DEFAULT ''");
  await add("failed_count", "INTEGER NOT NULL DEFAULT 0", "INT NOT NULL DEFAULT 0");
  await add("locked_until", "TEXT NOT NULL DEFAULT ''", "VARCHAR(32) NOT NULL DEFAULT ''");
  // 老账号从现在开始算密码有效期，不会一升级就全部过期
  await db.run("UPDATE sys_user SET password_changed_at = ? WHERE password_changed_at = ''", [
    new Date().toISOString(),
  ]);
}
