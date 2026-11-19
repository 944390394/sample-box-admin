#!/usr/bin/env node
/**
 * 验收浏览器层实测（任务 #12 交付物 5 的可复跑载体）
 *
 * 干什么：用真实浏览器登录隔离实例，跑 checklist.md 里标「本轮浏览器实测」的那几项，
 *         把 DOM 实测值和截图落到 reports/acceptance/20261119/ 下。
 * 连的是：dev server http://127.0.0.1:3000（vite，--strictPort）→ /dev-api 代理 → 隔离后端 127.0.0.1:8010。
 *         3000 没起就自己拉一个（只带 VITE_APP_API_URL=…:8010 的进程 env，不改 .env.development），
 *         跑完只停自己拉的那个 PID；已有 3000 在听就直接复用、不碰。
 * 绝不碰：8000/9000（主实例）、8002/9002/9001（演示）、5173（兄弟项目）、3001（PM 预览）、8100/9100/3200（#4）。
 *
 * 用法：
 *   node tools/acceptance-ui.mjs                       # 全跑（F-1/F-2、D-2、D-4、J-2、J-3、C-export、console）
 *   node tools/acceptance-ui.mjs --only J-3            # 只跑某几项（逗号分隔，子串匹配 id）
 *   node tools/acceptance-ui.mjs --out foo.json        # 换证据文件名（默认 evidence-dom-rerun.json）
 *   node tools/acceptance-ui.mjs --no-serve            # 3000 没起就报错，不自作主张拉 dev server
 *
 * 浏览器通道：本机没装 Chrome（chrome-devtools MCP 会报 Could not find Google Chrome executable），
 *   所以沿用本仓库既有做法 playwright-core + channel:"msedge" + headless。要换 Chrome 就加 --channel chrome。
 *
 * 多角色口径：**每个角色新建 context**（第一轮复用同一 context 换账号出现过身份不刷新 + 未捕获 TypeError，
 *   证据不可归因，见 checklist.md M-3）。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "reports", "acceptance", "20261119");
const SHOT_DIR = path.join(OUT_DIR, "shots", "rerun");
const ACCOUNTS_FILE = path.join(os.tmpdir(), "samplebox-acceptance-20261119", "accounts.local.json");

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const ONLY = (argOf("only", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OUT_FILE = path.join(OUT_DIR, argOf("out", "evidence-dom-rerun.json"));
const CHANNEL = argOf("channel", "msedge");
const NO_SERVE = args.includes("--no-serve");

const DEV_PORT = Number(process.env.VITE_APP_PORT || 3000);
const DEV = `http://127.0.0.1:${DEV_PORT}`;
const API = process.env.SAMPLE_ACCEPTANCE_API || "http://127.0.0.1:8010";
const FORBIDDEN_PORTS = [8000, 9000, 8002, 9002, 9001, 5173, 3001, 8100, 9100, 3200, 8123, 8124, 9123, 9124];

// 角色键 → 登录名（口令从 TEMP 的夹具文件读，不落进这个仓库文件）
const USERS = {
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

const log = (...a) => console.log(...a);
const die = (m) => {
  console.error(`\n[acceptance-ui] ${m}`);
  process.exit(1);
};
const wanted = (id) => !ONLY.length || ONLY.some((k) => id.toUpperCase().includes(k.toUpperCase()));

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    die(`夹具账号文件不存在：${ACCOUNTS_FILE}\n  先跑 node tools/acceptance-setup.mjs up --fresh`);
  }
  return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs || 15000) });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { http: res.status, body };
}

/** 只读端口归属：确认 3000 上的监听者是谁，禁碰端口一律不动 */
function listenersFor(ports) {
  const out = {};
  try {
    const { execSync } = createRequire(import.meta.url)("node:child_process");
    const raw = execSync("netstat -ano -p tcp", { encoding: "utf8", windowsHide: true });
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (m && ports.includes(Number(m[2]))) out[m[2]] = { address: m[1], listenerPid: m[3] };
    }
  } catch (e) {
    out.error = String(e.message || e);
  }
  return out;
}

