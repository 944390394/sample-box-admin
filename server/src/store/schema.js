import { statements as orgStatements } from "../../migrations/001_org.js";
import { mysqlStatements, sqliteStatements } from "../../migrations/002_sample.js";

/**
 * 空库按当前结构建表。已经有的表不重建、不删数据，只补缺的列和索引。
 * MySQL 的上报流水在新建时使用迁移里写好的按月分区；旧表保持原样，避免搬动数据。
 */

const BOX_COLUMNS = {
  sqlite: {
    iccid: "TEXT NOT NULL DEFAULT ''",
    imsi: "TEXT NOT NULL DEFAULT ''",
    firmware: "TEXT NOT NULL DEFAULT ''",
    owner: "TEXT NOT NULL DEFAULT ''",
    alert: "TEXT NOT NULL DEFAULT ''",
    battery: "TEXT NOT NULL DEFAULT ''",
    csq: "INTEGER NOT NULL DEFAULT 0",
    last_report_at: "TEXT NOT NULL DEFAULT ''",
    lbs: "TEXT NOT NULL DEFAULT ''",
    lbs_lng: "REAL",
    lbs_lat: "REAL",
    gps: "TEXT NOT NULL DEFAULT ''",
    gps_lng: "REAL",
    gps_lat: "REAL",
    opens: "INTEGER NOT NULL DEFAULT 0",
    powered_at: "TEXT NOT NULL DEFAULT ''",
  },
  mysql: {
    iccid: "VARCHAR(32) NOT NULL DEFAULT ''",
    imsi: "VARCHAR(32) NOT NULL DEFAULT ''",
    firmware: "VARCHAR(32) NOT NULL DEFAULT ''",
    owner: "VARCHAR(64) NOT NULL DEFAULT ''",
    alert: "VARCHAR(128) NOT NULL DEFAULT ''",
    battery: "VARCHAR(16) NOT NULL DEFAULT ''",
    csq: "INT NOT NULL DEFAULT 0",
    last_report_at: "VARCHAR(32) NOT NULL DEFAULT ''",
    lbs: "VARCHAR(64) NOT NULL DEFAULT ''",
    lbs_lng: "DOUBLE NULL",
    lbs_lat: "DOUBLE NULL",
    gps: "VARCHAR(64) NOT NULL DEFAULT ''",
    gps_lng: "DOUBLE NULL",
    gps_lat: "DOUBLE NULL",
    opens: "INT NOT NULL DEFAULT 0",
    powered_at: "VARCHAR(32) NOT NULL DEFAULT ''",
  },
};

const UPLINK_COLUMNS = {
  sqlite: {
    device_time: "TEXT NOT NULL DEFAULT ''",
    kind: "TEXT NOT NULL DEFAULT ''",
    summary: "TEXT NOT NULL DEFAULT ''",
    lbs_lng: "REAL",
    lbs_lat: "REAL",
    gps_lng: "REAL",
    gps_lat: "REAL",
  },
  mysql: {
    device_time: "VARCHAR(32) NOT NULL DEFAULT ''",
    kind: "VARCHAR(16) NOT NULL DEFAULT ''",
    summary: "VARCHAR(64) NOT NULL DEFAULT ''",
    lbs_lng: "DOUBLE NULL",
    lbs_lat: "DOUBLE NULL",
    gps_lng: "DOUBLE NULL",
    gps_lat: "DOUBLE NULL",
  },
};

const OPERATION_LOG_COLUMNS = {
  sqlite: {
    org_id: "TEXT NOT NULL DEFAULT ''",
    org_name: "TEXT NOT NULL DEFAULT ''",
    actor_id: "TEXT NOT NULL DEFAULT ''",
    actor_name: "TEXT NOT NULL DEFAULT ''",
    action: "TEXT NOT NULL DEFAULT ''",
    target_type: "TEXT NOT NULL DEFAULT ''",
    target_id: "TEXT NOT NULL DEFAULT ''",
    result: "TEXT NOT NULL DEFAULT ''",
    created_at: "TEXT NOT NULL DEFAULT ''",
    ip: "TEXT NOT NULL DEFAULT ''",
  },
  mysql: {
    org_id: "VARCHAR(32) NOT NULL DEFAULT ''",
    org_name: "VARCHAR(64) NOT NULL DEFAULT ''",
    actor_id: "VARCHAR(32) NOT NULL DEFAULT ''",
    actor_name: "VARCHAR(64) NOT NULL DEFAULT ''",
    action: "VARCHAR(32) NOT NULL DEFAULT ''",
    target_type: "VARCHAR(32) NOT NULL DEFAULT ''",
    target_id: "VARCHAR(64) NOT NULL DEFAULT ''",
    result: "VARCHAR(16) NOT NULL DEFAULT ''",
    created_at: "DATETIME(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000'",
    ip: "VARCHAR(64) NOT NULL DEFAULT ''",
  },
};

const INDEXES = [
  ["sample_box", "idx_box_org_last", ["org", "last_report_at"]],
  ["sample_uplink", "idx_uplink_box", ["box_id", "received_at"]],
  ["sys_operation_log", "idx_op_org_time", ["org_id", "created_at", "id"]],
  ["sys_operation_log", "idx_op_actor_time", ["actor_id", "created_at", "id"]],
  ["sys_operation_log", "idx_op_target_time", ["target_id", "created_at", "id"]],
  ["sys_operation_log", "idx_op_time", ["created_at"]],
];

