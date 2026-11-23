/**
 * #26 B2（D4）：操作日志导出 CSV。
 * - 列与列表页一致（时间/单位/操作者/动作/对象/结果/来源 IP），外加详情抽屉里的「明细」（055a 的 detail 列）；
 *   #94 起对象拆「对象类型/对象编号/对象名称」三列，名称与列表 targetName 同口径（additive，编号保留供追溯）；
 * - 范围与过滤复用 operationLog.js 的 operationScope/operationLogExportQuery：越权 orgId 收敛为空表，不报错泄露；
 * - 上限 5 万行，超出截断：响应头 X-Export-Truncated/X-Export-Row-Count/X-Export-Max + CSV 末尾注释行双标明；
 * - 文件名只含日期，不含账号/单位等敏感信息；
 * - 转义规约：引号/逗号/换行转义；#26 m-08：首字符或前导空白（空格/制表符/换行等）后接 =+-@
 *   的单元格都加单引号前缀防表格注入（OWASP 口径；SampleController.csvCell 同规约待后续批同步）；
 * - #26 B-01：对象编号/明细里的整串 IMEI 按查看者设备标识权限打码（取数层统一处理）；
 * - #26 M-01：时间范围等校验错误回 HTTP 400 + A0001，前端 blob 通路按失败处理；
 * - #26 m-09：审计在流式下载完成后才写「成功」，下载抛错写「失败」并重抛（不再下载前预记成功）。
 */
import { formatTimestamp } from "../domain/Clock.js";
import { audit } from "./audit.js";
import { OPERATION_LOG_EXPORT_MAX, queryOperationLogsForExport } from "./operationLog.js";

const COLUMNS = [
  ["时间", (item) => item.createdAt],
  ["单位", (item) => item.orgName],
  ["操作者", (item) => item.actorName],
  ["动作", (item) => item.action],
  ["对象类型", (item) => item.targetType],
  ["对象编号", (item) => item.targetId],
  // #94：对象可读名（与列表/详情同口径的 targetName，含回退「类型 #id」）；
  // additive 加列保留对象编号供精确追溯，csvCell 防注入同样覆盖本列。
  ["对象名称", (item) => item.targetName],
  ["结果", (item) => item.result],
  ["来源 IP", (item) => item.ip],
  ["明细", (item) => item.detail],
];

export function csvCell(value) {
  const text = value == null ? "" : String(value);
  // #26 m-08：前导空白后的公式同样加前缀（部分表格软件会先修剪空白再解析公式）。
  // 注意 - 必须转义：[=+-@] 会被解析成 +–@ 区间（误伤数字/标点）。
  const safe = /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** 生成 CSV 行（BOM 表头 + 数据行 + 截断注释行）。空范围只给表头，不泄露。 */
export function* operationLogCsvLines(rows, { truncated = false, max = 0 } = {}) {
  yield `\uFEFF${COLUMNS.map(([title]) => csvCell(title)).join(",")}\r\n`;
  for (const item of rows || []) {
    yield `${COLUMNS.map(([, read]) => csvCell(read(item))).join(",")}\r\n`;
  }
  if (truncated) {
    yield `# 已达单次导出上限 ${max} 行，仅导出最近的 ${max} 行；其余记录请缩小时间范围后分批导出\r\n`;
  }
}

/** 文件名只含日期：操作日志-YYYY-MM-DD.csv。 */
export function operationLogCsvName(now = new Date()) {
  return `操作日志-${formatTimestamp(now).slice(0, 10)}.csv`;
}

/** GET /api/v1/system/operation-logs/export（perm sys:oplog:export）。ctx 口径与 org-api 处理器一致，可单测。 */
export async function operationLogsExport(ctx) {
  if (typeof ctx.download !== "function") return ctx.fail("当前环境不支持导出");
  // #26 B-01：对象编号/明细里的整串 IMEI 按查看者设备标识权限读时打码（requireAccess 已解析 ctx.access）
  const result = await queryOperationLogsForExport(
    ctx.db,
    ctx.user,
    ctx.query,
    OPERATION_LOG_EXPORT_MAX,
    ctx.access?.perms ?? null
  );
  // #26 M-01：范围/时间错误带 HTTP 400，不再 200——blob 下载通路才能识别为失败而不是假成功
  if (result.error) return ctx.fail(result.error, "A0001", 400);
  const entry = {
    orgId: String(ctx.user.dept_id || ""),
    actorId: String(ctx.user.id),
    actorName: ctx.user.nickname || ctx.user.username,
    action: "导出操作日志",
    targetType: "oplog",
    targetId: "",
    ip: ctx.ip,
  };
  // #26 m-09：审计挪到下载完成之后——streamDownload（index.js）写完全部 chunk 并 res.end() 才 resolve，
  // 中途抛错（生成器异常/连接写出错）会 reject：失败写「失败」再重抛（dispatcher 对 headersSent 销毁半截响应），
  // 成功只在流结束后写，不再下载前预记「成功」。
  try {
    await ctx.download(operationLogCsvName(), operationLogCsvLines(result.rows, result), {
      "X-Export-Row-Count": String(result.rows.length),
      "X-Export-Truncated": result.truncated ? "1" : "0",
      "X-Export-Max": String(result.max),
    });
  } catch (error) {
    await audit(ctx.db, { ...entry, result: "失败" });
    throw error;
  }
  await audit(ctx.db, { ...entry, result: "成功" });
}