async function waitHealth(base, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetchJson(`${base}/dev-api/api/v1/auth/captcha`, { timeoutMs: 4000 });
      if (r.body?.code === "00000") return r.body;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

/** 隔离后端必须先活着（8010），否则浏览器一切断言都无意义 */
async function assertApi() {
  const r = await fetchJson(`${API}/api/v1/auth/captcha`);
  if (r.body?.code !== "00000") {
    die(`隔离后端 ${API} 不健康（拿到 ${JSON.stringify(r.body?.code ?? r.http)}）。先 node tools/acceptance-setup.mjs status / up --fresh`);
  }
  return r.body;
}

let spawnedVite = null;
async function ensureDev() {
  const l = listenersFor([DEV_PORT]);
  if (l[DEV_PORT]) {
    const h = await waitHealth(DEV, 8000);
    if (h) {
      log(`· 复用已在监听 ${DEV_PORT} 的 dev server（PID ${l[DEV_PORT].listenerPid}），代理指向正确`);
      return { reused: true, pid: Number(l[DEV_PORT].listenerPid) };
    }
    die(`${DEV_PORT} 被占用但 /dev-api 代理没指向 ${API}。这是别人起的 dev server，我不停它——请腾出口子或加 --out 换端口口径`);
  }
  if (NO_SERVE) die(`${DEV_PORT} 没有监听，且带了 --no-serve，不自作主张起服务`);
  log(`· ${DEV_PORT} 空闲，起一个隔离 dev server（env 覆盖 VITE_APP_API_URL=${API}，不改 .env.development）`);
  spawnedVite = spawn("pnpm", ["exec", "vite", "--port", String(DEV_PORT), "--strictPort"], {
    cwd: ROOT,
    shell: process.platform === "win32",
    env: { ...process.env, VITE_APP_PORT: String(DEV_PORT), VITE_APP_API_URL: API, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = { out: "", err: "" };
  spawnedVite.stdout.on("data", (b) => (tail.out += b.toString()));
  spawnedVite.stderr.on("data", (b) => (tail.err += b.toString()));
  spawnedVite.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      log(`  vite 退出码 ${code}：\n${(tail.out + tail.err).slice(-600)}`);
    }
  });
  const h = await waitHealth(DEV, 90000);
  if (!h) {
    die(`dev server 起不来（90s 内 ${DEV}/dev-api/api/v1/auth/captcha 没返回 00000）\n${(tail.out + tail.err).slice(-600)}`);
  }
  const pid = listenersFor([DEV_PORT])[DEV_PORT]?.listenerPid;
  log(`  ready，代理冒烟通过（PID ${pid ?? "?"} 监听 ${DEV_PORT}）`);
  return { reused: false, pid: Number(pid || 0) };
}

function stopOwnDev(dev) {
  if (dev.reused || !spawnedVite) {
    log(`· dev server 是我复用的，不停（3000 仍归 PID ${dev.pid}）`);
    return;
  }
  try {
    // 只杀自己 spawn 出来的那一支；禁碰端口一律不动
    spawnedVite.kill("SIGTERM");
    log(`· 已停自己起的 vite（PID ${dev.pid}）`);
  } catch (e) {
    log(`· 停 vite 失败，请手工核对 PID ${dev.pid}：${e.message}`);
  }
}

async function openBrowser() {
  const require = createRequire(import.meta.url);
  let pw;
  try {
    pw = require("playwright-core");
  } catch {
    die("缺 playwright-core（本仓库既有截图脚本用它）。pnpm add -D playwright-core 后再跑");
  }
  try {
    return await pw.chromium.launch({ channel: CHANNEL, headless: true });
  } catch (e) {
    die(`浏览器起不来（channel=${CHANNEL}）：${String(e.message).split("\n")[0]}\n  本机没 Chrome 就用默认 msedge，别临时换用户没指定的通道`);
  }
}

/** 真登录：用户名 / 密码 / 验证码；隔离实例带 SAMPLE_ACCEPTANCE=1，验证码任意 4 位过 */
async function login(context, creds, username, password) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  await page.goto(`${DEV}/#/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await page.locator('input[placeholder="用户名"]').fill(username);
  await page.locator('input[placeholder="密码"]').fill(password);
  await page.locator('input[placeholder="验证码"]').fill("1234");
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await page.waitForFunction(() => !location.hash.startsWith("#/login"), { timeout: 30000 });
  await page.waitForTimeout(1200);
  // 令牌键是 `${APP_PREFIX}:auth:access_token`；勾了「记住我」在 localStorage，没勾在 sessionStorage，
  // 且 Storage 统一做了 JSON.stringify，取出来带引号要反序列化一次。
  creds.token = await page.evaluate(() => {
    for (const store of [localStorage, sessionStorage]) {
      const k = Object.keys(store).find((x) => x.includes("access_token"));
      if (!k) continue;
      const raw = store[k];
      try {
        const parsed = JSON.parse(raw);
        return typeof parsed === "string" ? parsed : String(parsed);
      } catch {
        return String(raw).replace(/^"|"$/g, "");
      }
    }
    return "";
  });
  if (!creds.token) throw new Error(`登录后没拿到令牌（${username}）`);
  return { page, errors };
}

const rowsOf = (page) => page.locator(".el-table__body tbody tr.el-table__row").count();
const bodyText = (page, sel) => page.locator(sel).first().innerText({ timeout: 8000 }).catch(() => "");

async function goHash(page, hash) {
  await page.goto(`${DEV}/${hash}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
}

/** 谁的整串 IMEI 出现在列表里：这是 M-1 的判据，接口层断言测不出来 */
async function imeiScan(page) {
  const text = await page.evaluate(() => {
    const t = document.querySelector(".el-table__body") || document.body;
    return t.innerText;
  });
  return {
    fullImeiCountInBody: (text.match(/861\d{10}/g) || []).length,
    maskedCountInBody: (text.match(/\d{3}\*+\d{4}/g) || []).length,
    totalText: await page.evaluate(() => {
      // 分页条是本仓库自己的 DataPager，总数在 span.count 里（不是 .el-pagination__total）
      const t = Array.from(document.querySelectorAll("body *")).find(
        (n) => n.childElementCount === 0 && /^共\s*\d+\s*条$/.test((n.textContent || "").trim())
      );
      return t ? t.textContent.trim() : null;
    }),
    firstCol: (
      await page.evaluate(() =>
        Array.from(document.querySelectorAll(".el-table__body tbody tr.el-table__row .name-text"))
          .slice(0, 3)
          .map((n) => n.innerText.replace(/\n/g, "/"))
      )
    ).filter(Boolean),
  };
}

async function searchPaged(page, q) {
  await page.locator(".filter-bar input").first().fill(q);
  await page.waitForTimeout(1600);
  return rowsOf(page);
}

/* ---------------- 检查项 ---------------- */

async function checkF1(browser) {
  const id = "F-1/F-2";
  if (!wanted(id)) return null;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await login(ctx, {}, USERS.duty, ACCOUNTS.duty);
  await goHash(page, "#/monitor/home");
  const tiles = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".stat-tiles .tile")).map((t) => t.innerText.replace(/\n/g, ""))
  );
  const offline = tiles.find((t) => t.includes("离线")) || null;
  await page.locator(".stat-tiles .tile", { hasText: "离线" }).first().click();
  await page.waitForTimeout(2500);
  const scan = await imeiScan(page); // 顺带取「共 N 条」，卡数要和落地**总数**比，不是当页行数（页容量 20）
  const tileNumber = Number((offline || "").match(/\d+/)?.[0] ?? -1);
  const totalNumber = Number((scan.totalText || "").match(/\d+/)?.[0] ?? -1);
  const res = {
    id,
    role: "accept.duty",
    homeTiles: tiles,
    offlineTile: offline,
    tileNumber,
    afterClickHash: await page.evaluate(() => location.hash),
    landedTotalText: scan.totalText,
    landedTotal: totalNumber,
    tableRows: await rowsOf(page),
    pageSizeNote: "tableRows 是当页渲染行数（默认页容量 20），判等看 landedTotal",
    emptyBlocks: await page.locator(".el-table__empty-block").count(),
    errors,
  };
  res.verdict =
    res.afterClickHash.includes("tile=flag:offline") && tileNumber >= 0 && tileNumber === totalNumber ? "PASS" : "FAIL";
  res.sameSource = tileNumber === totalNumber;
  await page.screenshot({ path: path.join(SHOT_DIR, "F-1-duty-offline-landing.png"), fullPage: true });
  await ctx.close();
  return res;
}

