/**
 * 启动期调试后门守卫（体检编号 L-P1-7）。
 *
 * `SAMPLE_ACCEPTANCE=1` 让登录不校验验证码，`SAMPLE_WECHAT_FAKE_OPENID` 让任何 code 都登进同一个账号。
 * 修复前只靠一行 console.warn：线上忘了清环境变量，服务照常用后门跑，等于把登录门户开着。
 * 现在判定标准是「这套环境是不是只在本机」：
 * - 验收/调试临时目录（SAMPLE_HOME 落在系统临时目录 os.tmpdir() 之下）——放行，本来就是一次性的；
 * - 没装库（还没连数据库）——放行，装完再判；
 * - 数据库是 sqlite，或 MySQL 连的是本机回环地址——放行，是本机开发；
 * - 其余（远端 MySQL 等线上形态）——直接拒绝启动，不退出让它带着后门跑。
 *
 * 注意（R-11）：SAMPLE_HOME 只是「数据目录重定向」，不是「临时」的同义词。运维把生产数据挪到大盘
 * 也会设 SAMPLE_HOME，所以只有落在 os.tmpdir() 之下的 home 才当一次性临时环境放行；非临时目录即使
 * 设了 SAMPLE_HOME，也照常按数据库形态判定（远端 MySQL 一律拒绝带后门启动）。
 */
import os from "node:os";
import path from "node:path";

/**
 * 只在这些主机上算本机开发。
 * 0.0.0.0 是「监听所有网卡」的地址，不是客户端回环主机名：MySQL 配置里写 host=0.0.0.0
 * 并不能证明连的是本机库，故从回环名单里去掉（R-11）。
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * homeDir 是否落在系统临时目录之下（严格子目录）。
 * 用 path.relative 判定，跨盘符/跨平台都安全：返回空串（就是 tmp 本身）、以 .. 开头（在 tmp 之外）
 * 或绝对路径（不同盘符）都不算临时目录。Windows 下 path.relative 自身按大小写不敏感比较。
 */
function isTempHome(homeDir) {
  if (!homeDir) return false;
  const rel = path.relative(path.resolve(os.tmpdir()), path.resolve(homeDir));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** 后门环境变量清单：值非空（ACCEPTANCE 要等于 1）才算开了。 */
export function debugBackdoors(env = process.env) {
  const found = [];
  if (env.SAMPLE_ACCEPTANCE === "1") found.push("SAMPLE_ACCEPTANCE");
  if (env.SAMPLE_WECHAT_FAKE_OPENID) found.push("SAMPLE_WECHAT_FAKE_OPENID");
  if (env.SAMPLE_WECHAT_FAKE_PHONE) found.push("SAMPLE_WECHAT_FAKE_PHONE");
  return found;
}

/**
 * @param {{config?: {dialect?: string, host?: string} | null, homeDir?: string, env?: object}} options
 * @returns {{allowed: boolean, local: boolean, found: string[], reason: string}}
 */
export function checkDebugBackdoors({ config = null, homeDir = "", env = process.env } = {}) {
  const found = debugBackdoors(env);
  if (!found.length) return { allowed: true, local: true, found, reason: "" };
  // 只有落在系统临时目录下的一次性 home 才直接放行；非临时的 SAMPLE_HOME（如生产数据盘）
  // 不享受这条捷径，继续往下按数据库形态判定，远端 MySQL 会被拒绝（R-11）。
  if (isTempHome(homeDir)) return { allowed: true, local: true, found, reason: "临时环境" };
  // 还没装库：连的是哪个数据库还不知道，等装上再说
  if (!config) return { allowed: true, local: false, found, reason: "尚未安装" };
  const dialect = String(config.dialect || "");
  if (dialect && dialect !== "mysql")
    return { allowed: true, local: true, found, reason: `本机 ${dialect} 库` };
  const host = String(config.host || "").trim();
  if (LOOPBACK_HOSTS.has(host))
    return { allowed: true, local: true, found, reason: `本机数据库 ${host}` };
  return {
    allowed: false,
    local: false,
    found,
    reason: `连的是 ${dialect || "未知"} 数据库 ${host || "（无主机名）"}`,
  };
}

/** 拒绝启动时要写出去的话：说清是哪几个变量、怎么关掉。 */
export function backdoorRefusalMessage(check) {
  return (
    `线上环境不允许带调试后门：${check.found.join("、")}（${check.reason}）。` +
    "请在启动环境里去掉这些变量；本机调试或验收改用 sqlite/本机数据库，或把 SAMPLE_HOME 指向系统临时目录下的一次性目录。"
  );
}
