/**
 * 小程序登录：一个微信（openid）绑一个账号，一个账号也只绑一个微信。
 * 首次在小程序里用账号密码登录时绑定，之后打开小程序凭 openid 直接登录。
 */
export async function up(db) {
  await db.run(`CREATE TABLE IF NOT EXISTS sys_user_wechat (
    openid VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    appid VARCHAR(64) NOT NULL DEFAULT '',
    bound_at VARCHAR(32) NOT NULL,
    last_login_at VARCHAR(32)
  )`);
  if (db.dialect === "mysql") {
    const indexes = await db.all("SHOW INDEX FROM sys_user_wechat");
    if (!indexes.some((r) => r.Key_name === "uk_user_wechat_user"))
      await db.run("CREATE UNIQUE INDEX uk_user_wechat_user ON sys_user_wechat (user_id)");
  } else
    await db.run(
      "CREATE UNIQUE INDEX IF NOT EXISTS uk_user_wechat_user ON sys_user_wechat (user_id)"
    );
}
