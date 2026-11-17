/**
 * 基站位置的更新时间。以前只记 GPS 的定位时间，GPS 几天没定到时页面分不清基站和 GPS 哪个是现在的位置。
 * 老数据先用最近上报时间填上：有基站坐标的箱子，基站位置就是随最近一次上报来的。
 */
export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sample_box")
      : await db.all("PRAGMA table_info(sample_box)");
  if (!columns.some((r) => (r.Field || r.name) === "lbs_at"))
    await db.run("ALTER TABLE sample_box ADD COLUMN lbs_at VARCHAR(32)");
  await db.run(
    "UPDATE sample_box SET lbs_at = last_report_at WHERE lbs_lng IS NOT NULL AND (lbs_at IS NULL OR lbs_at = '')"
  );
}
