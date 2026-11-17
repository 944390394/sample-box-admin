/** 采样机构的监控通道（1–8 路），JSON 数组，见 src/settings/deptCameras.js。 */
export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sys_dept")
      : await db.all("PRAGMA table_info(sys_dept)");
  const names = new Set(columns.map((r) => r.Field || r.name));
  if (!names.has("cameras"))
    await db.run(
      `ALTER TABLE sys_dept ADD COLUMN cameras ${db.dialect === "mysql" ? "TEXT" : "TEXT"}`
    );
}
