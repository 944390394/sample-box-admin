/**
 * 已建、还没结束、但当时没记下开箱起点的任务：按建单前后的上报倒推起点。
 * 这样待寄出阶段已经开过的箱，刷新后会计入任务期间，而不是等寄出才从 0 开始。
 *
 * 迁移号 047 重复（R-8，论证保留）：本文件与 047_wechat_multi_account.js 共用数字前缀 047，
 * 是两条独立改动并行落盘的历史产物。db.js migrate() 以「全文件名」作 schema_migrations.version
 * （不是数字前缀），按文件名字典序执行：047_task_opens_from_create 排在 047_wechat_multi_account 之前，
 * 两者都会执行、顺序确定、各自幂等（本文件 WHERE opens_start IS NULL，wechat 侧先查主键是否已含 user_id），
 * 不存在「一个被当成已应用而跳过」。**不改名/不改号**：已应用过的库以全文件名为 version 键，
 * 改名会让生产把它当新迁移重跑。序号只用于人工排序，版本号=文件名。
 * 守卫用例见 server/test/migration-047-prefix.test.js。
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