async function checkPosition(browser, box, label, id) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await login(ctx, {}, USERS.admin, ACCOUNTS.admin);
  await goHash(page, `#/device/boxes/${box}?tab=info`);
  const ages = await page.locator('[data-test="location-ages"]').count();
  const res = {
    id,
    role: "admin",
    box,
    hasAgesBlock: ages > 0,
    locationAgesText: ages ? await bodyText(page, '[data-test="location-ages"]') : null,
    rowClasses: await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-test="location-ages"] [class*="ages__row"]')).map((n) => n.className)
    ),
    gpsStaleHintText: (await bodyText(page, '[data-test="gps-stale-hint"]')) || null,
    coordsRendered: await page.evaluate(() => (document.body.innerText.match(/\d{2,3}\.\d{4,}/g) || [])),
    noLocTextOccurrences: await page.evaluate(() => (document.body.innerText.match(/未定位/g) || [])),
    errors,
  };
  if (label === "stale") {
    const ages = /之后一直没定到卫星/.test(res.locationAgesText || "");
    const hint = /之后没定到卫星/.test(res.gpsStaleHintText || "");
    const off = res.rowClasses.some((c) => c.includes("is-off"));
    const live = res.rowClasses.some((c) => !c.includes("is-off"));
    res.asserts = { ages, hint, gpsRowGreyed: off, lbsRowNormal: live };
    res.verdict = ages && hint && off && live ? "PASS" : "FAIL";
  } else {
    res.asserts = { noAgesBlock: !res.hasAgesBlock, noCoords: res.coordsRendered.length === 0 };
    res.verdict = !res.hasAgesBlock && res.coordsRendered.length === 0 ? "PASS" : "FAIL";
  }
  await page.screenshot({ path: path.join(SHOT_DIR, `${id}-position-${label}.png`), fullPage: true });
  await ctx.close();
  return res;
}

