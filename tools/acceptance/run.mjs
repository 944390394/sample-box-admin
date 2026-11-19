/**
 * 验收机器人：pnpm accept
 *
 * 在临时目录建一套全新的库和测试数据，用临时端口起服务端和网页，
 * 再用本机 Edge 按角色登录，逐页检查并截图，最后生成 reports/acceptance/latest/index.html。
 * 有检查没通过时以非零退出。不碰开发库，也不连线上。
 *
 * 参数：
 *   --headed       显示浏览器窗口
 *   --only=关键字  只跑名称里带这个关键字的检查
 *   --keep         跑完不删临时目录（排查用）
 *   --seed-only    只做到「数据准备 + 接口层核对」，不启动浏览器矩阵
 *                  （源码在改、页面矩阵由人重跑时用这条；证据落 reports/acceptance/latest/seed-report.json）
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { CHECKS } from "./checks.mjs";
import { writeReport } from "./report.mjs";
import { verifySeed } from "./seed-verify.mjs";
import { ACCOUNTS, createTasks, prepareHome, sendInspectOpens, sendLiveUplinks } from "./seed.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Set(process.argv.slice(2));
const only = [...args].find((a) => a.startsWith("--only="))?.slice(7) || "";
const headed = args.has("--headed");
const keep = args.has("--keep");
const seedOnly = args.has("--seed-only");

const PORTS = { api: 8100, tcp: 9100, web: 3200 };
const WEB = `http://localhost:${PORTS.web}`;
const API = `http://localhost:${PORTS.api}`;
const outDir = path.join(root, "reports", "acceptance", "latest");
const home = path.join(os.tmpdir(), `sample-accept-${Date.now()}`);
const children = [];

function log(text) {
  process.stdout.write(`[验收] ${text}\n`);
}

function start(name, command, argv, env) {
  const child = spawn(command, argv, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const lines = [];
  const keepLine = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) lines.push(line);
    if (lines.length > 200) lines.splice(0, lines.length - 200);
  };
  child.stdout.on("data", keepLine);
  child.stderr.on("data", keepLine);
  children.push({ name, child, lines });
  return child;
}

async function waitFor(url, label, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label}没有在 ${timeoutMs / 1000} 秒内起来`);
}

/** 只在机器人进程里用的接口客户端：登录拿令牌，令牌不打印、不落盘。 */
async function apiClient(username, password) {
  const res = await fetch(`${API}/api/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password, captchaId: "", captchaCode: "0000" }) });
  const body = await res.json();
  if (body.code !== "00000") throw new Error(`接口登录失败：${body.msg}`);
  const token = body.data.accessToken;
  const call = async (method, url, data) => {
    const r = await fetch(`${API}${url}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: data ? JSON.stringify(data) : undefined });
    const json = await r.json();
    if (json.code !== "00000") {
      // 把业务码挂在错误上，建单环节才能把「A0400 签收人必须是…」原样记进证据
      const error = new Error(`${method} ${url}：${json.msg || `HTTP ${r.status}`}`);
      error.code = json.code || `HTTP ${r.status}`;
      throw error;
    }
    return json.data;
  };
  return { get: (url) => call("GET", url), post: (url, data) => call("POST", url, data), put: (url, data) => call("PUT", url, data) };
}

