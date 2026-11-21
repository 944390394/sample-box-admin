/**
 * R23 三类型反转合并（任务 #56）：把 056「送检并入采样」的存量按原 kind 回填成三类型。
 *
 * 背景：056_org_simplify 把 kind=送检 并入 采样（待寄出→已封箱、运送中→在途），原值整表备份在
 * _bak_org_simplify_task。R23 用户拍板恢复三类型（采样＝仅本地／送检＝仅寄送／采样后送检＝合并全流），
 * 本迁移按备份表的原 kind 反向归位；056 之后新建（无备份行）按现 kind＋inspect 推断。
 *
 * 映射矩阵（origKind＝备份原 kind，无备份取现 kind）：
 * - origKind=送检 → kind=送检；状态逆映射 056（已封箱→待寄出、在途→运送中，其余同名）；
 *   body 去掉 trip/tripDerived（送检无方向概念），inspect 恒 true。056 后若已沿合并流推进，
 *   现态 待签收/待检测/已检测/退回中/已退回/已拒收/已取消 同名保留（进度不丢）。
 * - origKind=采样 且 inspect=true（含 059 回填 trip 的合并单/旧送检映射单）→ kind=采样后送检；状态同名；trip 沿用 059。
 * - origKind=采样 且 inspect=false：
 *   - 无 trip 且停本地态（待采样/采样中/已封箱/待执行/执行中/已取消）→ kind=采样（仅本地），
 *     写 localOnly=true、inspect=false、清 trip/toOrg，to_org_id 置空；已封箱即终态OK（箱留采样单位）。
 *   - 其余（带 trip 的旧寄送采样单，或停 在途/待签收/待检测/已检测/退回中/已退回/已拒收 的旧无 inspect 单）
 *     → kind=采样后送检（PM 裁量近似：这些单有寄送/检测事实，归合并全流；旧 trip 单按 trip 渲染合并步条，
 *     极旧单向停 待寄出/运送中 者步条可能缺格——存量极少，报告注明近似）。
 * - 调拨/划拨 kind 不动（只读保留／独立端点）。
 *
 * 幂等：逐行算目标态，与现态逐字节相同则跳过；UPDATE 带原 kind/status/body 条件，重跑/并发落 0 行。
 * 备份：改写前整表备份 _bak_060_three_kinds_task（CREATE TABLE IF NOT EXISTS，重跑不覆盖首次备份）。
 * 不改 sample_task_box 快照/opens/inspected（快照冻结口径不变）；is_inspect 列随 inspect 语义天然一致不动。
 */
import { TRIPS } from "../../shared/taskFlow.js";

/** 仅本地采样单的合法状态（含极旧 待执行/执行中 与终态 已取消）。 */
const LOCAL_STATUSES = new Set(["待采样", "采样中", "已封箱", "待执行", "执行中", "已取消"]);
/** 056 送检状态映射的逆映射（待寄出→已封箱、运送中→在途 的反向）。 */
const INSPECT_REVERSE = { 已封箱: "待寄出", 在途: "运送中" };

export async function up(db) {
  await db.run(`CREATE TABLE IF NOT EXISTS _bak_060_three_kinds_task AS SELECT * FROM sample_task`);
  // 056 备份表（migrate 序保证已建）；直接调用 up060 且无 056 备份时按「无备份」推断
  const bakRows = await db
    .all("SELECT id, kind, status, body FROM _bak_org_simplify_task")
    .catch(() => []);
  const bakMap = new Map(bakRows.map((row) => [String(row.id), row]));

  const rows = await db.all(
    "SELECT id, kind, status, body, to_org_id, is_inspect FROM sample_task"
  );
  for (const row of rows) {
    if (row.kind === "划拨" || row.kind === "调拨") continue;
    let body;
    try {
      body = row.body ? JSON.parse(row.body) : null;
    } catch {
      continue; // body 损坏不动
    }
    if (!body || typeof body !== "object") continue;
    const bak = bakMap.get(String(row.id));
    const origKind = bak ? bak.kind : row.kind;
    if (origKind === "采样后送检") continue; // 已是新类型（060 后新建/重跑）
    const inspect = body.inspect === true || Number(row.is_inspect) === 1;
    const hasTrip = TRIPS.includes(body.trip);

    let kind;
    let status = row.status;
    let toOrgId = row.to_org_id;
    const nb = { ...body };
    if (origKind === "送检") {
      kind = "送检";
      status = INSPECT_REVERSE[row.status] || row.status;
      delete nb.trip;
      delete nb.tripDerived;
      nb.inspect = true;
    } else if (origKind === "采样") {
      if (inspect) {
        kind = "采样后送检";
      } else if (!hasTrip && LOCAL_STATUSES.has(row.status)) {
        kind = "采样";
        nb.localOnly = true;
        nb.inspect = false;
        delete nb.trip;
        delete nb.tripDerived;
        delete nb.toOrg;
        delete nb.toOrgId;
        toOrgId = null;
      } else {
        kind = "采样后送检";
      }
    } else {
      continue; // 未知 origKind 不动
    }
    nb.kind = kind;
    if ("status" in nb) nb.status = status;
    const bodyText = JSON.stringify(nb);
    // 逐字节相同则跳过（幂等）；否则带原值条件改写，重跑/并发落 0 行
    if (
      kind === row.kind &&
      status === row.status &&
      bodyText === row.body &&
      (toOrgId ?? null) === (row.to_org_id ?? null)
    )
      continue;
    await db.run(
      "UPDATE sample_task SET kind=?, status=?, body=?, to_org_id=? WHERE id=? AND kind=? AND status=? AND body=?",
      [kind, status, bodyText, toOrgId, row.id, row.kind, row.status, row.body]
    );
  }
}
