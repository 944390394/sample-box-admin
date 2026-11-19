/**
 * 连续上报固件（why 全为 timer）的开箱/关箱/上电/插拔充电器藏在字段变化里，
 * 旧版本把这类包全记成 timer，事件卡看不到历史。按接收顺序重放字段变化，把事件包改判种类。
 * 与 BoxState.kindOf 同一套规则；补传包（bf=1）前态不可靠，跳过。
 *
 * R-9：回填按 box_id 分组、键集分页每批 ≤500 行、每批各自一个事务，不再单事务全表重放
 * （生产 sample_uplink 按月分区、行数随上报累积，长事务会 undo 膨胀/久持行锁/拖主从延迟）。
 * 只改判当前仍是 timer 的行，重跑不会重复改判——幂等。
 * 注意：049 已在生产/隔离应用过（schema_migrations 以全文件名为 version），改本文件不会触发重跑，
 * 仅改善未来全新安装；不改迁移编号、不新增迁移。
 */
import { uplinkText } from "../src/domain/BatterySeries.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";

const plugged = (charge) => charge === 1 || charge === 2;
const num = (text, key) => {
  const m = text.match(new RegExp(`(?:^|,)${key}=(-?\\d+)`));
  return m ? Number(m[1]) : null;
};
const parser = new UplinkParser();
/** 线上原文是嵌套 JSON（bf/seq 藏在 uart 串里），裸正则会把补传标漏掉；先走 ingest 同一套解析。 */
const fieldsOf = (text) => {
  try {
    const u = parser.parse(text);
    return { seq: u.seq, opens: u.opens, lid: u.lid, charge: u.charge, backfill: u.backfill };
  } catch {
    // 旧库/演示库的裸 uart 文本没有 IMEI JSON 外壳，解析器不收，退回字段正则
    if (!text.includes("why=")) return null;
    return {
      seq: num(text, "seq"),
      opens: num(text, "opens"),
      lid: num(text, "lid"),
      charge: num(text, "chg"),
      backfill: /(?:^|,)bf=1(?:,|$)/.test(text),
    };
  }
};

/** 每批最多处理的行数：一批一个事务，避免单事务全表重放（R-9）。 */
const BATCH = 500;

export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sample_uplink")
      : await db.all("PRAGMA table_info(sample_uplink)");
  const names = new Set(columns.map((r) => r.Field || r.name));
  // 旧库没有原文列就读不出字段变化，保持原样
  if (!names.has("raw") && !names.has("raw_gz")) return;
  // received_at 供键集分页游标用（NOT NULL，与 ORDER BY 同序）
  const selected = ["id", "kind", "received_at"];
  if (names.has("raw")) selected.push("raw");
  if (names.has("raw_gz")) selected.push("raw_gz");
  const boxes = await db.all("SELECT DISTINCT box_id FROM sample_uplink");
  // 有事务能力的执行器：每批 ≤500 行各自一个事务；没有的（安装期 MySQL 直连）逐条自动提交。
  // 两种都不会把全表重放包进一个长事务，避免 undo 膨胀、行锁久持、主从延迟（R-9）。
  const eachBatch = (fn) => (typeof db.transaction === "function" ? db.transaction(fn) : fn(db));
  for (const { box_id } of boxes) {
    // 前态按接收顺序在批与批之间延续；补传包（bf=1）前态不可靠，跳过且不更新前态。
    const prev = { seq: null, opens: null, lid: null, charge: null };
    let cursor = null; // 上一页最后一行的 [received_at, id]，键集分页避免 OFFSET 越翻越慢
    for (;;) {
      const params = [box_id];
      let where = "box_id = ?";
      if (cursor) {
        where += " AND (received_at > ? OR (received_at = ? AND id > ?))";
        params.push(cursor[0], cursor[0], cursor[1]);
      }
      const sql = `SELECT ${selected.join(", ")} FROM sample_uplink WHERE ${where} ORDER BY received_at, id LIMIT ${BATCH}`;
      const page = await eachBatch(async (tx) => {
        const rows = await tx.all(sql, params);
        for (const row of rows) {
          const text = uplinkText(row);
          if (!text) continue;
          const f = fieldsOf(text);
          if (!f) continue;
          const { seq, opens, lid, charge, backfill } = f;
          if (row.kind === "timer" && !backfill && prev.seq != null) {
            let kind = "";
            if (seq != null && seq < prev.seq) kind = "boot";
            else if (
              (opens != null && prev.opens != null && opens > prev.opens) ||
              (lid === 1 && prev.lid === 0)
            )
              kind = "pad";
            else if (lid === 0 && prev.lid === 1) kind = "shut";
            else if (
              prev.charge != null &&
              charge != null &&
              plugged(prev.charge) !== plugged(charge)
            )
              kind = "chg";
            if (kind)
              await tx.run("UPDATE sample_uplink SET kind = ? WHERE id = ?", [kind, row.id]);
          }
          if (!backfill) {
            if (seq != null) prev.seq = seq;
            if (opens != null) prev.opens = opens;
            if (lid != null) prev.lid = lid;
            if (charge != null) prev.charge = charge;
          }
        }
        if (!rows.length) return { cursor, done: true };
        const last = rows[rows.length - 1];
        return { cursor: [last.received_at, last.id], done: rows.length < BATCH };
      });
      cursor = page.cursor;
      if (page.done) break;
    }
  }
}
