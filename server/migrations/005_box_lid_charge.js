/**
 * 箱盖、充电和上次开箱要落在箱子上，刷新详情才不会变回空。
 * 已入库的报文按新规则重读一次：任务和发送模板套了两层时，旧解析认不出 why。
 */
import { gunzipSync } from "node:zlib";

import { shiftDeviceTime } from "../src/domain/Clock.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";

const ADDITIONS = {
  sqlite: [
    ["lid", "INTEGER"],
    ["charge", "INTEGER"],
    ["last_open", "TEXT NOT NULL DEFAULT ''"],
  ],
  mysql: [
    ["lid", "INT NULL"],
    ["charge", "INT NULL"],
    ["last_open", "VARCHAR(32) NOT NULL DEFAULT ''"],
  ],
};

async function columnNames(db) {
  if (db.dialect === "mysql") {
    const rows = await db.all(
      `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sample_box'`
    );
    return new Set(rows.map((row) => row.name));
  }
  const rows = await db.all("PRAGMA table_info(sample_box)");
  return new Set(rows.map((row) => row.name));
}

/** 原文在 raw；压过的库把 gzip 放在 raw_gz，raw 列是空的。 */
function rawText(row) {
  const compressed = row.raw_gz;
  if (compressed != null && compressed !== "" && compressed.length !== 0) {
    const text = decodeRaw(compressed);
    if (text) return text;
  }
  return decodeRaw(row.raw);
}

function decodeRaw(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value;
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return gunzipSync(bytes).toString("utf8");
  }
  return bytes.toString("utf8");
}

export async function replayFaces(db) {
  const rows = await db.all("SELECT * FROM sample_uplink ORDER BY received_at ASC, id ASC");
  const parser = new UplinkParser();
  const faces = new Map();
  for (const row of rows) {
    let uplink;
    try {
      uplink = parser.parse(rawText(row));
    } catch {
      continue;
    }
    if (row.kind !== uplink.why || row.summary !== uplink.label) {
      await db.run(
        "UPDATE sample_uplink SET kind = ?, summary = ? WHERE id = ? AND received_at = ?",
        [uplink.why, uplink.label, row.id, row.received_at]
      );
    }
    const face = faces.get(uplink.imei) || { opens: null, lid: null, charge: null, lastOpen: "" };
    if (uplink.opens != null) face.opens = uplink.opens;
    if (uplink.lid != null) face.lid = uplink.lid;
    if (uplink.charge != null) face.charge = uplink.charge;
    if (uplink.openAge != null) {
      const lastOpen = shiftDeviceTime(uplink.deviceTime, uplink.openAge);
      if (lastOpen) face.lastOpen = lastOpen;
    }
    faces.set(uplink.imei, face);
  }
  for (const [imei, face] of faces) {
    await db.run(
      `UPDATE sample_box
       SET opens = COALESCE(?, opens),
           lid = COALESCE(?, lid),
           charge = COALESCE(?, charge),
           last_open = CASE WHEN ? = '' THEN last_open ELSE ? END
       WHERE imei = ?`,
      [face.opens, face.lid, face.charge, face.lastOpen, face.lastOpen, imei]
    );
  }
}

export async function up(db) {
  const names = await columnNames(db);
  const additions = ADDITIONS[db.dialect === "mysql" ? "mysql" : "sqlite"];
  for (const [name, type] of additions) {
    if (names.has(name)) continue;
    await db.exec(`ALTER TABLE sample_box ADD COLUMN ${name} ${type}`);
  }
  await replayFaces(db);
}
