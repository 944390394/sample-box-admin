/**
 * 采样箱当前状态，以及按时间堆积的原始上报。
 * MySQL 按月分区，超出预建月份的数据先落在 pmax，避免入库失败。
 */

export const sqliteStatements = [
  `CREATE TABLE IF NOT EXISTS sample_box (
    id TEXT PRIMARY KEY,
    imei TEXT NOT NULL UNIQUE,
    iccid TEXT NOT NULL DEFAULT '',
    imsi TEXT NOT NULL DEFAULT '',
    firmware TEXT NOT NULL DEFAULT '',
    org TEXT NOT NULL,
    owner TEXT NOT NULL DEFAULT '',
    life TEXT NOT NULL,
    alert TEXT NOT NULL DEFAULT '',
    battery TEXT NOT NULL DEFAULT '',
    csq INTEGER NOT NULL DEFAULT 0,
    last_report_at TEXT NOT NULL DEFAULT '',
    lbs TEXT NOT NULL DEFAULT '',
    lbs_lng REAL,
    lbs_lat REAL,
    gps TEXT NOT NULL DEFAULT '',
    gps_lng REAL,
    gps_lat REAL,
    opens INTEGER NOT NULL DEFAULT 0,
    activate_step TEXT NOT NULL,
    powered_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS sample_uplink (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    box_id TEXT NOT NULL,
    imei TEXT NOT NULL,
    received_at TEXT NOT NULL,
    device_time TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    raw BLOB NOT NULL,
    lbs_lng REAL,
    lbs_lat REAL,
    gps_lng REAL,
    gps_lat REAL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_uplink_box ON sample_uplink (box_id, received_at)`,
  `CREATE TABLE IF NOT EXISTS sample_box_seq (
    id INTEGER PRIMARY KEY,
    next_no INTEGER NOT NULL
  )`,
  `INSERT INTO sample_box_seq (id, next_no)
   SELECT 1, 1 WHERE NOT EXISTS (SELECT 1 FROM sample_box_seq WHERE id = 1)`,
];

export const mysqlStatements = [
  `CREATE TABLE IF NOT EXISTS sample_box (
    id VARCHAR(32) PRIMARY KEY,
    imei VARCHAR(32) NOT NULL,
    iccid VARCHAR(32) NOT NULL DEFAULT '',
    imsi VARCHAR(32) NOT NULL DEFAULT '',
    firmware VARCHAR(32) NOT NULL DEFAULT '',
    org VARCHAR(64) NOT NULL,
    owner VARCHAR(64) NOT NULL DEFAULT '',
    life VARCHAR(16) NOT NULL,
    alert VARCHAR(128) NOT NULL DEFAULT '',
    battery VARCHAR(16) NOT NULL DEFAULT '',
    csq INT NOT NULL DEFAULT 0,
    last_report_at VARCHAR(32) NOT NULL DEFAULT '',
    lbs VARCHAR(64) NOT NULL DEFAULT '',
    lbs_lng DOUBLE NULL,
    lbs_lat DOUBLE NULL,
    gps VARCHAR(64) NOT NULL DEFAULT '',
    gps_lng DOUBLE NULL,
    gps_lat DOUBLE NULL,
    opens INT NOT NULL DEFAULT 0,
    activate_step VARCHAR(16) NOT NULL,
    powered_at VARCHAR(32) NOT NULL DEFAULT '',
    UNIQUE KEY uk_sample_box_imei (imei)
  )`,
  `CREATE TABLE IF NOT EXISTS sample_uplink (
    id BIGINT NOT NULL AUTO_INCREMENT,
    box_id VARCHAR(32) NOT NULL,
    imei VARCHAR(32) NOT NULL,
    received_at DATETIME(3) NOT NULL,
    device_time VARCHAR(32) NOT NULL DEFAULT '',
    kind VARCHAR(16) NOT NULL,
    summary VARCHAR(64) NOT NULL,
    raw MEDIUMBLOB NOT NULL,
    lbs_lng DOUBLE NULL,
    lbs_lat DOUBLE NULL,
    gps_lng DOUBLE NULL,
    gps_lat DOUBLE NULL,
    PRIMARY KEY (id, received_at),
    KEY idx_uplink_box (box_id, received_at)
  ) PARTITION BY RANGE (TO_DAYS(received_at)) (
    PARTITION p202609 VALUES LESS THAN (TO_DAYS('2026-10-01')),
    PARTITION p202610 VALUES LESS THAN (TO_DAYS('2026-11-01')),
    PARTITION p202611 VALUES LESS THAN (TO_DAYS('2026-12-01')),
    PARTITION p202612 VALUES LESS THAN (TO_DAYS('2027-01-01')),
    PARTITION pmax VALUES LESS THAN MAXVALUE
  )`,
  `CREATE TABLE IF NOT EXISTS sample_box_seq (
    id INT PRIMARY KEY,
    next_no INT NOT NULL
  )`,
  `INSERT INTO sample_box_seq (id, next_no)
   SELECT 1, 1 FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM sample_box_seq WHERE id = 1)`,
];

export async function up(db) {
  const statements = db.dialect === "mysql" ? mysqlStatements : sqliteStatements;
  for (const sql of statements) {
    await db.exec(sql);
  }
}
