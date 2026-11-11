/** 绑定的微信记下昵称和头像（小程序里用户自己填的），网页个人中心、人员页显示是哪个微信。 */
export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sys_user_wechat")
      : await db.all("PRAGMA table_info(sys_user_wechat)");
  const names = new Set(columns.map((r) => r.Field || r.name));
  const add = async (name, sqlite, mysql) => {
    if (!names.has(name))
      await db.run(
        `ALTER TABLE sys_user_wechat ADD COLUMN ${name} ${db.dialect === "mysql" ? mysql : sqlite}`
      );
  };
  await add("nickname", "TEXT NOT NULL DEFAULT ''", "VARCHAR(64) NOT NULL DEFAULT ''");
  await add("avatar", "TEXT", "MEDIUMTEXT");
}
