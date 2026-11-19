/**
 * B3/#18 占用锚点一次性回填。列本身由 schema.js BOX_COLUMNS 声明式补齐，但 migrate() 先跑编号迁移
 * 后跑 ensureSchema，故 054 自带结构自愈：缺列就内联 ALTER，再回填。重复执行只是重写同批值，幂等。
 * 回填口径＝当前「未结束且未检测」的最早任务（与 syncBoundTask / onlineSql 同源）。
 */
import { ENDED_SQL } from "../src/settings/taskFlow.js";
import { formatTimestamp } from "../src/domain/Clock.js";

async function columnsOf(db, table) {
  const rows =
    db.dialect === "mysql"
      ? await db.all(`SHOW COLUMNS FROM ${table}`)
      : await db.all(`PRAGMA table_info(${table})`);
  return new Set(rows.map((r) => r.Field || r.name));
}

export async function up(db) {
  const names = await columnsOf(db, "sample_box");
  if (!names.has("bound_task_id"))
    await db.run(
      db.dialect === "mysql"
        ? "ALTER TABLE sample_box ADD COLUMN bound_task_id VARCHAR(64) NOT NULL DEFAULT ''"
        : "ALTER TABLE sample_box ADD COLUMN bound_task_id TEXT NOT NULL DEFAULT ''"
    );
  if (!names.has("bound_task_at"))
    await db.run(
      db.dialect === "mysql"
        ? "ALTER TABLE sample_box ADD COLUMN bound_task_at VARCHAR(32) NOT NULL DEFAULT ''"
        : "ALTER TABLE sample_box ADD COLUMN bound_task_at TEXT NOT NULL DEFAULT ''"
    );
  const boxes = await db.all("SELECT id FROM sample_box");
  for (const { id } of boxes) {
    const row = await db.get(
      `SELECT t.id, t.created_at FROM sample_task_box m JOIN sample_task t ON t.id=m.task_id
       WHERE m.box_id=? AND t.status NOT IN (${ENDED_SQL}) AND m.inspected_at IS NULL
       ORDER BY t.created_at LIMIT 1`,
      [id]
    );
    const at = row ? formatTimestamp(new Date(row.created_at)).slice(0, 19) : "";
    await db.run("UPDATE sample_box SET bound_task_id=?, bound_task_at=? WHERE id=?", [
      row ? row.id : "",
      at,
      id,
    ]);
  }
  if (db.dialect === "mysql") {
    const idx = await db.all("SHOW INDEX FROM sample_box");
    if (!idx.some((r) => r.Key_name === "idx_box_bound_task_at"))
      await db.run("CREATE INDEX idx_box_bound_task_at ON sample_box (bound_task_at)");
  } else
    await db.run("CREATE INDEX IF NOT EXISTS idx_box_bound_task_at ON sample_box (bound_task_at)");
}
