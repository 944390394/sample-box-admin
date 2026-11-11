/** 改密后持久化撤销旧会话；旧账户默认版本0，兼容升级前的登录。 */
export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sys_user")
      : await db.all("PRAGMA table_info(sys_user)");
  if (!columns.some((row) => (row.Field || row.name) === "session_version")) {
    await db.run("ALTER TABLE sys_user ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0");
  }
}
