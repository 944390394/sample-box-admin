/**
 * 箱子编号改用 IMEI，原来的 BOX-xxx 留作名称。
 * 所有带 box_id 的表、任务正文里的 boxIds 和单箱策略键名、采样箱操作日志一起改，在一个事务里完成。
 */
const BOX_TABLES = [
  "sample_uplink",
  "box_report_policy",
  "box_report_delivery",
  "sample_task_box",
  "box_active_task",
  "box_wipe_pending",
  "box_dump_request",
  "box_dump_record",
];

async function columnsOf(db, table) {
  try {
    const rows =
      db.dialect === "mysql"
        ? await db.all(`SHOW COLUMNS FROM ${table}`)
        : await db.all(`PRAGMA table_info(${table})`);
    return new Set(rows.map((r) => r.Field || r.name));
  } catch {
    return new Set();
  }
}

export async function up(db) {
  const boxColumns = await columnsOf(db, "sample_box");
  if (!boxColumns.size) return;
  if (!boxColumns.has("name")) {
    await db.run(
      db.dialect === "mysql"
        ? "ALTER TABLE sample_box ADD COLUMN name VARCHAR(64) NOT NULL DEFAULT ''"
        : "ALTER TABLE sample_box ADD COLUMN name TEXT NOT NULL DEFAULT ''"
    );
  }
  const work = async (tx) => {
    const rows = await tx.all("SELECT id, imei, name FROM sample_box");
    const renames = rows.filter((row) => row.imei && String(row.id) !== String(row.imei));
    const tables = [];
    for (const table of BOX_TABLES)
      if ((await columnsOf(tx, table)).has("box_id")) tables.push(table);
    for (const row of renames) {
      const from = String(row.id),
        to = String(row.imei);
      await tx.run("UPDATE sample_box SET id = ?, name = ? WHERE id = ?", [
        to,
        row.name || from,
        from,
      ]);
      for (const table of tables)
        await tx.run(`UPDATE ${table} SET box_id = ? WHERE box_id = ?`, [to, from]);
      if ((await columnsOf(tx, "sys_operation_log")).has("target_id")) {
        await tx.run(
          "UPDATE sys_operation_log SET target_id = ? WHERE target_type = 'box' AND target_id = ?",
          [to, from]
        );
      }
    }
    // 已经是 IMEI 编号但名称为空的，名称先用编号，页面上不会出现空名称
    await tx.run("UPDATE sample_box SET name = id WHERE name = '' OR name IS NULL");
    if (!renames.length) return;
    const map = new Map(renames.map((row) => [String(row.id), String(row.imei)]));
    const tasks = await tx.all("SELECT id, body FROM sample_task");
    for (const task of tasks) {
      let body;
      try {
        body = JSON.parse(task.body);
      } catch {
        continue;
      }
      let changed = false;
      if (Array.isArray(body.boxIds)) {
        const next = body.boxIds.map((id) => map.get(String(id)) || id);
        changed ||= next.some((id, i) => id !== body.boxIds[i]);
        body.boxIds = next;
      }
      if (body.overrides && typeof body.overrides === "object") {
        const next = {};
        for (const [key, value] of Object.entries(body.overrides)) {
          const id = map.get(key) || key;
          if (id !== key) changed = true;
          next[id] = value;
        }
        body.overrides = next;
      }
      if (changed)
        await tx.run("UPDATE sample_task SET body = ? WHERE id = ?", [
          JSON.stringify(body),
          task.id,
        ]);
    }
  };
  if (typeof db.transaction === "function") await db.transaction(work);
  else await work(db);
}