async function checkImeiPerRole(browser, roleKey) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { page, errors } = await login(ctx, {}, USERS[roleKey], ACCOUNTS[roleKey]);
  await goHash(page, "#/device/boxes");
  await page.waitForTimeout(2500);
  const scan = await imeiScan(page);
  const placeholders = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".filter-bar input")).map((i) => i.placeholder)
  );
  const rowsWithFullImei = await searchPaged(page, "861199900000101");
  return {
    roleKey,
    login: USERS[roleKey],
    ...scan,
    filterPlaceholders: placeholders,
    searchWithFullImei: rowsWithFullImei,
    errors,
    page,
    ctx,
  };
}

async function checkJ2(browser) {
  if (!wanted("J-2")) return null;
  const a = await checkImeiPerRole(browser, "asset");
  a.verdict = a.fullImeiCountInBody > 0 && a.filterPlaceholders.some((p) => p.includes("IMEI")) ? "PASS" : "FAIL";
  await a.page.screenshot({ path: path.join(SHOT_DIR, "J-2-asset-full-imei.png"), fullPage: true });
  const { page, ctx, ...rest } = a;
  await ctx.close();
  return { id: "J-2", role: "zhou.ning（有 device:box:iccid/imsi/firmware）", ...rest };
}

async function checkJ3(browser) {
  if (!wanted("J-3")) return null;
  const parts = [];
  for (const roleKey of ["sampler", "duty"]) {
    const r = await checkImeiPerRole(browser, roleKey);
    r.verdict = r.fullImeiCountInBody === 0 && r.searchWithFullImei === 0 ? "PASS" : "FAIL";
    r.severity = r.verdict === "FAIL" ? "P1（无标识权限角色仍看到整串 IMEI → checklist M-1）" : null;
    await r.page.screenshot({ path: path.join(SHOT_DIR, `J-3-${roleKey}-imei-in-list.png`), fullPage: true });
    const { page, ctx, ...rest } = r;
    parts.push(rest);
    await ctx.close();
  }
  const fail = parts.filter((p) => p.verdict === "FAIL").map((p) => p.roleKey);
  return {
    id: "J-3-list",
    verdict: fail.length ? "FAIL" : "PASS",
    roles: parts,
    rootCause: fail.length
      ? "src/views/sample/boxes/index.vue:78-79 —— 首列 <b>{{ row.name || row.id }}</b> 与 <div class=\"text-muted mono\">{{ row.id }}</div> 直接渲染 row.id（id 就是整串 IMEI），服务端只打码 imei 字段"
      : null,
  };
}

