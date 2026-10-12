export const statements = [
  `CREATE TABLE IF NOT EXISTS sys_dept (
    id VARCHAR(32) PRIMARY KEY,
    parent_id VARCHAR(32) NOT NULL,
    name VARCHAR(64) NOT NULL,
    code VARCHAR(64) NOT NULL,
    sort INT NOT NULL,
    status INT NOT NULL,
    create_time VARCHAR(32),
    update_time VARCHAR(32)
  )`,
  `CREATE TABLE IF NOT EXISTS sys_role (
    id VARCHAR(32) PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    code VARCHAR(64) NOT NULL,
    data_scope INT NOT NULL,
    sort INT NOT NULL,
    status INT NOT NULL,
    create_time VARCHAR(32),
    update_time VARCHAR(32),
    UNIQUE (code)
  )`,
  `CREATE TABLE IF NOT EXISTS sys_user (
    id VARCHAR(32) PRIMARY KEY,
    username VARCHAR(64) NOT NULL,
    nickname VARCHAR(64) NOT NULL,
    password_hash VARCHAR(128) NOT NULL,
    dept_id VARCHAR(32) NOT NULL,
    status INT NOT NULL,
    mobile VARCHAR(32),
    gender INT,
    email VARCHAR(128),
    avatar VARCHAR(255),
    create_time VARCHAR(32),
    update_time VARCHAR(32),
    UNIQUE (username)
  )`,
  `CREATE TABLE IF NOT EXISTS sys_user_role (
    user_id VARCHAR(32) NOT NULL,
    role_id VARCHAR(32) NOT NULL,
    PRIMARY KEY (user_id, role_id)
  )`,
];

export async function up(db) {
  for (const sql of statements) {
    await db.exec(sql);
  }
}