/** 在登录页上像人一样登录。验证码在这套临时环境里不校验，随便填。 */
async function login(page, username, password) {
  await page.goto(`${WEB}/#/login`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("用户名").fill(username);
  await page.getByPlaceholder("密码").fill(password);
  await page.getByPlaceholder("验证码").fill("0000");
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await page.waitForURL((url) => !url.hash.startsWith("#/login"), { timeout: 30000 });
}

/** 打开一页，等接口都回来、页面稳定。 */
async function open(page, route) {
  await page.goto(`${WEB}/#${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  // 切页有淡入动画，等动画放完再查、再截图
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
}

async function shutdown() {
  for (const { child } of children) {
    try {
      child.kill();
    } catch {
      /* 已经退出 */
    }
  }
  if (!keep) await rm(home, { recursive: true, force: true }).catch(() => {});
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  log(`临时环境 ${home}`);
  const passwords = await prepareHome(home);

  start("服务端", process.execPath, ["server/index.js"], { SAMPLE_HOME: home, SAMPLE_ACCEPTANCE: "1", PORT: String(PORTS.api), SAMPLE_TCP_PORT: String(PORTS.tcp), SYSTEM_LOG_PATH: path.join(home, "system-logs.sqlite") });
  const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
  if (!seedOnly) {
    // --seed-only 不开浏览器，也就不必占 3200 起 vite
    if (!existsSync(vite)) throw new Error("没找到 vite，先 pnpm install");
    start("网页", process.execPath, [vite, "--port", String(PORTS.web), "--strictPort"], { VITE_APP_API_URL: API, VITE_APP_PORT: String(PORTS.web), BROWSER: "none" });
    await waitFor(WEB, "网页");
  }
  await waitFor(`${API}/api/v1/auth/captcha`, "服务端");
  log(seedOnly ? "服务端已起来（--seed-only：不起网页、不开浏览器矩阵）" : "服务端和网页已起来");

  await sendLiveUplinks(PORTS.tcp);
  const admin = await apiClient(ACCOUNTS.admin.username, passwords.admin);
  // 建单逐张容错：一张失败不再打断整个数据准备，失败原因进证据
  const tasks = await createTasks(admin);
  await sendInspectOpens(PORTS.tcp);
  const prepFailures = [...(tasks.failures || [])];
  const prepSkipped = [...(tasks.skipped || [])];
  const step = async (label, fn) => {
    if (!tasks.inspect) {
      prepSkipped.push({ label, reason: "送检单没建出来，跳过签收推进" });
      return;
    }
    try {
      await fn();
    } catch (error) {
      prepFailures.push({ label, stage: "签收推进", code: error.code || "", reason: error.message });
    }
  };
  // B 开箱超限、两台箱盖开着：签收核验有异常，只能强制签收
  await step("送检单 → 待签收", () => admin.put(`/api/v1/sample/tasks/${tasks.inspect}/status`, { status: "待签收", note: "" }));
  await step("送检单 → 强制签收", () => admin.put(`/api/v1/sample/tasks/${tasks.inspect}/status`, { status: "强制签收", note: "验收：B 开箱超限，现场确认样品完好" }));

  const seedReport = {
    generatedAt: new Date().toISOString(),
    ports: PORTS,
    home,
    api: API,
    taskIds: { transfer: tasks.transfer, sample: tasks.sample, inspect: tasks.inspect, back: tasks.back },
    created: tasks.seeded,
    createdCount: tasks.seeded.length,
    failures: prepFailures,
    failureCount: prepFailures.length,
    skipped: prepSkipped,
  };
  log(`数据准备：建单成功 ${seedReport.createdCount} 张 / 失败 ${seedReport.failureCount} 张 / 跳过 ${prepSkipped.length} 步`);
  for (const item of tasks.seeded) log(`  ✓ ${item.label}（id ${item.id}）`);
  for (const f of prepFailures) log(`  ✗ ${f.label || f.key}${f.stage ? ` · ${f.stage}` : ""}：${f.code || ""} ${f.reason}`);
  for (const s of prepSkipped) log(`  – ${s.label || s.key}：${s.reason}`);

  if (seedOnly) {
    // 不启动浏览器矩阵（页面在改），只做接口层核对：每张单拉详情、箱子列表、签收人身份
    const verify = await verifySeed(admin, tasks, { log });
    seedReport.verify = verify;
    seedReport.verifySummary = verify.summary;
    const problems = verify.checks.filter((c) => !c.ok);
    await writeFile(path.join(outDir, "seed-report.json"), JSON.stringify(seedReport, null, 2), "utf8");
    log(`接口层核对：${verify.checks.length - problems.length}/${verify.checks.length} 通过`);
    for (const c of verify.checks) log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `（${c.detail}）` : ""}`);
    log(`证据：${path.join(outDir, "seed-report.json")}`);
    return seedReport.failureCount || problems.length ? 1 : 0;
  }

  log("测试数据已就绪");

  const browser = await chromium.launch({ channel: "msedge", headless: !headed });
  const results = [];
  const selected = CHECKS.filter((check) => !only || check.name.includes(only));
  const byRole = new Map();
  for (const check of selected) {
    if (!byRole.has(check.role)) byRole.set(check.role, []);
    byRole.get(check.role).push(check);
  }

  try {
    for (const [role, checks] of byRole) {
      const account = ACCOUNTS[role];
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", deviceScaleFactor: 1 });
      const page = await context.newPage();
      const problems = [];
      // 天地图外部脚本偶尔加载不完整会抛错，和我们的代码无关；其余脚本报错都算没通过
      page.on("pageerror", (error) => {
        if (/tianditu/i.test(error.stack || "")) return;
        problems.push(`脚本报错：${error.message}`);
      });
      page.on("console", (msg) => {
        if (msg.type() === "error" && !/tianditu|tile|favicon|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_|ERR_TIMED_OUT/i.test(msg.text())) problems.push(`控制台错误：${msg.text().slice(0, 300)}`);
      });
      page.on("response", (res) => {
        if (res.url().startsWith(WEB) && res.status() >= 500) problems.push(`接口 ${res.status()}：${res.url().replace(WEB, "")}`);
      });

      try {
        await login(page, account.username, passwords[role]);
      } catch (error) {
        for (const check of checks) results.push({ name: check.name, role: account.label, ok: false, notes: [`登录失败：${error.message}`], shots: [] });
        await context.close();
        continue;
      }

      for (const check of checks) {
        problems.length = 0;
        const notes = [];
        const shots = [];
        let ok = true;
        const expect = (condition, text) => {
          if (!condition) {
            ok = false;
            notes.push(`✗ ${text}`);
          } else notes.push(`✓ ${text}`);
        };
        const shot = async (label, opts = {}) => {
          const file = `${String(results.length + 1).padStart(2, "0")}-${shots.length + 1}.png`;
          await page.screenshot({ path: path.join(outDir, file), fullPage: opts.fullPage ?? true });
          shots.push({ file, label });
        };
        const ctx = {
          page,
          tasks,
          // 管理员接口客户端：核对页面背后的数据
          api: admin,
          // 假设备再报一轮，让「最近上报」回到几秒前
          sendUplinks: () => sendLiveUplinks(PORTS.tcp),
          open: (route) => open(page, route),
          expect,
          shot,
          text: async (selector = "body") => (await page.locator(selector).first().innerText().catch(() => "")) || "",
          noHorizontalScroll: async (label) => {
            const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            expect(over <= 1, `${label}没有横向滚动${over > 1 ? `（多出 ${over}px）` : ""}`);
          },
          mobile: async (fn) => {
            await page.setViewportSize({ width: 390, height: 844 });
            try {
              await page.waitForTimeout(400);
              await fn();
            } finally {
              await page.setViewportSize({ width: 1440, height: 900 });
              await page.waitForTimeout(200);
            }
          },
        };
        try {
          await check.run(ctx);
        } catch (error) {
          ok = false;
          notes.push(`✗ 执行出错：${error.message.split("\n")[0]}`);
          await shot("出错时的页面").catch(() => {});
        }
        for (const problem of [...new Set(problems)]) {
          ok = false;
          notes.push(`✗ ${problem}`);
        }
        results.push({ name: check.name, role: account.label, ok, notes, shots });
        log(`${ok ? "通过" : "没通过"}  ${account.label} · ${check.name}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  // 数据准备本身也是一条证据：完整跑（带浏览器矩阵）时同样进报告，截图编号不受影响
  await writeFile(path.join(outDir, "seed-report.json"), JSON.stringify(seedReport, null, 2), "utf8");
  results.push({
    name: "数据准备：接口建单（逐张容错）",
    role: ACCOUNTS.admin.label,
    ok: seedReport.failureCount === 0,
    notes: [
      ...tasks.seeded.map((item) => `✓ 建单 ${item.label}（id ${item.id}）`),
      ...prepFailures.map((f) => `✗ ${f.label || f.key}${f.stage ? ` · ${f.stage}` : ""}：${f.code || ""} ${f.reason}`),
      ...prepSkipped.map((s) => `– ${s.label || s.key}：${s.reason}`),
    ],
    shots: [],
  });

  const failed = results.filter((r) => !r.ok);
  const serverTail = children.find((c) => c.name === "服务端")?.lines.slice(-30) || [];
  await writeReport(outDir, results, { serverTail });
  log(`${results.length} 项检查，${results.length - failed.length} 项通过，${failed.length} 项没通过`);
  log(`报告：${path.join(outDir, "index.html")}`);
  return failed.length ? 1 : 0;
}

main()
  .then(async (code) => {
    await shutdown();
    process.exit(code);
  })
  .catch(async (error) => {
    process.stderr.write(`[验收] 跑不下去：${error.stack || error.message}\n`);
    for (const { name, lines } of children) process.stderr.write(`--- ${name} 最后输出 ---\n${lines.slice(-20).join("\n")}\n`);
    await shutdown();
    process.exit(2);
  });