async function checkExport(browser) {
  if (!wanted("C-export")) return null;
  const out = { id: "C-export", roles: {} };
  for (const roleKey of ["sampler", "admin"]) {
    const creds = {};
    const ctx = await browser.newContext();
    await login(ctx, creds, USERS[roleKey], ACCOUNTS[roleKey]);
    const res = await fetch(`${DEV}/dev-api/api/v1/sample/boxes/export`, {
      headers: { Authorization: `Bearer ${creds.token}` },
    });
    if (res.status !== 200) {
      out.roles[roleKey] = { http: res.status, body: await res.json().catch(() => null) };
    } else {
      const t = await res.text();
      out.roles[roleKey] = {
        http: 200,
        bytes: t.length,
        header: t.split("\n")[0],
        fullImeiRows: (t.match(/861\d{10}/g) || []).length,
      };
    }
    await ctx.close();
  }
  out.verdict = out.roles.sampler?.http === 403 && out.roles.admin?.http === 200 ? "PASS" : "CHECK";
  return out;
}

/* ---------------- 主流程 ---------------- */

const ACCOUNTS = loadAccounts();
fs.mkdirSync(SHOT_DIR, { recursive: true });

log(`验收浏览器实测 · ${new Date().toISOString()}`);
log(`  API=${API}  DEV=${DEV}  channel=${CHANNEL}`);
const apiCaptcha = await assertApi();
log(`  隔离后端健康：code ${apiCaptcha.code}`);
const dev = await ensureDev();
const browser = await openBrowser();

const started = Date.now();
const results = [];
try {
  results.push(await checkF1(browser));
  results.push(wanted("D-2") ? await checkPosition(browser, "861199900000102", "stale", "D-2") : null);
  results.push(wanted("D-4") ? await checkPosition(browser, "861199900000104", "never", "D-4") : null);
  results.push(await checkJ2(browser));
  results.push(await checkJ3(browser));
  results.push(await checkExport(browser));
} catch (e) {
  results.push({ id: "ABORT", error: String(e.message || e).split("\n")[0] });
} finally {
  await browser.close();
  stopOwnDev(dev);
}

const clean = results.filter(Boolean);
const payload = {
  generatedAt: new Date().toISOString(),
  how: `playwright-core channel=${CHANNEL} headless；dev ${DEV}（${dev.reused ? "复用" : "本脚本自起并已停"}，PID ${dev.pid}）→ 代理 → ${API}`,
  forbiddenPortsUntouched: FORBIDDEN_PORTS,
  results: clean,
  summary: {
    total: clean.length,
    pass: clean.filter((r) => r.verdict === "PASS").length,
    fail: clean.filter((r) => r.verdict === "FAIL").length,
    other: clean.filter((r) => r.verdict !== "PASS" && r.verdict !== "FAIL").length,
    durationMs: Date.now() - started,
  },
  shotsDir: path.relative(ROOT, SHOT_DIR).replace(/\\/g, "/"),
};
fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), "utf8");
log(`\n写入 ${path.relative(ROOT, OUT_FILE)}：${payload.summary.pass} PASS / ${payload.summary.fail} FAIL（共 ${payload.summary.total} 项，${payload.summary.durationMs}ms）`);
for (const r of clean) log(`  ${String(r.verdict || r.error || "?").padEnd(7)} ${r.id}`);
process.exit(clean.some((r) => r.verdict === "FAIL" || !r.verdict || r.verdict === "CHECK") ? 2 : 0);
