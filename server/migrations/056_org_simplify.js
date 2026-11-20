/**
 * 组织简化 B1b（P3/P4/P5）＋B1c（P7）：类型归一＋角色合并＋存量映射落库＋备份表。
 * 幂等（按当前值条件更新，重跑结果不变）。
 *
 * ① 类型归一：type=采样机构 的部门——总公司子树内恰一个且启用、且库里还没有检测站时，
 *    自动指定为唯一检测站（type=检测站，resolveStation 的 DB 回退会认定它，无需写配置）；
 *    其余采样机构一律改 公司（它们本来就是采样单位＝分公司语义）。
 * ② 角色合并：AGENCY_LEAD（种子 id14）持有者改绑 BRANCH_ADMIN（已有绑定去重），
 *    删 14 的绑定、sys_role 14 停用（status=0，不物理删，保留审计）。
 * ②b 建单码补齐（B4a，B3 遗留②）：BRANCH_ADMIN/DISPATCH 默认码补 task:create:sample
 *    （分公司自采建单是 P11 主路径；新库走 permCatalog LEGACY_DEFAULTS，存量库在这里补）。
 *    幂等：先查存在再补；可转授按 grantsAll（有 role:grant/user:role 的角色全可转授，
 *    与 seedRolePerms/055b 一致）。只补不删——角色页显式收回过的项会被恢复（一次性，发布说明列明）。
 * ③ DEFAULT 种子不种 14、机构子树 5/51/52/511/521 删除、13 改「总部检测站」type=检测站——
 *    在 shared/org.js（新装库生效）；存量库的机构节点改挂不删 id（P4），由管理员在部门页操作。
 * ④ 备份受影响表整表到 _bak_org_simplify_*（sys_dept/sys_role/sys_user_role＋B1c 的 sample_task）；
 *    CREATE TABLE IF NOT EXISTS 保证重跑不覆盖首次备份（备份仅作单表补救，正式回滚靠迁移前整库备份）。
 * ⑤ P7 存量映射落库（B1c）：kind=送检 并入 采样（待寄出→已封箱、运送中→在途、其余同名），
 *    旧 kind=采样 终态对齐（待核验→待检测、已签收→已检测、已完成→已检测、其余同名）。
 *    映射常量单源 shared/taskFlow.js（LEGACY_KIND_MAP/LEGACY_STATUS_MAP）；保留原 id/IN- 前缀作历史事实，
 *    trip 字段只读保留不动，调拨/划拨 kind 不改；body JSON 里的 kind/status 快照同步改写。
 *    改写前原 kind/status/body 已整表备份进 _bak_org_simplify_task（映射不可逆的补救底）。
 *    幂等：条件选行＋采样子句按备份表排除原送检单（异常跨 kind 状态重跑不二次映射）。
 *
 * P4 其余面不改写：sample_task_box 快照/sys_operation_log/sys_user.dept_id 一律不动；
 * 历史可见性靠 COALESCE(现箱归属,快照) 自动跟随（boxAccess.historicalScopeSql）。
 * 映射后旧 kind 在途箱由总览合并单主口径计入（INBOUND 的 legacy 调拨/送检分支只服务未映射库）。
 */
import {
  LEGACY_KIND_MAP,
  LEGACY_STATUS_MAP,
  migrateKind,
  migrateStatus,
} from "../../shared/taskFlow.js";
import { grantsAll } from "../src/auth/permCatalog.js";

