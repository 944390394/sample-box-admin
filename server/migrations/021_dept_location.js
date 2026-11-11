/** 单位的地址和坐标。任务里引用时复制一份快照，单位以后改地址不影响旧任务。 */
export async function up(db) {
  const columns =
    db.dialect === "mysql"
      ? await db.all("SHOW COLUMNS FROM sys_dept")
      : await db.all("PRAGMA table_info(sys_dept)");
  const names = new Set(columns.map((r) => r.Field || r.name));
  const wanted = [
    ["address", "VARCHAR(255)"],
    ["lng", "DOUBLE"],
    ["lat", "DOUBLE"],
    ["contact", "VARCHAR(64)"],
    ["phone", "VARCHAR(32)"],
  ];
  for (const [name, type] of wanted) {
    if (!names.has(name)) await db.run(`ALTER TABLE sys_dept ADD COLUMN ${name} ${type}`);
  }
}
