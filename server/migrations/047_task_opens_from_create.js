/**
 * 已建、还没结束、但当时没记下开箱起点的任务：按建单前后的上报倒推起点。
 * 这样待寄出阶段已经开过的箱，刷新后会计入任务期间，而不是等寄出才从 0 开始。
 */
import { decompressRaw } from "../src/store/rawCodec.js";
import { ENDED_SQL } from "../src/settings/taskFlow.js";
import { opensAtTaskStart } from "../src/settings/taskPlaces.js";

function reportedOpens(text) {
  const found = String(text || "").match(/(?:opens"\s*:\s*|opens=)(\d+)/);
  return found ? Number(found[1]) : null;
}

function ms(value) {
  const text = String(value || "").trim();
  if (!text) return NaN;
  if (text.includes("T")) return Date.parse(text);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, milli] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(String(milli || "0").padEnd(3, "0"))
  ).getTime();
}

async function packetsOf(db, boxId) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sample_uplink")
      : await db.all("PRAGMA table_info(sample_uplink)");
  const names = new Set(columns.map((row) => row.Field || row.name));
  const raw = names.has("raw_gz") ? "CASE WHEN raw_gz IS NULL THEN raw ELSE raw_gz END" : "raw";
  return db.all(
    `SELECT received_at, ${raw} AS raw FROM sample_uplink WHERE box_id=? ORDER BY received_at`,
    [boxId]
  );
}

export async function up(db) {
  const rows = await db.all(
    `SELECT m.task_id, m.box_id, t.created_at, b.opens
     FROM sample_task_box m
     JOIN sample_task t ON t.id = m.task_id
     LEFT JOIN sample_box b ON b.id = m.box_id
     WHERE m.opens_start IS NULL AND t.status NOT IN (${ENDED_SQL})`
  );
  const cache = new Map();
  for (const row of rows) {
    if (!cache.has(row.box_id)) {
      try {
        cache.set(row.box_id, await packetsOf(db, row.box_id));
      } catch {
        cache.set(row.box_id, []);
      }
    }
    const startMs = ms(row.created_at);
    let before = null;
    const during = [];
    for (const packet of cache.get(row.box_id)) {
      let text;
      try {
        text = decompressRaw(packet.raw);
      } catch {
        continue;
      }
      const reported = reportedOpens(text);
      if (reported == null) continue;
      if (ms(packet.received_at) < startMs) before = reported;
      else during.push(reported);
    }
    const start = opensAtTaskStart(row.opens, before, during);
    await db.run(
      "UPDATE sample_task_box SET opens_start=? WHERE task_id=? AND box_id=? AND opens_start IS NULL",
      [start, row.task_id, row.box_id]
    );
  }
}
