import { DROPPED_045, SPLIT_045, cardsFor, grantsAll } from "../src/auth/permCatalog.js";

/**
 * 权限逐项明细：一项管几件事的码拆开（SPLIT_045），工作台卡片组换成逐张卡片。
 * - 角色：新码继承产生它的老码的「可转授」；按原来能看的内容补上逐张卡片，工作台显示不变；
 * - 部门上限：同样拆开（044 刚建，通常为空）。
 * 跑两次结果不变。
 */
function expand(rows) {
  const have = new Map(rows.map((row) => [row.perm, Number(row.grantable) === 1 ? 1 : 0]));
  for (const [old, parts] of Object.entries(SPLIT_045)) {
    if (!have.has(old)) continue;
    const flag = have.get(old);
    if (!parts.includes(old)) have.delete(old);
    for (const code of parts) have.set(code, Math.max(have.get(code) ?? 0, flag));
  }
  for (const code of DROPPED_045) have.delete(code);
  return have;
}

export async function up(db) {
  let roles;
  try {
    roles = await db.all("SELECT id, code FROM sys_role");
  } catch {
    return;
  }
  for (const role of roles) {
    if (role.code === "ADMIN") continue;
    const id = String(role.id);
    const rows = await db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id = ?", [id]);
    if (!rows.length) continue;
    const next = expand(rows.map((row) => ({ perm: String(row.perm), grantable: row.grantable })));
    const cardFlag = grantsAll([...next.keys()]) ? 1 : 0;
    for (const card of cardsFor([...next.keys()])) next.set(card, cardFlag);
    const before = new Map(
      rows.map((row) => [String(row.perm), Number(row.grantable) === 1 ? 1 : 0])
    );
    for (const perm of before.keys())
      if (!next.has(perm))
        await db.run("DELETE FROM sys_role_perm WHERE role_id = ? AND perm = ?", [id, perm]);
    for (const [perm, flag] of next) {
      if (!before.has(perm))
        await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES (?, ?, ?)", [
          id,
          perm,
          flag,
        ]);
      else if (before.get(perm) !== flag)
        await db.run("UPDATE sys_role_perm SET grantable = ? WHERE role_id = ? AND perm = ?", [
          flag,
          id,
          perm,
        ]);
    }
  }
  const depts = await db.all("SELECT DISTINCT dept_id FROM sys_dept_perm");
  for (const { dept_id: deptId } of depts) {
    const rows = await db.all("SELECT perm FROM sys_dept_perm WHERE dept_id = ?", [deptId]);
    const next = expand(rows.map((row) => ({ perm: String(row.perm), grantable: 0 })));
    for (const card of cardsFor([...next.keys()])) next.set(card, 0);
    const before = new Set(rows.map((row) => String(row.perm)));
    for (const perm of before)
      if (!next.has(perm))
        await db.run("DELETE FROM sys_dept_perm WHERE dept_id = ? AND perm = ?", [deptId, perm]);
    for (const perm of next.keys())
      if (!before.has(perm))
        await db.run("INSERT INTO sys_dept_perm (dept_id, perm) VALUES (?, ?)", [deptId, perm]);
  }
}
