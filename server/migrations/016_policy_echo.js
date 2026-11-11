/** 记下设备回报的策略指纹。和已下发版本不一致时，页面显示未生效。 */
export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM box_report_delivery")
      : await db.all("PRAGMA table_info(box_report_delivery)");
  const names = new Set(columns.map((row) => row.Field || row.name));
  const add = [
    ["echo_version", "VARCHAR(32)"],
    ["echo_period", "INTEGER"],
    ["echo_charge", "INTEGER"],
  ];
  for (const [name, type] of add) {
    if (!names.has(name))
      await db.run(`ALTER TABLE box_report_delivery ADD COLUMN ${name} ${type}`);
  }
}
