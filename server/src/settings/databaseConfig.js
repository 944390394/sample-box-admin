/**
 * 系统设置里的数据库地址。
 * 没填主机就继续用 SQLite。密码只出现在连接配置里，对外的对象不带这一字段。
 */

export function configuredMysql(config) {
  if (!config || config.dialect !== "mysql") return null;
  const host = String(config.host || "").trim();
  const database = String(config.database || "").trim();
  if (!host || !database) return null;
  return {
    host,
    port: Number(config.port) || 3306,
    database,
    user: String(config.user || ""),
    password: String(config.password || ""),
  };
}

export function publicDatabase(config) {
  const mysql = configuredMysql(config);
  if (!mysql) {
    return { host: "", port: 3306, database: "", user: "", passwordSet: false };
  }
  return {
    host: mysql.host,
    port: mysql.port,
    database: mysql.database,
    user: mysql.user,
    passwordSet: mysql.password.length > 0,
  };
}

export function mergeDatabaseSettings(current, input) {
  const base = current && typeof current === "object" ? current : {};
  const sqlitePath = base.sqlitePath || "server/data/sample-box.db";
  const host = String(input?.host || "").trim();
  if (!host) {
    return {
      ...base,
      dialect: "sqlite",
      sqlitePath,
      host: "",
      port: 3306,
      user: "",
      password: "",
      database: "",
    };
  }
  const database = String(input?.database || "").trim();
  const user = String(input?.user || "").trim();
  const port = Number(input?.port);
  if (!database) throw new Error("请填写数据库名");
  if (!user) throw new Error("请填写账号");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口不正确");
  const typed = String(input?.password || "");
  const stored = base.dialect === "mysql" ? String(base.password || "") : "";
  if (!typed && !stored) throw new Error("请填写密码");
  return {
    ...base,
    dialect: "mysql",
    sqlitePath,
    host,
    port,
    user,
    database,
    password: typed || stored,
  };
}

export function scrub(message, secret) {
  const text = String(message || "");
  if (!secret) return text;
  return text.split(String(secret)).join("***");
}
