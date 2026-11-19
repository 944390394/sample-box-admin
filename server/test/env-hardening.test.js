/**
 * 调试后门与跨域收口（体检编号 L-P1-7）。
 *
 * 修复前的两个洞：
 * 1. `SAMPLE_ACCEPTANCE=1`（设了 SAMPLE_HOME 时登录不校验验证码）和 `SAMPLE_WECHAT_FAKE_OPENID`
 *    （任何 code 都登进同一个账号）只靠一行 console.warn 提醒，线上忘了清环境变量照样启动；
 * 2. 每个响应都带 `Access-Control-Allow-Origin: *` 且声明允许 `Authorization`，任何网页都能调这套接口。
 *
 * 这里守住：
 * - 本机形态（临时环境、sqlite、连本机回环的 MySQL）后门照常用；远端 MySQL 这类线上形态直接判为不允许，
 *   index.js 据此拒绝启动；
 * - 跨域只放行本机来源 + SAMPLE_CORS_ORIGINS 列出的来源，放行才回 CORS 头并带 Vary: Origin；
 * - 源码里不再出现通配 `*` 的 Access-Control-Allow-Origin。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  backdoorRefusalMessage,
  checkDebugBackdoors,
  debugBackdoors,
} from "../src/runtimeGuards.js";
import { corsHeaders, corsOrigin, parseCorsOrigins } from "../src/http/cors.js";

test("后门变量清单：只认真正开启的", () => {
  assert.deepEqual(debugBackdoors({}), []);
  assert.deepEqual(debugBackdoors({ SAMPLE_ACCEPTANCE: "0" }), []);
  assert.deepEqual(debugBackdoors({ SAMPLE_ACCEPTANCE: "1", SAMPLE_WECHAT_FAKE_PHONE: "" }), [
    "SAMPLE_ACCEPTANCE",
  ]);
  assert.deepEqual(
    debugBackdoors({ SAMPLE_WECHAT_FAKE_OPENID: "o-dev", SAMPLE_WECHAT_FAKE_PHONE: "13800000000" }),
    ["SAMPLE_WECHAT_FAKE_OPENID", "SAMPLE_WECHAT_FAKE_PHONE"]
  );
});

test("本机形态放行，线上形态拒绝启动", () => {
  const env = { SAMPLE_ACCEPTANCE: "1" };
  // 验收/调试临时环境：os.tmpdir() 之下的一次性目录，放行（跨平台用真实临时目录）
  assert.equal(
    checkDebugBackdoors({
      env,
      homeDir: path.join(os.tmpdir(), "samplebox-verify"),
      config: null,
    }).allowed,
    true
  );
  // 本机 sqlite 开发库
  const sqlite = checkDebugBackdoors({ env, config: { dialect: "sqlite" } });
  assert.equal(sqlite.allowed, true, sqlite.reason);
  // 本机 MySQL（回环地址）照常调试
  assert.equal(
    checkDebugBackdoors({ env, config: { dialect: "mysql", host: "127.0.0.1" } }).allowed,
    true
  );
  // 没装库时还不知道连的是哪儿，等装上再判
  assert.equal(checkDebugBackdoors({ env, config: null }).allowed, true);
  // 远端 MySQL 是线上形态：不允许，且文案点名是哪几个变量
  const remote = checkDebugBackdoors({
    env: { SAMPLE_ACCEPTANCE: "1", SAMPLE_WECHAT_FAKE_OPENID: "o-1" },
    config: { dialect: "mysql", host: "db.prod.internal" },
  });
  assert.equal(remote.allowed, false, "带着后门连生产库竟然放行");
  assert.match(remote.reason, /db\.prod\.internal/);
  const message = backdoorRefusalMessage(remote);
  assert.match(message, /SAMPLE_ACCEPTANCE/);
  assert.match(message, /SAMPLE_WECHAT_FAKE_OPENID/);
  assert.match(message, /SAMPLE_HOME/, "要给出可用的替代做法");
  // 没设后门就不存在拒绝启动的问题
  assert.equal(
    checkDebugBackdoors({ config: { dialect: "mysql", host: "db.prod.internal" } }).allowed,
    true
  );
});

test("R-11：SAMPLE_HOME 非临时目录不放行后门，0.0.0.0 不算回环", () => {
  const env = { SAMPLE_ACCEPTANCE: "1", SAMPLE_WECHAT_FAKE_OPENID: "o-1" };
  // 运维把生产数据挪到大盘也会设 SAMPLE_HOME：非临时目录 + 远端 MySQL → 拒绝带后门启动
  const prodHome = path.resolve(os.homedir(), "samplebox-prod-data");
  const remote = checkDebugBackdoors({
    env,
    homeDir: prodHome,
    config: { dialect: "mysql", host: "db.prod.internal" },
  });
  assert.equal(remote.allowed, false, "非临时 SAMPLE_HOME + 远端 MySQL 竟然放行后门");
  assert.match(remote.reason, /db\.prod\.internal/);
  // 只有 os.tmpdir() 之下的一次性目录才视为临时环境：即便配了远端库也放行（验收机器人形态）
  assert.equal(
    checkDebugBackdoors({
      env,
      homeDir: path.join(os.tmpdir(), "samplebox-verify"),
      config: { dialect: "mysql", host: "db.prod.internal" },
    }).allowed,
    true,
    "临时目录里的一次性验收环境应放行"
  );
  // 非临时 SAMPLE_HOME 但连本机 sqlite：落回数据库形态判定，仍是本机开发，放行
  assert.equal(
    checkDebugBackdoors({ env, homeDir: prodHome, config: { dialect: "sqlite" } }).allowed,
    true
  );
  // 0.0.0.0 是监听地址不是回环客户端主机名：带后门连 host=0.0.0.0 的 MySQL 要拒绝
  assert.equal(
    checkDebugBackdoors({ env, config: { dialect: "mysql", host: "0.0.0.0" } }).allowed,
    false,
    "0.0.0.0 被误当回环放行"
  );
  // 真正的回环主机名仍放行
  assert.equal(
    checkDebugBackdoors({ env, config: { dialect: "mysql", host: "127.0.0.1" } }).allowed,
    true
  );
  assert.equal(
    checkDebugBackdoors({ env, config: { dialect: "mysql", host: "localhost" } }).allowed,
    true
  );
});

test("跨域只放行本机来源和显式白名单", () => {
  assert.deepEqual(parseCorsOrigins("https://a.example, https://b.example ,"), [
    "https://a.example",
    "https://b.example",
  ]);
  assert.equal(corsOrigin("http://localhost:5174"), "http://localhost:5174");
  assert.equal(corsOrigin("http://127.0.0.1:8000"), "http://127.0.0.1:8000");
  assert.equal(corsOrigin("http://[::1]:3000"), "http://[::1]:3000");
  // 公网来源没列进白名单就是不放行
  assert.equal(corsOrigin("https://evil.example"), null);
  assert.equal(
    corsOrigin("https://admin.example", { allow: parseCorsOrigins("https://admin.example") }),
    "https://admin.example"
  );
  // 同源请求、小程序、服务端脚本不带 Origin：不需要 CORS 头
  assert.deepEqual(corsHeaders("", { allow: [] }), {});
  const headers = corsHeaders("https://admin.example", {
    allow: ["https://admin.example"],
    expose: ["Content-Disposition"],
  });
  assert.equal(headers["Access-Control-Allow-Origin"], "https://admin.example");
  assert.equal(
    headers["Access-Control-Allow-Credentials"],
    undefined,
    "凭据走请求头，不开 cookie 跨域"
  );
  assert.match(headers["Access-Control-Allow-Headers"], /Authorization/);
  assert.equal(headers.Vary, "Origin", "响应随 Origin 变，缓存要分开");
  assert.deepEqual(headers["Access-Control-Expose-Headers"], "Content-Disposition");
  // SAMPLE_CORS_LOOPBACK=0 时连本机来源也不放行
  assert.equal(corsOrigin("http://localhost:5174", { allowLoopback: false }), null);
});

test("接口响应不再回通配 Access-Control-Allow-Origin", () => {
  for (const file of ["../index.js", "../org-api.js"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(!/Access-Control-Allow-Origin"\s*:\s*"\*/.test(text), `${file} 里还有通配跨域`);
  }
});