function ident(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("非法标识符");
  return name;
}

export function isBlobColumn(type) {
  return /blob|binary/i.test(String(type || ""));
}

async function tableExists(db, table) {
  if (db.dialect === "mysql") {
    const row = await db.get(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table]
    );
    return Boolean(row);
  }
  const row = await db.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [
    table,
  ]);
  return Boolean(row);
}

export async function listColumns(db, table) {
  if (!(await tableExists(db, table))) return [];
  if (db.dialect === "mysql") {
    const rows = await db.all(
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS type
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [table]
    );
    return rows.map((row) => ({ name: String(row.name), type: String(row.type || "") }));
  }
  const rows = await db.all(`PRAGMA table_info(${ident(table)})`);
  return rows.map((row) => ({ name: String(row.name), type: String(row.type || "") }));
}

async function indexNames(db, table) {
  if (db.dialect === "mysql") {
    const rows = await db.all(
      `SELECT INDEX_NAME AS name FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table]
    );
    return new Set(rows.map((row) => String(row.name)));
  }
  const rows = await db.all(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`,
    [table]
  );
  return new Set(rows.map((row) => String(row.name)));
}

async function applyStatements(db, statements) {
  for (const sql of statements) {
    const creating = sql.match(/CREATE TABLE IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*)/);
    if (creating && (await tableExists(db, creating[1]))) continue;
    await db.exec(sql);
  }
}

async function addMissingColumns(db, table, catalog) {
  if (!(await tableExists(db, table))) return;
  const existing = new Set((await listColumns(db, table)).map((column) => column.name));
  const dialect = db.dialect === "mysql" ? "mysql" : "sqlite";
  for (const [name, ddl] of Object.entries(catalog[dialect])) {
    if (existing.has(name)) continue;
    await db.exec(`ALTER TABLE ${ident(table)} ADD COLUMN ${ident(name)} ${ddl}`);
    existing.add(name);
  }
}

async function ensureCompressedRaw(db) {
  if (!(await tableExists(db, "sample_uplink"))) return;
  const columns = await listColumns(db, "sample_uplink");
  const raw = columns.find((column) => column.name === "raw");
  if (!raw || isBlobColumn(raw.type)) return;
  if (columns.some((column) => column.name === "raw_gz")) return;
  const type = db.dialect === "mysql" ? "MEDIUMBLOB NULL" : "BLOB";
  await db.exec(`ALTER TABLE sample_uplink ADD COLUMN raw_gz ${type}`);
}

async function ensureIndexes(db) {
  for (const [table, name, columns] of INDEXES) {
    if (!(await tableExists(db, table))) continue;
    const names = await indexNames(db, table);
    if (names.has(name)) continue;
    const list = columns.map(ident).join(", ");
    await db.exec(`CREATE INDEX ${ident(name)} ON ${ident(table)} (${list})`);
  }
}

function operationLogDdl(dialect) {
  if (dialect === "mysql") {
    return `CREATE TABLE IF NOT EXISTS sys_operation_log (
      id BIGINT NOT NULL AUTO_INCREMENT,
      org_id VARCHAR(32) NOT NULL DEFAULT '',
      org_name VARCHAR(64) NOT NULL DEFAULT '',
      actor_id VARCHAR(32) NOT NULL DEFAULT '',
      actor_name VARCHAR(64) NOT NULL DEFAULT '',
      action VARCHAR(32) NOT NULL DEFAULT '',
      target_type VARCHAR(32) NOT NULL DEFAULT '',
      target_id VARCHAR(64) NOT NULL DEFAULT '',
      result VARCHAR(16) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL,
      ip VARCHAR(64) NOT NULL DEFAULT '',
      PRIMARY KEY (id)
    )`;
  }
  return `CREATE TABLE IF NOT EXISTS sys_operation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id TEXT NOT NULL DEFAULT '',
    org_name TEXT NOT NULL DEFAULT '',
    actor_id TEXT NOT NULL DEFAULT '',
    actor_name TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL DEFAULT '',
    target_type TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT ''
  )`;
}

export async function rawStorage(db) {
  const columns = await listColumns(db, "sample_uplink");
  const raw = columns.find((column) => column.name === "raw");
  if (raw && isBlobColumn(raw.type)) return "raw";
  return "raw_gz";
}

export async function ensureSchema(db) {
  const sample = db.dialect === "mysql" ? mysqlStatements : sqliteStatements;
  await applyStatements(db, orgStatements);
  await applyStatements(db, sample);
  if (!(await tableExists(db, "sys_operation_log"))) {
    await db.exec(operationLogDdl(db.dialect));
  }
  await addMissingColumns(db, "sample_box", BOX_COLUMNS);
  await addMissingColumns(db, "sample_uplink", UPLINK_COLUMNS);
  await addMissingColumns(db, "sys_operation_log", OPERATION_LOG_COLUMNS);
  await ensureCompressedRaw(db);
  await ensureIndexes(db);
}
