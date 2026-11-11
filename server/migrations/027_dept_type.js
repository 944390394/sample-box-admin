/** 部门类型：公司 / 采样机构。只有采样机构做采样单位时，采样任务才能要求开箱录像。 */
export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sys_dept")
      : await db.all("PRAGMA table_info(sys_dept)");
  if (!columns.some((r) => (r.Field || r.name) === "type")) {
    await db.run(
      db.dialect === "mysql"
        ? "ALTER TABLE sys_dept ADD COLUMN type VARCHAR(16) NOT NULL DEFAULT '公司'"
        : "ALTER TABLE sys_dept ADD COLUMN type TEXT NOT NULL DEFAULT '公司'"
    );
  }
}
