/**
 * R22 trip 派生（任务 #55）：存量合并采样单按建单快照回填 body.trip＋tripDerived 标记。
 *
 * 事实澄清：trip 从未是 sample_task 的列（014 建表即无 trip；050 只加 from_org_id/to_org_id/is_inspect），
 * 一直是 body JSON 字段——所以本迁移不「恢复列」，而是把 R22 的派生方向持久化进 body：
 * - 候选：kind=采样 且 is_inspect=1 且 body.inspect=true 且无 trip/tripDerived（056 映射后的旧送检也在内）；
 * - 派生：首箱建单快照 org（sample_task_box.org_id，ORDER BY box_id LIMIT 1；空＝总公司根）
 *   对照生效检测站（resolveStation：配置优先→DB 恰一个自动认定）＋body.orgId（采样单位）；
 *   箱在检测站且采样单位≠检测站→双向，否则单向（deriveTrip 单源 shared/taskFlow.js）。
 * - 只写 body.trip/body.tripDerived：不改 status/列/sample_task_box 快照（快照冻结口径不变）。
 *   无箱快照的单（历史空单）跳过——读时回算（#taskView）同样跳过，显示保持 7 步合并流。
 * - 旧采样单（is_inspect=0）与带 trip 的旧单（legacy）不动：它们走旧流只读兼容。
 *
 * 幂等：候选条件排除已回填（tripDerived/trip 在 body）；UPDATE 带原 body 条件，重跑/并发落 0 行。
 * 备份：改写前整表备份 _bak_trip_derived_task（CREATE TABLE IF NOT EXISTS，重跑不覆盖首次备份）。
 * 注意：迁移先于 applyBoxSettings 时 stationDeptId() 为空，resolveStation 走 DB 自动认定
 * （生产/夹具均总公司下恰一个检测站，口径一致）；多检测站库须先配置再跑迁移。
 */
import { deriveTrip, TRIPS } from "../../shared/taskFlow.js";
import { resolveStation } from "../src/settings/boxConfig.js";
import { rootOrgId } from "../src/settings/ReportPolicy.js";

export async function up(db) {
  await db.run(`CREATE TABLE IF NOT EXISTS _bak_trip_derived_task AS SELECT * FROM sample_task`);
  const station = await resolveStation(db);
  const depts = await db.all("SELECT id, parent_id, sort FROM sys_dept");
  const root = rootOrgId(depts);
  const rows = await db.all("SELECT id, body FROM sample_task WHERE kind='采样' AND is_inspect=1");
  for (const row of rows) {
    let body;
    try {
      body = row.body ? JSON.parse(row.body) : null;
    } catch {
      continue; // body 损坏不动
    }
    if (!body || typeof body !== "object") continue;
    if (body.tripDerived === true || TRIPS.includes(body.trip)) continue;
    if (body.inspect !== true) continue;
    const link = await db.get(
      "SELECT org_id FROM sample_task_box WHERE task_id=? ORDER BY box_id LIMIT 1",
      [row.id]
    );
    if (!link) continue;
    const orgId = String(link.org_id ?? "") || root;
    body.trip = deriveTrip(orgId, station?.id, body.orgId);
    body.tripDerived = true;
    await db.run("UPDATE sample_task SET body=? WHERE id=? AND body=?", [
      JSON.stringify(body),
      row.id,
      row.body,
    ]);
  }
}
