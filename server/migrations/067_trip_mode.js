/**
 * R28 寄送方向可选＋双向寄回腿（任务 #92）：给存量合并单 body 打 tripMode 标，分流新旧语义。
 *
 * 背景：R22（059）把合并单方向改为按箱归属派生（箱在检测站→双向＝检测站首腿寄出→分公司采样→寄回检测站）。
 * R28 用户拍板方向改回可选（单向/双向，默认单向），双向新语义＝检测完寄回寄出分公司（寄回腿：
 * 已检测→待寄回→寄回在途→待归还→已归还，分公司签收归还）。两套「双向」语义不能混：
 * - 旧 trip=双向（R22 派生站首腿）→ tripMode='stationFirst'：流程/步条/文案保持旧样，只读收尾；
 * - 旧 trip=单向 → tripMode='oneWay'：与现行为逐字节一致；
 * - 新单建单恒写显式 tripMode（双向='return'、单向='oneWay'），不经本迁移。
 *
 * 候选：isMergedSample（kind=采样后送检＋旧合并别名 kind=采样＋inspect/tripDerived，排除 localOnly/legacy）
 * 且 body 无 tripMode。无 trip 的存量单（059 无箱快照跳过者）不打标——读时回算（#taskView）兜底，
 * tripModeOf 按 trip 推断（双向→stationFirst、其余 oneWay），口径一致。
 * 送检/划拨/调拨/旧采样单不动：送检存量无 trip，tripModeOf 推断 oneWay（行为不变）。
 *
 * 只写 body.tripMode：不改 status/列/sample_task_box 快照（快照冻结口径不变）。
 * 幂等：候选条件排除已打标；UPDATE 带原 body 条件，重跑/并发落 0 行。
 * 备份：改写前整表备份 _bak_067_trip_mode_task（CREATE TABLE IF NOT EXISTS，重跑不覆盖首次备份）。
 */
import { isMergedSample, TRIPS } from "../../shared/taskFlow.js";

export async function up(db) {
  await db.run(`CREATE TABLE IF NOT EXISTS _bak_067_trip_mode_task AS SELECT * FROM sample_task`);
  const rows = await db.all(
    "SELECT id, kind, body FROM sample_task WHERE kind IN ('采样','采样后送检')"
  );
  for (const row of rows) {
    let body;
    try {
      body = row.body ? JSON.parse(row.body) : null;
    } catch {
      continue; // body 损坏不动
    }
    if (!body || typeof body !== "object") continue;
    if (body.tripMode) continue; // 已打标（新单/重跑）
    if (!isMergedSample({ ...body, kind: row.kind })) continue;
    if (!TRIPS.includes(body.trip)) continue; // 无 trip 的存量单读时回算兜底，不硬派生
    body.tripMode = body.trip === "双向" ? "stationFirst" : "oneWay";
    await db.run("UPDATE sample_task SET body=? WHERE id=? AND body=?", [
      JSON.stringify(body),
      row.id,
      row.body,
    ]);
  }
}
