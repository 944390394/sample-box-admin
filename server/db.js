import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { depts, flattenDepts, roles, users } from "../shared/org.js";
import { hashPassword } from "./auth.js";
import { ensureSchema } from "./src/store/schema.js";
import { SqliteExecutor } from "./src/store/SqliteExecutor.js";

const MIGRATION_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) PRIMARY KEY,
  applied_at VARCHAR(32) NOT NULL
)`;

export async function openDatabase(config, projectRoot) {
  if (config.dialect === "mysql") {
    const mysql = await import("mysql2/promise");
    const connection = await mysql.createConnection({
      host: config.host,
      port: Number(config.port) || 3306,
      user: config.user,
      password: config.password,
      database: config.database,
      charset: "utf8mb4",
      timezone: "+08:00",
      dateStrings: true,
      multipleStatements: true,
    });
    return {
      dialect: "mysql",
      async exec(sql) {
        await connection.query(sql);
      },
      async all(sql, params = []) {
        const [rows] = await connection.execute(sql, params);
        return rows;
      },
      async get(sql, params = []) {
        const rows = await this.all(sql, params);
        return rows[0];
      },
      async run(sql, params = []) {
        const [result] = await connection.execute(sql, params);
        return result;
      },
      async close() {
        await connection.end();
      },
    };
  }

  const { DatabaseSync } = await import("node:sqlite");
  const file = resolve(projectRoot, config.sqlitePath || "server/data/sample-box.db");
  mkdirSync(dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec("PRAGMA foreign_keys = ON");
  const executor = new SqliteExecutor(database);
  executor.file = file;
  return executor;
}

export async function testConnection(config, projectRoot) {
  const db = await openDatabase(config, projectRoot);
  try {
    await db.get("SELECT 1 AS ok");
  } finally {
    await db.close();
  }
}

export async function migrate(db) {
  await db.exec(MIGRATION_TABLE);
  const appliedRows = await db.all("SELECT version FROM schema_migrations");
  const applied = new Set(appliedRows.map((row) => row.version));
  const dir = fileURLToPath(new URL("./migrations/", import.meta.url));
  const names = (await readdir(dir)).filter((name) => /^\d+.+\.js$/.test(name)).sort();
  for (const name of names) {
    const version = name.replace(/\.js$/, "");
    if (applied.has(version)) continue;
    const migration = await import(pathToFileURL(resolve(dir, name)).href);
    await migration.up(db);
    await db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
      version,
      new Date().toISOString(),
    ]);
  }
  await ensureSchema(db);
}

export async function seedOrg(db) {
  const existing = await db.get("SELECT COUNT(*) AS total FROM sys_user");
  if (Number(existing?.total || 0) > 0) return;
  const passwordHash = hashPassword("123456");
  const insertAll = async (tx) => {
    for (const item of flattenDepts(depts)) {
      await tx.run(
        `INSERT INTO sys_dept (id, parent_id, name, code, sort, status, create_time, update_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          item.parentId,
          item.name,
          item.code,
          item.sort,
          item.status,
          item.createTime,
          item.updateTime,
        ]
      );
    }
    for (const item of roles) {
      await tx.run(
        `INSERT INTO sys_role (id, name, code, data_scope, sort, status, create_time, update_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          item.name,
          item.code,
          item.dataScope,
          item.sort,
          item.status,
          item.createTime,
          item.updateTime,
        ]
      );
    }
    for (const item of users) {
      await tx.run(
        `INSERT INTO sys_user
          (id, username, nickname, password_hash, dept_id, status, mobile, gender, email, avatar, create_time, update_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          item.username,
          item.nickname,
          passwordHash,
          item.deptId,
          item.status,
          null,
          null,
          "",
          "",
          item.createTime,
          item.createTime,
        ]
      );
      for (const roleId of item.roleIds) {
        await tx.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", [
          item.id,
          String(roleId),
        ]);
      }
    }
  };
  if (typeof db.transaction === "function") {
    await db.transaction(insertAll);
    return;
  }
  await db.exec("BEGIN");
  try {
    await insertAll(db);
    await db.exec("COMMIT");
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}
