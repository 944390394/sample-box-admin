#!/usr/bin/env node
/**
 * 小程序截图通道（微信开发者工具 CLI）——任务 #21 交付物 2
 *
 * 为什么有这个文件：上一轮我用 `ELECTRON_RUN_AS_NODE=1 + exe + skill-index.js -c Qwen <tool>`
 * 直接调，拿到 `INPUT_ERROR: Skill directory not found: …\dist\wechatide-skill, …\src\skill\wechatide-skill`，
 * 当时误判成「通道随 DevTools 版本坏了」。真实差异是**少了 `-e <BOOTSTRAP>` 这段引导**：
 * 没有它，skill-index.js 把 skill 目录解析到 `dist/` 和 `src/`（源码仓布局）；
 * 有了它，DevTools 用的是自己打包里的 `resources/app.asar.unpacked/wechatide-skill`（本轮实测 skillVersion 0.3.11）。
 * 本文件照抄 `tools/shoot-mini-overview.tmp.mjs` 的调用形式，不另造一套。
 *
 * 用法：
 *   node tools/acceptance-mp.mjs status                     # 只读：登录态 + skill 版本
 *   node tools/acceptance-mp.mjs tools                      # 这个版本可用的 tool 名单
 *   node tools/acceptance-mp.mjs shot <名字>                # 当前模拟器画面直接截图
 *   node tools/acceptance-mp.mjs open <page> [k=v ...]       # reLaunch 到某页（先 refresh 再跳，同先例）再截图
 *   node tools/acceptance-mp.mjs eval "<js 函数源码>"        # 在小程序上下文里求值（只读取证用）
 *   node tools/acceptance-mp.mjs use-role <角色键>          # 内存级改道到 8010 + 注入该角色令牌（不落盘、不改源码）
 *   node tools/acceptance-mp.mjs api <GET路径> [角色键]      # 直连隔离后端 8010 核小程序接口口径（不经模拟器）
 *
 * 隔离红线（重要）：小程序接口基址写死在 `C:/Users/94439/WeChatProjects/miniprogram-1/miniprogram/utils/config.ts`
 * 的 `LOCAL = "http://localhost:8000"` + `DEVTOOLS_TARGET = "local"`，模拟器默认打**主实例 8000**。
 * 那个文件不是我的边界，所以：
 *   - 要拍「隔离夹具数据」的图，必须由小程序侧负责人临时把 LOCAL/DEVTOOLS_TARGET 指到 127.0.0.1:8010（需授权），或
 *   - 用 `--reroute` 在本进程运行时包一层 `wx.request` 改前缀（内存级、不落盘、refresh 后会失效，见该子命令说明）。
 * 主实例/演示实例现在都是停的（PM 14:36 裁定不启动），所以不带隔离数据时页面只会是登录失败/空态——这属于预期，不是缺陷。
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT_DIR = path.join(ROOT, "reports", "acceptance", "20261119", "shots", "mini");

const DIR = "C:/Program Files (x86)/Tencent/微信web开发者工具";
const EXE = `${DIR}/微信开发者工具.exe`;
const CLI = `${DIR}/resources/app.asar.unpacked/js/common/cli/skill-index.js`;
// 与先例逐字一致：把 argv 重排成 [electron, script, '--electron', ...args] 再 require
const BOOTSTRAP =
  "const e=process.argv[1],a=process.argv.slice(2).filter(function(x){return x!=='--electron'});if(!process.env.cwd)process.env.cwd=process.cwd();process.argv=[process.execPath,e,'--electron'].concat(a);require(e)";
const PROJECT = process.env.MP_PROJECT || "C:/Users/94439/WeChatProjects/miniprogram-1";
const API = process.env.SAMPLE_ACCEPTANCE_API || "http://127.0.0.1:8010";
const ACCOUNTS_FILE = path.join(process.env.TEMP || "", "samplebox-acceptance-20261119", "accounts.local.json");

const argv = process.argv.slice(2);
const cmd = argv[0] || "status";
const rest = argv.slice(1);
const hasFlag = (name) => rest.includes(`--${name}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 官方 CLI 通道：数组传参，避开 shell 转义；cwd 必须是工具目录，env 带 ELECTRON_RUN_AS_NODE */
function cli(tool, args = []) {
  try {
    const out = execFileSync(EXE, ["-e", BOOTSTRAP, CLI, "-c", "Qwen", tool, "--project", PROJECT, ...args], {
      encoding: "utf8",
      timeout: 180000,
      cwd: DIR,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    const start = out.indexOf("{");
    return start >= 0 ? out.slice(start) : out;
  } catch (error) {
    // 失败也要把服务端原文带出来，别再写成「环境阻塞」这种没信息量的结论
    return JSON.stringify({
      success: false,
      tool,
      stdout: String(error.stdout || "").slice(0, 800),
      stderr: String(error.stderr || "").slice(0, 800),
      status: error.status ?? null,
      message: String(error.message || "").split("\n")[0],
    });
  }
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: String(text).slice(0, 800) };
  }
}

