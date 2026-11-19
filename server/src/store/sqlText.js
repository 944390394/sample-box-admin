/**
 * LIKE 查询的参数统一在这里拼，配合 ESCAPE '!' 用。
 *
 * 转义符选 ! 不选反斜杠：MySQL 默认把反斜杠当字符串转义符，SQL 字面量里写 ESCAPE '\\'
 * 到了服务端就成了不闭合的转义，SQLite 和 MySQL 行为还不一致。
 *
 * 以前每个查询点各写一份：箱子列表用 !、系统日志用反斜杠、任务单关键字干脆不转义。
 * 结果是同一个关键字（比如「100%」或「a_b」）在列表页和日志页匹配范围不一样，
 * 不转义的那边 % _ 还当通配符，等于把筛选条件放大。
 */

/** LIKE 的转义符。拼进 SQL 用 ESCAPE_SQL。 */
export const LIKE_ESCAPE = "!";

/** 拼进 SQL 的转义子句：`LIKE ? ESCAPE '!'`。参数用 likePattern() 生成。 */
export const ESCAPE_SQL = `ESCAPE '${LIKE_ESCAPE}'`;

/** 把用户输入里的转义符、%、_ 都码掉，只处理字面内容。 */
export function escapeLike(text) {
  return String(text ?? "").replace(
    new RegExp(`[${LIKE_ESCAPE}%_]`, "g"),
    (char) => `${LIKE_ESCAPE}${char}`
  );
}

/**
 * 用户输入变成 LIKE 的模式：默认两端通配（包含匹配）。
 * prefix/suffix 给「只朝一个方向匹配」或「包在 JSON 片段里」的查询用，传空串就不加。
 */
export function likePattern(text, { prefix = "%", suffix = "%" } = {}) {
  return `${prefix}${escapeLike(text)}${suffix}`;
}