export async function up(db) {
  // ④ 备份先于改动
  for (const table of ["sys_dept", "sys_role", "sys_user_role"]) {
    await db.run(`CREATE TABLE IF NOT EXISTS _bak_org_simplify_${table} AS SELECT * FROM ${table}`);
  }
  // P7（B1c）：sample_task 整表备份——改写前原 kind/status/body 留底。
  // 该表此前不存在（B1b 只备份三张组织表）；IF NOT EXISTS 保证重跑不覆盖首次快照。
  await db.run(`CREATE TABLE IF NOT EXISTS _bak_org_simplify_task AS SELECT * FROM sample_task`);

  // ① 类型归一
  const depts = await db.all("SELECT id, parent_id, type, status, sort FROM sys_dept");
  const byId = new Map(depts.map((row) => [String(row.id), row]));
  // 总公司＝第一个根（按 sort、id，与 OverviewController.#units / boxConfig.hqIdOf 同约定）
  const roots = depts
    .filter((row) => !byId.has(String(row.parent_id)))
    .sort(
      (a, b) =>
        (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.id).localeCompare(String(b.id))
    );
  const hq = String(roots[0]?.id ?? "");
  const underHq = (id) => {
    if (!hq || String(id) === hq) return false;
    let cur = String(byId.get(String(id))?.parent_id ?? "");
    const seen = new Set();
    while (cur && cur !== "0" && !seen.has(cur)) {
      if (cur === hq) return true;
      seen.add(cur);
      cur = String(byId.get(cur)?.parent_id ?? "");
    }
    return false;
  };
  const hasStation = depts.some((row) => row.type === "检测站");
  const candidates = depts.filter(
    (row) => row.type === "采样机构" && Number(row.status) === 1 && underHq(row.id)
  );
  // 总公司下恰一个采样机构时自动指定为检测站（P5 迁移默认）；已有检测站则不再指定（全局唯一）
  if (!hasStation && candidates.length === 1) {
    await db.run("UPDATE sys_dept SET type = '检测站' WHERE id = ? AND type = '采样机构'", [
      String(candidates[0].id),
    ]);
  }
  await db.run("UPDATE sys_dept SET type = '公司' WHERE type = '采样机构'");

  // ② 角色合并：AGENCY_LEAD → BRANCH_ADMIN（去重），14 停用不物理删
  const agency = await db.get("SELECT id FROM sys_role WHERE code = 'AGENCY_LEAD'");
  if (agency) {
    const agencyId = String(agency.id);
    const branch = await db.get("SELECT id FROM sys_role WHERE code = 'BRANCH_ADMIN'");
    if (branch) {
      const branchId = String(branch.id);
      const holders = await db.all("SELECT user_id FROM sys_user_role WHERE role_id = ?", [
        agencyId,
      ]);
      for (const holder of holders) {
        const userId = String(holder.user_id);
        const dup = await db.get(
          "SELECT 1 AS x FROM sys_user_role WHERE user_id = ? AND role_id = ?",
          [userId, branchId]
        );
        if (!dup)
          await db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", [
            userId,
            branchId,
          ]);
      }
    }
    await db.run("DELETE FROM sys_user_role WHERE role_id = ?", [agencyId]);
    await db.run("UPDATE sys_role SET status = 0 WHERE id = ? AND status <> 0", [agencyId]);
  }

  // ②b 建单码补齐（B4a）：BRANCH_ADMIN/DISPATCH 补 task:create:sample（先查存在再补，幂等）。
  // ADMIN 按码短路不落行（resolvePerms 全量）；自定义角色不动（角色页保存为准）。
  const createRoles = await db.all(
    "SELECT id, code FROM sys_role WHERE code IN ('BRANCH_ADMIN','DISPATCH')"
  );
  for (const role of createRoles) {
    const rid = String(role.id);
    const rows = await db.all("SELECT perm, grantable FROM sys_role_perm WHERE role_id = ?", [rid]);
    const have = new Set(rows.map((row) => String(row.perm)));
    if (have.has("task:create:sample")) continue;
    const flag = grantsAll([...have, "task:create:sample"]) ? 1 : 0;
    await db.run("INSERT INTO sys_role_perm (role_id, perm, grantable) VALUES (?, ?, ?)", [
      rid,
      "task:create:sample",
      flag,
    ]);
  }

  // ⑤ P7 存量映射落库（B1c）：送检并入采样＋旧采样终态对齐。
  // 选行按当前 kind/status 条件（映射后不再命中→幂等）；旧采样只选映射表列出的旧状态，
  // 合并流新单（待采样/采样中/…）天然不命中，迁移后新建的单重跑也不受影响。
  // 采样子句另排除「原 kind=送检」的单（以不覆盖的备份表为准）：异常数据若送检单停在
  // 旧采样状态（已签收/待核验/已完成），按 P7「其余同名保留」只改 kind；不排除的话
  // 重跑会被采样映射二次改写（已签收→已检测），破坏幂等。迁移后新插入的旧态单不在
  // 备份里，重跑仍按采样映射正常归一。
  const legacyKinds = Object.keys(LEGACY_KIND_MAP);
  const legacySampleStatuses = Object.keys(LEGACY_STATUS_MAP["采样"] || {});
  const clauses = legacyKinds.map(() => "kind = ?");
  const params = [...legacyKinds];
  if (legacySampleStatuses.length) {
    const statusMarks = legacySampleStatuses.map(() => "?").join(",");
    const kindMarks = legacyKinds.map(() => "?").join(",");
    clauses.push(
      `(kind = '采样' AND status IN (${statusMarks})` +
        ` AND id NOT IN (SELECT id FROM _bak_org_simplify_task WHERE kind IN (${kindMarks})))`
    );
    params.push(...legacySampleStatuses, ...legacyKinds);
  }
  const rows = await db.all(
    `SELECT id, kind, status, body FROM sample_task WHERE ${clauses.join(" OR ")}`,
    params
  );
  for (const row of rows) {
    // 按行的原 kind 取映射（先算后改，送检/采样两组映射互不串扰）
    const kind = migrateKind(row.kind);
    const status = migrateStatus(row.kind, row.status);
    // body JSON 快照同步：kind 键必有（createTask 展开 input），status 键旧数据若有也一并改；
    // trip/inspect/boxIds 等其余键原样保留。body 损坏时只改列、不动 JSON。
    let bodyText = row.body;
    try {
      const body = row.body ? JSON.parse(row.body) : null;
      if (body && typeof body === "object") {
        let touched = false;
        if ("kind" in body && body.kind !== kind) {
          body.kind = kind;
          touched = true;
        }
        if ("status" in body && body.status !== status) {
          body.status = status;
          touched = true;
        }
        if (touched) bodyText = JSON.stringify(body);
      }
    } catch {
      /* 保持原 body */
    }
    // 单行 kind/status/body 一条 UPDATE 原子改写；WHERE 带原值条件，重跑/并发都落 0 行
    await db.run(
      "UPDATE sample_task SET kind=?, status=?, body=? WHERE id=? AND kind=? AND status=?",
      [kind, status, bodyText, row.id, row.kind, row.status]
    );
  }
}
