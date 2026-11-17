import { seedRolePerms } from "../src/auth/boxAccess.js";

/**
 * 角色授权落库，箱子按部门编号和保管人编号归属。
 * 原来的 org、owner 是名称文本，部门会重名，只回填名称唯一的那些；重名的留空，归总公司，再到页面上分配。
 */

export const ROLE_PERM_DDL = `CREATE TABLE IF NOT EXISTS sys_role_perm (
  role_id VARCHAR(32) NOT NULL,
  perm VARCHAR(64) NOT NULL,
  PRIMARY KEY (role_id, perm)
)`;

async function hasColumn(db, table, name) {
  if (db.dialect === "mysql") {
    const row = await db.get(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, name]
    );
    return Boolean(row);
  }
  const rows = await db.all(`PRAGMA table_info(${table})`);
  return rows.some((row) => row.name === name);
}

function uniqueByName(rows, key) {
  const seen = new Map();
  for (const row of rows) {
    const name = String(row[key] || "");
    if (!name) continue;
    seen.set(name, seen.has(name) ? null : String(row.id));
  }
  return seen;
}

export async function up(db) {
  await db.exec(ROLE_PERM_DDL);
  const type =
    db.dialect === "mysql" ? "VARCHAR(32) NOT NULL DEFAULT ''" : "TEXT NOT NULL DEFAULT ''";
  for (const column of ["org_id", "owner_id"]) {
    if (!(await hasColumn(db, "sample_box", column))) {
      await db.exec(`ALTER TABLE sample_box ADD COLUMN ${column} ${type}`);
    }
  }
  const depts = uniqueByName(await db.all("SELECT id, name FROM sys_dept"), "name");
  const users = uniqueByName(await db.all("SELECT id, nickname FROM sys_user"), "nickname");
  const boxes = await db.all("SELECT id, org, owner FROM sample_box");
  for (const box of boxes) {
    const orgId = depts.get(String(box.org || "")) || "";
    const ownerId = users.get(String(box.owner || "")) || "";
    if (!orgId && !ownerId) continue;
    await db.run("UPDATE sample_box SET org_id = ?, owner_id = ? WHERE id = ?", [
      orgId,
      ownerId,
      box.id,
    ]);
  }
  await seedRolePerms(db);
}