function unwrap(json) {
  const r = json?.result;
  return r?.result?.result ?? r?.result ?? r?.returnValue ?? r ?? json;
}

const ev = (fnSource) => parse(cli("automation_evaluate", ["--fn-source", fnSource]));

/** 当前栈顶页面路由，用来确认跳转真的到了 */
async function route() {
  const v = unwrap(
    ev("function(){var p=getCurrentPages();return p.length?p[p.length-1].route:'none';}")
  );
  return String(v ?? "none");
}

/** 模拟器截图，落到我的验收目录 */
function shot(name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${String(name).replace(/[\\/:*?"<>|\s]/g, "-")}.png`);
  const json = parse(cli("simulator_screenshot", ["--path", file, "--optimize", "false"]));
  return { file, exists: fs.existsSync(file), bytes: fs.existsSync(file) ? fs.statSync(file).size : 0, json };
}

/** 先 refresh 再 reLaunch（先例第 36 行的原因：同运行时跨页复用 canvas 2d 节点会画到已销毁节点上） */
async function openPage(page, query, expect, { refresh = true, patch = false } = {}) {
  if (refresh) {
    cli("simulator_refresh", []);
    await sleep(7000);
  }
  // 补丁必须在 refresh 之后打：refresh 会重建 app-service 运行时，先打就被冲掉，页面又回去打 8000
  const patchResult = patch ? unwrap(rerouteToIsolation()) : null;
  const url = `/${page}${query ? `?${query}` : ""}`;
  ev(`function(){wx.reLaunch({url:'${url}'});return 1;}`);
  await sleep(5000);
  const got = await route();
  return { url, expect, got, reached: got.includes(expect), patch: patchResult };
}

/**
 * 内存级改道：把 wx.request 的 url 前缀从主实例 8000 换成隔离实例 8010。
 * 只在当前运行时有效，`simulator_refresh` 后失效，需要重新打；不落盘、不改小程序源码。
 */
function rerouteToIsolation() {
  const js = `function(){
    if (wx.__acceptanceRerouted) return 'already';
    var orig = wx.request;
    wx.__acceptanceRerouted = true;
    wx.request = function(o){
      try {
        if (o && typeof o.url === 'string' && /localhost:8000|127\\.0\\.0\\.1:8000/.test(o.url)) {
          o = Object.assign({}, o, { url: o.url.replace(/(localhost|127\\.0\\.0\\.1):8000/, '127.0.0.1:8010') });
        }
      } catch (e) { return orig(o); }
      return orig(o);
    };
    return 'patched';
  }`;
  return ev(js);
}

/** 角色键 → 隔离实例登录名（口令见 fixtures.md §0 的私有文件，不进任何交付文件） */
const ROLE_USERS = {
  admin: "admin",
  asset: "zhou.ning",
  verify: "wu.di",
  dispatch: "chen.ke",
  sampler: "lin.xia",
  duty: "accept.duty",
  agency: "accept.agency",
  branch: "accept.branch",
  leader: "accept.leader",
};

/** 隔离实例的登录令牌（口令只从 TEMP 的私有夹具文件读，绝不写进交付文件） */
async function isolationToken(roleKey) {
  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
  const users = ROLE_USERS;
  const res = await fetch(`${API}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: users[roleKey], password: accounts[roleKey], captchaId: "", captchaCode: "1234" }),
  });
  const body = await res.json();
  if (body.code !== "00000") throw new Error(`隔离实例登录失败：${body.code} ${body.msg}`);
  return body.data;
}

async function main() {
  if (cmd === "status") {
    const json = parse(cli("check_wechatide_status"));
    const r = json?.result || json;
    console.log(JSON.stringify({ success: r?.success, loginUser: r?.loginUser?.nickName, skillVersion: r?.skillVersion, skillPath: r?.skillPath, tokenRequired: r?.tokenRequired }, null, 2));
    console.log("原始返回：", JSON.stringify(json).slice(0, 400));
    return 0;
  }

  if (cmd === "tools") {
    const out = cli("help", []);
    console.log(String(out).slice(0, 4000));
    return 0;
  }

  if (cmd === "shot") {
    const name = rest[0] || `simulator-${new Date().toISOString().replace(/[:.]/g, "")}`;
    const r = shot(name);
    console.log(JSON.stringify(r, null, 2));
    return r.exists ? 0 : 1;
  }

  if (cmd === "open") {
    const page = rest[0];
    const query = rest.slice(1).filter((a) => !a.startsWith("--")).join("&");
    if (!page) {
      console.error("用法：node tools/acceptance-mp.mjs open <pages/xxx/xxx> [k=v ...] [--name 截图名] [--no-refresh] [--reroute]");
      return 1;
    }
    const expect = page.split("/").pop();
    const jumped = await openPage(page, query, expect, {
      refresh: !hasFlag("no-refresh"),
      patch: hasFlag("reroute"),
    });
    console.log("跳转：", JSON.stringify(jumped));
    if (!jumped.reached) return 1;
    const name = (rest.find((a) => a.startsWith("--name")) || "").split("=")[1] || rest[rest.length - 1];
    const r = shot(name && !name.startsWith("--") ? name : expect);
    console.log("截图：", JSON.stringify(r, null, 2));
    return r.exists ? 0 : 1;
  }

  if (cmd === "use-role") {
    /**
     * 用小程序自己的登录链路把模拟器接到隔离实例 8010：
     * ① POST /api/v1/auth/wechat/bind（隔离实例带 SAMPLE_WECHAT_FAKE_OPENID，任何 code 都算同一个 openid）
     * ② 清掉本机旧令牌 —— 不往内存塞 token，页面下一次 ensureLogin 会走它自己的 silentLogin 拿到 8010 的 token
     * ③ 打上 wx.request 改道补丁（8000 → 8010），只在当前运行时有效，refresh / 重新编译会丢
     * 好处：不碰小程序源码，也能证明「真实登录 + 真实接口」这条路径通。
     */
    const roleKey = rest[0] || "admin";
    const username = ROLE_USERS[roleKey];
    if (!username) {
      console.error(`未知角色键 ${roleKey}（可用：${Object.keys(ROLE_USERS).join(" / ")}）`);
      return 1;
    }
    const password = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"))[roleKey];
    const bindRes = await fetch(`${API}/api/v1/auth/wechat/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "acceptance-cli-code", username, password }),
    });
    const bindBody = await bindRes.json().catch(() => null);
    const bound = bindBody?.data?.bound === true;
    const me = bound
      ? await (
          await fetch(`${API}/api/v1/users/me`, {
            headers: { Authorization: `Bearer ${bindBody.data.accessToken}` },
          })
        ).json().catch(() => null)
      : null;
    const cleared = ev(
      `function(){wx.removeStorageSync('sample.tokens');${bound && me?.data?.id ? `wx.setStorageSync('sample.account',${JSON.stringify(String(me.data.id))});` : ""}return String(wx.getStorageSync('sample.account')||'')||'(empty)';}`
    );
    const patched = rerouteToIsolation();
    const flag = ev("function(){return wx.__acceptanceRerouted===true?'patched':'MISSING';}");
    console.log(
      JSON.stringify(
        {
          roleKey,
          username,
          api: API,
          bind: { http: bindRes.status, code: bindBody?.code, msg: bindBody?.msg, bound },
          who: me?.data ? { id: me.data.id, nickname: me.data.nickname, permN: (me.data.permissions || []).length } : null,
          accountKey: unwrap(cleared),
          reroute: unwrap(patched),
          rerouteFlag: unwrap(flag),
        },
        null,
        2
      )
    );
    console.log("下一步：node tools/acceptance-mp.mjs open pages/boxes/boxes --no-refresh --reroute --name=mini-boxes-8010");
    console.log("注意：refresh / 重新编译会丢掉这层 wx.request 包装，丢掉后页面又去打 8000（无服务）→ 再跑一次 use-role 或 open --reroute。");
    return bound ? 0 : 1;
  }

  if (cmd === "reroute") {
    console.log(JSON.stringify(rerouteToIsolation(), null, 2));
    console.log("提示：改道只在当前运行时有效，refresh 后要重打；打完再 open --no-refresh 才不会丢。");
    return 0;
  }

  if (cmd === "eval") {
    console.log(JSON.stringify(ev(rest[0]), null, 2));
    return 0;
  }

  if (cmd === "api") {
    // 小程序接口口径核对：直接打隔离实例，不经过模拟器，用来在通道之外也能验数据契约
    const p = rest[0] || "/api/v1/sample/boxes";
    const roleKey = rest[1] || "admin";
    const token = await isolationToken(roleKey);
    const res = await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${token.accessToken}` } });
    const body = await res.json().catch(() => null);
    console.log(JSON.stringify({ roleKey, path: p, http: res.status, code: body?.code, keys: body?.data ? Object.keys(body.data) : null, sample: JSON.stringify(body?.data).slice(0, 500) }, null, 2));
    return 0;
  }

  console.error(`未知子命令 ${cmd}（可用：status / tools / shot / open / reroute / eval / api）`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[acceptance-mp] ${error.message}`);
    process.exit(1);
  });
