/** GPS 扩展信息（速度、航向、海拔、卫星数、HDOP、GPS 时间），整体存一段 JSON，只在有定位的上报里更新。 */
export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sample_box")
      : await db.all("PRAGMA table_info(sample_box)");
  if (!columns.some((r) => (r.Field || r.name) === "gps_info"))
    await db.run("ALTER TABLE sample_box ADD COLUMN gps_info TEXT");
}
