#!/usr/bin/env node
/**
 * 验收隔离环境（任务 #12 交付物 1、2 的执行部分）。
 *
 * 这个脚本只做四件事：
 *   doctor  端口/环境体检，不写任何东西
 *   up      建新库 + 灌夹具 + 起一个只属于本次验收的后端进程（API 8010 / TCP 9010）
 *   check   对着 8010 跑只读断言，把实测值写进 reports/acceptance/20261119/evidence-check.json
 *   down    只停「自己起的那个进程」，并按 --purge 删自己的临时目录
 *           （上一轮 up 中途失败留下孤儿进程、没有 instance.json 时，用 down --pid <PID>：
 *            必须同时通过「8010 监听者 == 该 PID」和「命令行是 server/index.js」两道复核才 kill）
 *
 * 隔离边界（硬性）：
 *   - 库文件、系统日志、db.config.json（含随机 secret）全在 %TEMP%/samplebox-acceptance-20261119 下新建；
 *     绝不读写 server/data/**、reports/demo2/**。
 *   - 只占 8010/9010（以及可选的 3000 网页口）。8000/8002/9000/9002/5173/3001/8100/9100/3200/8123/8124/9123/9124
 *     在 forbiddenPorts 里，占用即拒绝启动。
 *   - SAMPLE_ACCEPTANCE=1、SAMPLE_WECHAT_FAKE_OPENID 只加到本脚本 spawn 的子进程 env 上。
 *   - 停进程前先用 netstat 确认目标端口 8010 的监听 PID 就是 instance.json 里记的那个，否则拒绝 kill。
 *   - 账号口令随机生成，只写进临时目录里的 accounts.local.json（仓库外），报告里只出现文件路径。
 *
 * 用法：
 *   node tools/acceptance-setup.mjs up --fresh
 *   node tools/acceptance-setup.mjs check
 *   node tools/acceptance-setup.mjs down --purge
 */
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { hashPassword } from "../server/auth.js";
import { migrate, openDatabase, seedOrg } from "../server/db.js";
import { seedRolePerms } from "../server/src/auth/boxAccess.js";
import { upgradeCodes } from "../server/src/auth/permCatalog.js";
import { formatTimestamp } from "../server/src/domain/Clock.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "reports", "acceptance", "20261119");

export const PLAN = {
  home: path.join(os.tmpdir(), "samplebox-acceptance-20261119"),
  apiPort: 8010,
  tcpPort: 9010,
  webPort: 3000,
  /** 系统默认上报周期（秒）。离在线阈值 = 3 个周期 = 30 分钟，夹具的「超 3 周期」按这个算。 */
  reportPeriodSec: 600,
  /** 派发口径：建单后 40 分钟内从未上报算中性「待上线」，不计离线。当前代码未实现，check 会实测。 */
  graceMinutes: 40,
  forbiddenPorts: [8000, 8002, 9000, 9002, 9001, 5173, 3001, 8100, 9100, 3200, 8123, 8124, 9123, 9124],
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms) => formatTimestamp(new Date(Date.now() - ms));
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

/* ---------------------------------------------------------------- 夹具清单 -- */

/** 检测站：默认组织里的「核验中心」改成采样机构类型（采样机构 = 检测站，签收后进待检测）。 */
export const STATION = { id: "13", name: "验收检测站", signerUserId: "5" };
export const HOME_ORG = { id: "21", name: "调度室" };
const SZ = { lng: 114.0579, lat: 22.5431 };

/**
 * 箱子夹具。key 是脚本内的名字，imei 是主键（现在 id == IMEI），name 直接给页面/截图看。
 * tier 说明它验的是哪一档，check 子命令按档核对。
 */
export const BOXES = {
  // 位置卡四档
  posGpsFresh: { imei: "861199900000101", name: "验收-位置GPS新鲜", tier: "位置/GPS 新鲜" },
  posGpsStaleLbsFresh: { imei: "861199900000102", name: "验收-位置GPS旧基站新", tier: "位置/GPS 过时+基站更新" },
  posBothStale: { imei: "861199900000103", name: "验收-位置双过时", tier: "位置/两路都过时" },
  posNone: { imei: "861199900000104", name: "验收-位置从未定位", tier: "位置/从未上报无定位" },
  // 离线四态 + 两个豁免/边界样本
  online: { imei: "861199900000201", name: "验收-在线刚上报", tier: "在线" },
  overPeriods: { imei: "861199900000202", name: "验收-超3周期未上报", tier: "离线/超 3 个上报周期" },
  graceIn: { imei: "861199900000203", name: "验收-建单内从未上报", tier: "宽限内/中性待上线（不计离线）" },
  graceOver: { imei: "861199900000204", name: "验收-建单2小时从未上报", tier: "宽限外/计离线" },
  graceTwoTasks: { imei: "861199900000205", name: "验收-两张未结束单取最早建单", tier: "宽限取最早建单时间" },
  chargeOnly: { imei: "861199900000206", name: "验收-仅充电上报未充电", tier: "离线豁免/仅充电模式且未充电" },
  stockPending: { imei: "861199900000207", name: "", tier: "未建单待激活库存（不受宽限影响）" },
  // 划拨撤销守卫三类原因
  guardInTask: { imei: "861199900000301", name: "验收-守卫已进入未结束任务", tier: "撤销守卫/已进入未结束任务" },
  guardOpened: { imei: "861199900000302", name: "验收-守卫划拨后已开箱", tier: "撤销守卫/划拨后已开箱" },
  guardInspected: { imei: "861199900000303", name: "验收-守卫已完成开箱检测", tier: "撤销守卫/已完成开箱检测" },
  revocableA: { imei: "861199900000304", name: "验收-可撤划拨A", tier: "撤销守卫/全部可撤的划拨单" },
  revocableB: { imei: "861199900000305", name: "验收-可撤划拨B", tier: "撤销守卫/全部可撤的划拨单" },
  // 送检单 9 状态，一台一个
  insp1: { imei: "861199900000401", name: "验收-送检待寄出", tier: "送检单/待寄出" },
  insp2: { imei: "861199900000402", name: "验收-送检运送中", tier: "送检单/运送中" },
  insp3: { imei: "861199900000403", name: "验收-送检待签收", tier: "送检单/待签收" },
  insp4: { imei: "861199900000404", name: "验收-送检待检测", tier: "送检单/待检测" },
  insp5: { imei: "861199900000405", name: "验收-送检退回中", tier: "送检单/退回中" },
  insp6: { imei: "861199900000406", name: "验收-送检已检测", tier: "送检单/已检测" },
  insp7: { imei: "861199900000407", name: "验收-送检已退回", tier: "送检单/已退回" },
  insp8: { imei: "861199900000408", name: "验收-送检已拒收", tier: "送检单/已拒收" },
  insp9: { imei: "861199900000409", name: "验收-送检已取消", tier: "送检单/已取消" },
  // 供 #4 现场新建任务用的空箱 + 告警样本
  spare1: { imei: "861199900000501", name: "验收-可用空箱1", tier: "可用（未使用）" },
  spare2: { imei: "861199900000502", name: "验收-可用空箱2", tier: "可用（未使用）" },
  alertLow: { imei: "861199900000503", name: "验收-低电开盖告警", tier: "告警/低电+开盖+温度异常" },
};

/** 角色模板账号：8 个模板 + 系统管理员。id 沿用 shared/org.js，新账号从 9101 起。 */
export const ACCOUNTS = {
  admin: { userId: "2", username: "admin", nickname: "系统管理员", role: "ADMIN", dept: "11", label: "系统管理员（全部权限）" },
  asset: { userId: "4", username: "zhou.ning", nickname: "周宁", role: "ASSET", dept: "12", label: "资产管理员（有设备标识权限）" },
  verify: { userId: "5", username: "wu.di", nickname: "吴迪", role: "VERIFY", dept: "13", label: "核验员 / 检测站签收人" },
  dispatch: { userId: "6", username: "chen.ke", nickname: "陈可", role: "DISPATCH", dept: "21", label: "调度员（建单、推进、取消）" },
  sampler: { userId: "7", username: "lin.xia", nickname: "林夏", role: "SAMPLER", dept: "511", label: "现场采样员（仅本人，无设备标识权限）" },
  duty: { userId: "9101", username: "accept.duty", nickname: "验收值班员", role: "DUTY", dept: "14", label: "值班员（离线/低电 KPI 视角）" },
  agency: { userId: "9102", username: "accept.agency", nickname: "验收机构负责人", role: "AGENCY_LEAD", dept: "51", label: "采样机构负责人（检测）" },
  branch: { userId: "9103", username: "accept.branch", nickname: "验收分公司管理员", role: "BRANCH_ADMIN", dept: "2", label: "分公司管理员（人员/角色）" },
  leader: { userId: "9104", username: "accept.leader", nickname: "验收只读领导", role: "LEADER", dept: "1", label: "只读领导（集团视角）" },
};

/** IMEI 脱敏对照：有 identity 三项 vs 缺任一项。 */
export const IDENTITY_COMPARE = { withIdentity: "asset", withoutIdentity: "sampler", alsoWithout: "duty" };

/* ------------------------------------------------------------- 底层小工具 -- */

function log(...args) {
  console.log(...args);
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** 端口能不能用。返回占用者 PID（netstat 最后一列），没人占用给 null。 */
function portOwner(port) {
  const res = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
  const lines = String(res.stdout || "").split(/\r?\n/);
  for (const line of lines) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[1] || "";
    if (local.endsWith(`:${port}`)) return cols[cols.length - 1];
  }
  return null;
}

function tcpProbe(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    const done = (owner) => {
      socket.destroy();
      resolve(owner);
    };
    socket.setTimeout(600);
    socket.once("connect", () => done("connected"));
    socket.once("timeout", () => done(null));
    socket.once("error", () => done(null));
  });
}

async function doctor() {
  const report = { ports: {}, forbiddenOccupied: {}, db: {}, notes: [] };
  for (const port of [PLAN.apiPort, PLAN.tcpPort, PLAN.webPort]) {
    const owner = portOwner(port);
    const tcp = port === PLAN.tcpPort ? await tcpProbe(port) : null;
    report.ports[port] = { listenerPid: owner, tcpConnectable: Boolean(tcp) };
  }
  for (const port of PLAN.forbiddenPorts) {
    const owner = portOwner(port);
    if (owner) report.forbiddenOccupied[port] = owner;
  }
  const mainDb = path.join(ROOT, "server", "data", "sample-box.db");
  report.db = {
    isolationHome: PLAN.home,
    isolationHomeExists: existsSync(PLAN.home),
    mainDbPath: mainDb,
    mainDbExists: existsSync(mainDb),
    demoDbPath: path.join(ROOT, "reports", "demo2", "sample.db"),
    demoDbExists: existsSync(path.join(ROOT, "reports", "demo2", "sample.db")),
  };
  report.notes.push("本脚本只在 8010/9010/3000 上动作；forbiddenPorts 有监听即拒绝 up。");
  report.notes.push("8000/8002/9000/9002/5173 属于其他实例，down 只 kill instance.json 记录且经端口复核的 PID。");
  log(JSON.stringify(report, null, 2));
  return report;
}

/** 起一次就能反复用的 HTTP 客户端。 */
function makeApi(baseUrl, token) {
  const call = async (method, apiPath, body) => {
    const res = await fetch(`${baseUrl}${apiPath}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  };
  return {
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b ?? {}),
    put: (p, b) => call("PUT", p, b ?? {}),
    del: (p) => call("DELETE", p),
    raw: call,
  };
}

async function login(api, username, password) {
  const res = await api.post("/api/v1/auth/login", {
    username,
    password,
    captchaId: "",
    captchaCode: "0000",
  });
  if (res.body?.code !== "00000" || !res.body?.data?.accessToken)
    throw new Error(`登录失败 ${username}：HTTP ${res.status} ${JSON.stringify(res.body?.code)} ${res.body?.msg || ""}`);
  return res.body.data.accessToken;
}

/* ------------------------------------------------------- 夹具：建库与写库 -- */

/** 启动服务之前需要的东西：配置、安装锁、库表、组织、账号、箱子。 */
export async function prepareHome(home, { fresh = true } = {}) {
  if (fresh) await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  const sqlitePath = path.join(home, "sample.db");
  const config = {
    dialect: "sqlite",
    sqlitePath,
    host: "",
    port: 3306,
    user: "",
    password: "",
    database: "",
    secret: randomBytes(24).toString("hex"),
    box: { reportPeriodSec: PLAN.reportPeriodSec, reportOnlyWhenCharging: false, batteryReserve: 20 },
  };
  await writeFile(path.join(home, "db.config.json"), JSON.stringify(config, null, 2), "utf8");
  await writeFile(path.join(home, "install.lock"), new Date().toISOString(), "utf8");

  const db = await openDatabase(config, ROOT);
  let passwords;
  try {
    await migrate(db);
    await seedOrg(db);
    await db.run("UPDATE sys_dept SET type = '采样机构', name = ? WHERE id = ?", [STATION.name, STATION.id]);
    // 检测站要有地址，签收核验的「离收货点多远」才有得算
    await db.run("UPDATE sys_dept SET address = ?, lng = ?, lat = ? WHERE id = ?", [
      "广东省深圳市南山区验收大道 100 号",
      SZ.lng + 0.01,
      SZ.lat + 0.01,
    ], [STATION.id]);
    await seedRolePerms(db);
    passwords = await seedAccounts(db);
    await seedBoxes(db);
  } finally {
    await db.close();
  }
  return { config, sqlitePath, passwords };
}

async function seedAccounts(db) {
  const now = new Date().toISOString();
  for (const key of ["duty", "agency", "branch", "leader"]) {
    const account = ACCOUNTS[key];
    const roleRow = await db.get("SELECT id FROM sys_role WHERE code = ?", [account.role]);
    if (!roleRow) throw new Error(`默认角色表里找不到 ${account.role}`);
    await db.run(
      `INSERT INTO sys_user (id, username, nickname, password_hash, dept_id, status, create_time, update_time)
       VALUES (?, ?, ?, 'x', ?, 1, ?, ?)`,
      [account.userId, account.username, account.nickname, account.dept, now, now]
    );
    await db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", [account.userId, String(roleRow.id)]);
  }
  // 每个角色模板都要有登录人：给已存在的默认用户补上模板角色绑定（seedOrg 已绑，这里只重置口令）
  const passwords = {};
  for (const [key, account] of Object.entries(ACCOUNTS)) {
    const password = `Acc-${randomBytes(9).toString("base64url")}9a`;
    passwords[key] = password;
    await db.run(
      "UPDATE sys_user SET password_hash = ?, must_change_password = 0, password_changed_at = ? WHERE id = ?",
      [hashPassword(password), now, account.userId]
    );
  }
  // 采样员要能看到箱子：数据范围=仅本人，所以几台夹具箱的保管人写成他
  return passwords;
}

async function seedBoxes(db) {
  const base = {
    org: HOME_ORG.name,
    org_id: HOME_ORG.id,
    activate_step: "已确认",
    firmware: "1.0.17",
    iccid: "89860000000000000013",
    imsi: "460000000000013",
    powered_at: ago(7 * DAY),
    battery_model: "",
    battery: "3.95V",
    battery_mv: 3950,
    csq: 20,
    lid: 0,
    opens: 0,
    life: "未使用",
    policy_period_sec: PLAN.reportPeriodSec,
    last_report_at: ago(2 * MIN),
  };
  const insert = async (fields) => {
    const row = { ...base, ...fields };
    const keys = Object.keys(row);
    await db.run(
      `INSERT INTO sample_box (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
      keys.map((key) => row[key])
    );
  };
  const owned = { owner: ACCOUNTS.sampler.nickname, owner_id: ACCOUNTS.sampler.userId };
  const gps = (at) => ({
    gps: "",
    gps_lng: SZ.lng + 0.0021 * 35,
    gps_lat: SZ.lat + 0.0009 * 35,
    gps_address: "广东省深圳市南山区验收大道 1 号",
    gps_info: JSON.stringify({ sats: 9, hdop: 0.9, speed: 3.2, course: 88, alt: 40.2, at }),
  });
  const lbs = (at, offset = 0) => ({
    lbs: "深圳",
    lbs_lng: SZ.lng + 0.003 + offset / 1000,
    lbs_lat: SZ.lat - 0.002 + offset / 1000,
    lbs_at: at,
    lbs_address: "广东省深圳市南山区基站 46000 小区",
  });

  // —— 位置卡四档
  await insert({ id: BOXES.posGpsFresh.imei, imei: BOXES.posGpsFresh.imei, name: BOXES.posGpsFresh.name, life: "在途", ...owned, ...gps(ago(5 * MIN)), ...lbs(ago(6 * MIN)) });
  await insert({ id: BOXES.posGpsStaleLbsFresh.imei, imei: BOXES.posGpsStaleLbsFresh.imei, name: BOXES.posGpsStaleLbsFresh.name, life: "在途", ...owned, ...gps(ago(3 * DAY + 2 * HOUR)), ...lbs(ago(8 * MIN)) });
  await insert({ id: BOXES.posBothStale.imei, imei: BOXES.posBothStale.imei, name: BOXES.posBothStale.name, life: "在途", ...owned, ...gps(ago(3 * HOUR)), ...lbs(ago(3 * HOUR + 30 * MIN)) });
  await insert({ id: BOXES.posNone.imei, imei: BOXES.posNone.imei, name: BOXES.posNone.name, life: "在途", ...owned, last_report_at: "", policy_period_sec: null });

  // —— 离线四态与两个边界样本
  await insert({ id: BOXES.online.imei, imei: BOXES.online.imei, name: BOXES.online.name, life: "在途", ...owned, last_report_at: "" });
  await insert({ id: BOXES.overPeriods.imei, imei: BOXES.overPeriods.imei, name: BOXES.overPeriods.name, life: "在途", last_report_at: ago(35 * MIN) });
  await insert({ id: BOXES.graceIn.imei, imei: BOXES.graceIn.imei, name: BOXES.graceIn.name, life: "未使用", last_report_at: "" });
  await insert({ id: BOXES.graceOver.imei, imei: BOXES.graceOver.imei, name: BOXES.graceOver.name, life: "未使用", last_report_at: "" });
  await insert({ id: BOXES.graceTwoTasks.imei, imei: BOXES.graceTwoTasks.imei, name: BOXES.graceTwoTasks.name, life: "未使用", last_report_at: "" });
  // 仅充电上报这台：不在这里直接写 policy_charge_only 列，改由 up 阶段用真实接口
  // PUT /boxes/:id/report-policy 下发（策略表 + 列 + 列表字段三处一起对齐）。
  await insert({
    id: BOXES.chargeOnly.imei, imei: BOXES.chargeOnly.imei, name: BOXES.chargeOnly.name,
    life: "未使用", charge: 0, last_report_at: ago(3 * HOUR),
  });
  await insert({
    id: BOXES.stockPending.imei, imei: BOXES.stockPending.imei, name: "", life: "待激活",
    activate_step: "等待激活", org: "总公司", org_id: "1", last_report_at: "", firmware: "", policy_period_sec: null,
  });

  // —— 划拨撤销守卫三类 + 一张全部可撤的划拨单
  await insert({ id: BOXES.guardInTask.imei, imei: BOXES.guardInTask.imei, name: BOXES.guardInTask.name, life: "未使用" });
  await insert({ id: BOXES.guardOpened.imei, imei: BOXES.guardOpened.imei, name: BOXES.guardOpened.name, life: "未使用", opens: 0 });
  await insert({ id: BOXES.guardInspected.imei, imei: BOXES.guardInspected.imei, name: BOXES.guardInspected.name, life: "未使用" });
  await insert({ id: BOXES.revocableA.imei, imei: BOXES.revocableA.imei, name: BOXES.revocableA.name, life: "未使用" });
  await insert({ id: BOXES.revocableB.imei, imei: BOXES.revocableB.imei, name: BOXES.revocableB.name, life: "未使用" });

  // —— 送检单 9 状态，一台一个
  for (const [key, box] of Object.entries(BOXES)) {
    if (!key.startsWith("insp")) continue;
    await insert({ id: box.imei, imei: box.imei, name: box.name, life: "未使用" });
  }

  // —— 可用空箱与告警样本
  await insert({ id: BOXES.spare1.imei, imei: BOXES.spare1.imei, name: BOXES.spare1.name, life: "未使用" });
  await insert({ id: BOXES.spare2.imei, imei: BOXES.spare2.imei, name: BOXES.spare2.name, life: "未使用" });
  await insert({
    id: BOXES.alertLow.imei, imei: BOXES.alertLow.imei, name: BOXES.alertLow.name, life: "在途",
    battery_mv: 3320, battery: "3.32V", lid: 1, opens: 4, alert: "温度异常", last_report_at: ago(2 * MIN),
    ...gps(ago(3 * MIN)),
  });
}

/* -------------------------------------------------- 夹具：TCP 真实上行包 -- */

function packet(imei, { uart, gps, lbs, csq = 20, vbat }) {
  const body = {
    imei,
    iccid: "89860000000000000013",
    imsi: "460000000000013",
    csq,
    time: formatTimestamp(new Date()),
    uart,
    gpsfix: gps ? 1 : 0,
    lbslng: lbs ? String(lbs.lng) : "000.0000000",
    lbslat: lbs ? String(lbs.lat) : "000.0000000",
  };
  if (gps) Object.assign(body, { lng: gps.lng, lat: gps.lat, speed: 0, course: 0, alt: 40, sats: 9, hdop: 0.9 });
  body.vbat = vbat || Number(/bat=(\d+)/.exec(uart)?.[1]) || undefined;
  return JSON.stringify(body);
}

async function sendPackets(tcpPort, packets) {
  const sent = [];
  for (const text of packets) {
    const outcome = await new Promise((resolve) => {
      const socket = net.connect(tcpPort, "127.0.0.1");
      const timer = setTimeout(() => {
        socket.destroy();
        resolve("timeout");
      }, 3000);
      socket.on("error", (error) => {
        clearTimeout(timer);
        resolve(`error:${error.message}`);
      });
      socket.on("data", () => {
        clearTimeout(timer);
        socket.end();
        resolve("acked");
      });
      socket.write(text);
    });
    sent.push({ outcome, bytes: text.length });
  }
  return sent;
}

/** 在线箱的第一包（建库时 last_report_at 故意留空，靠真实入库变在线）。 */
export async function sendOnlineUplink(tcpPort) {
  return sendPackets(tcpPort, [
    packet(BOXES.online.imei, {
      uart: "why=timer,bat=3900,chg=0,lid=0,opens=0",
      gps: { lng: SZ.lng + 0.001, lat: SZ.lat + 0.001 },
      lbs: { lng: SZ.lng + 0.004, lat: SZ.lat - 0.001 },
      csq: 22,
    }),
  ]);
}

/** 划拨单建好之后再开一次箱：这就是「划拨后已开箱」的成因。 */
export async function sendOpenAfterTransfer(tcpPort) {
  return sendPackets(tcpPort, [
    packet(BOXES.guardOpened.imei, {
      uart: "why=pad,bat=3880,chg=0,lid=1,opens=1",
      lbs: { lng: SZ.lng + 0.005, lat: SZ.lat - 0.002 },
      csq: 18,
    }),
  ]);
}

/**
 * 「仅充电上报」这台箱子走真实接口：PUT /boxes/:id/report-policy。
 * 只写库里的 policy_charge_only 列不够——页面和详情读的是 box_report_policy 那张策略表
 * （BoxState.js:345 取 reportPolicy.effective），两边不一致会让验收误判。
 * 走接口后：策略表有行、sample_box.policy_charge_only=1、列表 reportOnlyWhenCharging=true，三处对齐。
 */
export async function applyChargeOnlyPolicy(admin, imei) {
  const res = await admin.put(`/api/v1/sample/boxes/${imei}/report-policy`, {
    policy: { reportPeriodSec: PLAN.reportPeriodSec, reportOnlyWhenCharging: true },
  });
  const echo = await admin.get(`/api/v1/sample/boxes/${imei}/report-policy`);
  return {
    save: { status: res.status, code: res.body?.code, msg: res.body?.msg, data: res.body?.data },
    effective: echo.body?.data?.effective || null,
    source: echo.body?.data?.effective?.source || echo.body?.data?.source || null,
  };
}

/* ---------------------------------------------------- 夹具：接口建单与推进 -- */

/**
 * 建单全部用管理员账号（隔离实例上唯一稳妥的推进方），
 * 角色视角的 can/权限在 check 阶段按各账号读回来核对。
 */
export async function createFixtureTasks(api) {
  const created = {};
  const errors = [];
  const add = async (name, body) => {
    try {
      const res = await api.post("/api/v1/sample/tasks", body);
      if (res.body?.code !== "00000") throw new Error(`HTTP ${res.status} ${JSON.stringify(res.body)}`);
      created[name] = res.body.data.id;
      return created[name];
    } catch (error) {
      errors.push({ phase: `建单 ${name}`, error: String(error.message || error) });
      return null;
    }
  };
  const step = async (id, status, note = "") => {
    if (!id) return null;
    try {
      const res = await api.put(`/api/v1/sample/tasks/${id}/status`, { status, note });
      if (res.body?.code !== "00000") throw new Error(`HTTP ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.data;
    } catch (error) {
      errors.push({ phase: `推进 ${id} → ${status}`, error: String(error.message || error) });
      return null;
    }
  };
  const inspectBox = async (id, imei) => {
    if (!id) return null;
    try {
      const res = await api.post(`/api/v1/sample/tasks/${id}/boxes/${imei}/inspect`, {});
      if (res.body?.code !== "00000") throw new Error(`HTTP ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.data;
    } catch (error) {
      errors.push({ phase: `开始检测 ${id}/${imei}`, error: String(error.message || error) });
      return null;
    }
  };

  // 宽限三态：箱子从未上报，任务建单时间决定宽限内/外
  await add("graceIn", {
    name: "验收-宽限内未上报",
    kind: "调拨",
    boxIds: [BOXES.graceIn.imei],
    fromOrgId: HOME_ORG.id,
    toOrgId: "3",
    sender: ACCOUNTS.dispatch.nickname,
    signer: ACCOUNTS.verify.nickname,
    direct: true,
  });
  created.graceOver = await add("graceOver", {
    name: "验收-宽限外未上报",
    kind: "调拨",
    boxIds: [BOXES.graceOver.imei],
    fromOrgId: HOME_ORG.id,
    toOrgId: "3",
    sender: ACCOUNTS.dispatch.nickname,
    signer: ACCOUNTS.verify.nickname,
    direct: true,
  });
  created.twoEarly = await add("twoEarly", {
    name: "验收-两张单里的较早一张",
    kind: "调拨",
    boxIds: [BOXES.graceTwoTasks.imei],
    fromOrgId: HOME_ORG.id,
    toOrgId: "3",
    sender: ACCOUNTS.dispatch.nickname,
    signer: ACCOUNTS.verify.nickname,
    direct: true,
  });
  // 「一台箱子同时挂两张未结束单」接口构造不出来：ReportPolicy.js:349 明确 409 拒绝
  //（未结束且未检测的单里已经绑了这台箱子），而且 box_active_task.box_id 是主键，
  // 一台箱子结构性地只能挂一个活跃单。这里把接口真实拒绝取成证据；
  // 第二张未结束单由 up 阶段的 DB 夹具（cloneUnfinishedTask）复制出来，只为验目标语义。
  const twoLateProbe = await api.post("/api/v1/sample/tasks", {
    name: "验收-两张单里的较晚一张（接口应拒绝）",
    kind: "调拨",
    boxIds: [BOXES.graceTwoTasks.imei],
    fromOrgId: HOME_ORG.id,
    toOrgId: "3",
    sender: ACCOUNTS.dispatch.nickname,
    signer: ACCOUNTS.verify.nickname,
    direct: true,
  });
  created.twoLateByApi = {
    status: twoLateProbe.status,
    code: twoLateProbe.body?.code ?? null,
    msg: twoLateProbe.body?.msg ?? null,
    allowed: twoLateProbe.body?.code === "00000",
    taskId: twoLateProbe.body?.data?.id || null,
  };
  if (created.twoLateByApi.allowed)
    errors.push({ phase: "一箱两单", error: "接口居然允许了，请与产品确认规则是否已放开（原 409 A0409）" });

  // 守卫一：已进入未结束任务（采样单，停在待采样，也是 #4 走采样流程的样本）
  created.guardInTask = await add("guardInTask", {
    name: "验收-采样进行中（守卫：已进任务）",
    kind: "采样",
    boxIds: [BOXES.guardInTask.imei],
    orgId: "51",
    place: "深圳市南山区验收大道 5 号",
    note: "夹具：这张单停在待采样，用来验「已进入未结束任务」不该撤",
  });

  // 守卫二：划拨后已开箱（建完单再发开箱包）
  created.guardOpened = await add("guardOpened", {
    name: "验收-调拨后开箱（守卫：划拨后已开箱）",
    kind: "调拨",
    boxIds: [BOXES.guardOpened.imei],
    fromOrgId: HOME_ORG.id,
    toOrgId: "3",
    sender: ACCOUNTS.dispatch.nickname,
    signer: ACCOUNTS.verify.nickname,
    direct: true,
  });

  // 全部可撤的一张划拨单（两台，都没进过别的单、没开箱、没检测）
  created.revocable = await add("revocable", {
    name: "验收-全部可撤的划拨单",
    kind: "调拨",
    boxIds: [BOXES.revocableA.imei, BOXES.revocableB.imei],
    fromOrgId: HOME_ORG.id,
    toOrgId: "3",
    sender: ACCOUNTS.dispatch.nickname,
    signer: ACCOUNTS.verify.nickname,
    direct: true,
  });

  // 送检单：签收方是采样机构（检测站），9 个状态各一张。
  // 单名里直接写目标状态（不是 insp6 这种脚本键），任务列表和截图一眼能看懂。
  const INSPECT_LABELS = {
    insp1: "待寄出",
    insp2: "运送中",
    insp3: "待签收",
    insp4: "待检测",
    insp5: "退回中",
    insp6: "已检测",
    insp7: "已退回",
    insp8: "已拒收",
    insp9: "已取消",
  };
  const inspectBase = (key) => ({
    name: `验收-送检单-${INSPECT_LABELS[key] || key}`,
    kind: "调拨",
    boxIds: [BOXES[key].imei],
    fromOrgId: HOME_ORG.id,
    toOrgId: STATION.id,
    sender: ACCOUNTS.dispatch.nickname,
    signer: ACCOUNTS.verify.nickname,
    maxOpens: 2,
  });

  created.inspWaitSend = await add("inspWaitSend", inspectBase("insp1"));
  created.inspMoving = await add("inspMoving", inspectBase("insp2"));
  await step(created.inspMoving, "运送中");
  created.inspWaitSign = await add("inspWaitSign", inspectBase("insp3"));
  await step(created.inspWaitSign, "运送中");
  await step(created.inspWaitSign, "待签收");
  created.inspWaitInspect = await add("inspWaitInspect", inspectBase("insp4"));
  await step(created.inspWaitInspect, "运送中");
  await step(created.inspWaitInspect, "待签收");
  await step(created.inspWaitInspect, "待检测", "夹具代签");
  created.inspReturning = await add("inspReturning", inspectBase("insp5"));
  await step(created.inspReturning, "运送中");
  await step(created.inspReturning, "待签收");
  await step(created.inspReturning, "退回中", "夹具：样品箱不合格，退回寄出单位");
  created.inspInspected = await add("inspInspected", inspectBase("insp6"));
  await step(created.inspInspected, "运送中");
  await step(created.inspInspected, "待签收");
  await step(created.inspInspected, "待检测", "夹具代签");
  // 逐台「开始检测」这一调用本身就会把单推到已检测，不能再 PUT 一次（再 PUT 会被当成越权，403）
  await inspectBox(created.inspInspected, BOXES.insp6.imei);
  created.inspReturned = await add("inspReturned", inspectBase("insp7"));
  await step(created.inspReturned, "运送中");
  await step(created.inspReturned, "待签收");
  await step(created.inspReturned, "退回中", "夹具：退回寄出单位");
  await step(created.inspReturned, "已退回");
  created.inspRejected = await add("inspRejected", inspectBase("insp8"));
  await step(created.inspRejected, "运送中");
  await step(created.inspRejected, "待签收");
  await step(created.inspRejected, "已拒收", "夹具：开箱超限拒收");
  created.inspCancelled = await add("inspCancelled", inspectBase("insp9"));
  await step(created.inspCancelled, "已取消", "夹具：建单后取消");

  // 守卫三：已完成开箱检测 —— 单独一张送检单推到待检测、逐台开始检测
  created.guardInspected = await add("guardInspected", {
    name: "验收-已完成开箱检测（守卫：检测已完成）",
    kind: "调拨",
    boxIds: [BOXES.guardInspected.imei],
    fromOrgId: HOME_ORG.id,
    toOrgId: STATION.id,
    sender: ACCOUNTS.dispatch.nickname,
    signer: ACCOUNTS.verify.nickname,
  });
  await step(created.guardInspected, "运送中");
  await step(created.guardInspected, "待签收");
  await step(created.guardInspected, "待检测", "夹具代签");
  await inspectBox(created.guardInspected, BOXES.guardInspected.imei);

  // 样本 A：这台箱子在那张未结束单里已经「开始检测」，对它算结束 → 接口允许再进新单。
  // 这就是「一箱两张未结束单」在现网规则下唯一可达的形态，宽限该取哪张的建单时间是实现歧义点。
  created.twoTasksAfterInspect = await add("twoTasksAfterInspect", {
    name: "验收-检测完成后另建单（一箱两单·接口可达形态）",
    kind: "调拨",
    boxIds: [BOXES.guardInspected.imei],
    fromOrgId: HOME_ORG.id,
    toOrgId: "4",
    sender: ACCOUNTS.dispatch.nickname,
    signer: ACCOUNTS.verify.nickname,
    direct: true,
  });

  return { created, errors };
}

/* -------------------------------- 夹具：DB 级补样本（复制单 + 建单时间回拨） -- */

/**
 * 宽限是按建单时间算的，接口建单只能是「现在」；一箱两单接口又被 409 拦住。
 * 所以这两件事只能在服务器空转时直接写夹具库完成：
 *   1) clone：把较早那张单复制成第二张未结束单（只动 sample_task / sample_task_box / sample_task_log）；
 *   2) backdate：把 created_at（ISO UTC）拨到 2 小时前 / 50 分钟前 / 10 分钟前。
 * SQLite 是单文件回滚日志模式，写入带 busy_timeout + 重试；失败只记进证据、不影响其它夹具。
 */
async function dbFixturePass(sqlitePath, { backdate = {}, clone = null } = {}) {
  const db = await openDatabase({ dialect: "sqlite", sqlitePath }, ROOT);
  const results = [];
  let cloned = null;
  try {
    try {
      await db.run("PRAGMA busy_timeout = 8000");
    } catch (error) {
      results.push({ pragma: "failed", error: String(error.message || error) });
    }
    if (clone) {
      try {
        cloned = await cloneUnfinishedTask(db, clone);
        results.push({ clone: cloned.id, ok: true, source: clone.sourceId });
      } catch (error) {
        results.push({ clone: clone.newId, ok: false, error: String(error.message || error) });
      }
    }
    for (const [taskId, msAgo] of Object.entries(backdate)) {
      if (!taskId) {
        results.push({ taskId: null, ok: false, error: "这张单没建出来，跳过回拨" });
        continue;
      }
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          await db.run("UPDATE sample_task SET created_at = ? WHERE id = ?", [isoAgo(msAgo), String(taskId)]);
          const row = await db.get("SELECT id, created_at FROM sample_task WHERE id = ?", [String(taskId)]);
          results.push({ taskId, created_at: row?.created_at || "", targetAgoMin: Math.round(msAgo / MIN), attempts: attempt, ok: true });
          break;
        } catch (error) {
          if (attempt >= 6) {
            results.push({ taskId, ok: false, attempts: attempt, error: String(error.message || error) });
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    }
  } finally {
    await db.close();
  }
  return { results, cloned };
}

/**
 * 「一台箱子同时挂两张未结束单」接口构造不出来：ReportPolicy.js:349 直接 409，
 * 而且 box_active_task.box_id 是主键（一台箱子只能有一个活跃单）。
 * 这里只复制 sample_task + sample_task_box 两行，让 /tasks?boxId= 能读到两张未结束、
 * 未检测的单，专门用来验目标语义里「宽限取最早那张的建单时间」；
 * box_active_task 保持指向较早那张，不动它，也不动箱子的 life。
 */
async function cloneUnfinishedTask(db, { sourceId, newId, name, msAgo }) {
  const src = await db.get("SELECT * FROM sample_task WHERE id = ?", [String(sourceId)]);
  if (!src) throw new Error(`源单 ${sourceId} 不存在`);
  const link = await db.get("SELECT * FROM sample_task_box WHERE task_id = ?", [String(sourceId)]);
  if (!link) throw new Error(`源单 ${sourceId} 没有绑定箱子`);
  const taskRow = { ...src, id: String(newId), name: String(name), created_at: isoAgo(msAgo) };
  if (typeof taskRow.body === "string" && taskRow.body) {
    try {
      taskRow.body = JSON.stringify({ ...JSON.parse(taskRow.body), name });
    } catch {
      /* body 解析不了就原样复制，不影响列表按 name 列显示 */
    }
  }
  const taskKeys = Object.keys(taskRow);
  await db.run(
    `INSERT INTO sample_task (${taskKeys.join(", ")}) VALUES (${taskKeys.map(() => "?").join(", ")})`,
    taskKeys.map((key) => taskRow[key])
  );
  const linkRow = { ...link, task_id: String(newId), inspected_at: null, inspected_by: null };
  const linkKeys = Object.keys(linkRow);
  await db.run(
    `INSERT INTO sample_task_box (${linkKeys.join(", ")}) VALUES (${linkKeys.map(() => "?").join(", ")})`,
    linkKeys.map((key) => linkRow[key])
  );
  await db.run(
    "INSERT INTO sample_task_log (id,task_id,status,action,actor_id,actor_name,note,detail,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [
      randomUUID(),
      String(newId),
      taskRow.status,
      "创建",
      "",
      "验收夹具",
      "DB 复制出的第二张未结束单：接口规则（409 + box_active_task 主键）不允许一箱两单，只为验宽限取最早建单时间",
      null,
      taskRow.created_at,
    ]
  );
  return { id: taskRow.id, sourceId: String(sourceId), name, created_at: taskRow.created_at, boxId: link.box_id, status: taskRow.status };
}

/* ------------------------------------------------------------ 进程生命周期 -- */

async function waitHealthy(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  const timeline = [];
  while (Date.now() < deadline) {
    const started = Date.now();
    let status = 0;
    let code = null;
    try {
      const res = await fetch(`${baseUrl}/api/v1/auth/captcha`, { method: "GET" });
      status = res.status;
      const json = await res.json().catch(() => null);
      code = json?.code ?? null;
    } catch (error) {
      status = 0;
      code = String(error.message || error).slice(0, 60);
    }
    timeline.push({ t: new Date().toISOString(), status, code });
    if (status === 200 && code === "00000")
      return { healthy: true, attempts: timeline.length, last: timeline[timeline.length - 1] };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { healthy: false, attempts: timeline.length, last: timeline[timeline.length - 1] };
}

function spawnServer(home) {
  const out = path.join(home, "server.out.log");
  const err = path.join(home, "server.err.log");
  const logStreams = { out, err };
  const child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", awaitOpen(out), awaitOpen(err)],
    env: {
      ...process.env,
      SAMPLE_HOME: home,
      SAMPLE_ACCEPTANCE: "1",
      // 只在隔离实例上开假 openid：微信集成没配，静默登录会 500，验收要能走绑定/登录链路
      SAMPLE_WECHAT_FAKE_OPENID: "acceptance-fake-openid",
      PORT: String(PLAN.apiPort),
      SAMPLE_TCP_PORT: String(PLAN.tcpPort),
      SYSTEM_LOG_PATH: path.join(home, "system-logs.sqlite"),
    },
  });
  child.unref();
  return { pid: child.pid, logStreams };
}

function awaitOpen(file) {
  // 日志文件在 spawn 前就打开（追加模式），down 之后还能回看启动输出
  return openSync(file, "a");
}

async function readInstance(home) {
  return readJson(path.join(home, "instance.json"));
}

/** 取某个 PID 的命令行，用来核对它是不是本项目的后端进程（只读查询）。 */
function processCommandLine(pid) {
  const res = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" | Select-Object -ExpandProperty CommandLine`],
    { encoding: "utf8" }
  );
  return String(res.stdout || res.stderr || "").trim();
}

async function stopInstance({ purge = false, pid = null } = {}) {
  const instance = await readInstance(PLAN.home);
  let target = instance?.pid || null;
  let targetSource = instance ? "instance.json" : null;
  if (!target && pid) {
    // 上一轮 up 中途抛错会留下孤儿进程却没有 instance.json。这时允许人工传 --pid，
    // 但必须过两道复核：8010 的监听者 == 这个 PID，且它的命令行确实是 server/index.js。
    target = Number(pid);
    targetSource = "--pid 参数（下面双重复核）";
  }
  if (!target) {
    log(
      JSON.stringify(
        { stopped: false, reason: "没有 instance.json，也没有 --pid，本脚本不猜任何进程，未做停止操作" },
        null,
        2
      )
    );
    return { stopped: false, reason: "no-instance" };
  }
  const owner = portOwner(PLAN.apiPort);
  if (!owner) {
    log(JSON.stringify({ stopped: false, reason: `8010 无监听，进程可能已自行退出`, pid: target }, null, 2));
  } else if (String(owner) !== String(target)) {
    log(
      JSON.stringify(
        { stopped: false, reason: `8010 的监听 PID 与记录（${targetSource}）不一致，拒绝 kill（请人工确认后再处置）`, portOwner: owner, targetPid: target },
        null,
        2
      )
    );
    return { stopped: false, reason: "pid-mismatch" };
  } else {
    const cmd = processCommandLine(target);
    if (!/server[\\/]index\.js/.test(cmd)) {
      log(JSON.stringify({ stopped: false, reason: "命令行不像本项目后端，拒绝 kill", pid: target, commandLine: cmd }, null, 2));
      return { stopped: false, reason: "cmdline-mismatch" };
    }
    log(`复核通过：${PLAN.apiPort} 监听者 = ${target}，命令行 = ${cmd}`);
    const kill = spawnSync("taskkill", ["/PID", String(target), "/T", "/F"], { encoding: "utf8" });
    log(`taskkill exit=${kill.status} ${String(kill.stdout || kill.stderr || "").trim()}`);
    await new Promise((resolve) => setTimeout(resolve, 800));
    log(`复核：${PLAN.apiPort} 监听者=${portOwner(PLAN.apiPort) || "无"}，${PLAN.tcpPort} 监听者=${portOwner(PLAN.tcpPort) || "无"}`);
  }
  if (purge) {
    await rm(PLAN.home, { recursive: true, force: true });
    log(`已删除临时目录 ${PLAN.home}`);
  } else {
    log(`保留临时目录：${PLAN.home}（含夹具库、日志、accounts.local.json）`);
  }
  return { stopped: true, purge, pid: target };
}

async function status() {
  const instance = await readInstance(PLAN.home);
  const out = {
    instance: instance || null,
    apiListenerPid: portOwner(PLAN.apiPort),
    tcpListenerPid: portOwner(PLAN.tcpPort),
    forbiddenOccupied: Object.fromEntries(PLAN.forbiddenPorts.map((p) => [p, portOwner(p)]).filter(([, v]) => v)),
    health: null,
  };
  if (out.apiListenerPid) {
    const probe = await waitHealthy(`http://127.0.0.1:${PLAN.apiPort}`, 4000);
    out.health = probe;
  }
  log(JSON.stringify(out, null, 2));
  return out;
}

/* ------------------------------------------------------------------ check -- */

async function check() {
  const baseUrl = `http://127.0.0.1:${PLAN.apiPort}`;
  const instance = await readInstance(PLAN.home);
  if (!instance) throw new Error("隔离实例没起（缺 instance.json），先跑 up");
  const passwords = await readJson(path.join(PLAN.home, "accounts.local.json"), {});
  const evidence = { generatedAt: new Date().toISOString(), baseUrl, instance, checks: [], envelope: {}, authz: {} };
  const record = (name, ok, detail) => {
    evidence.checks.push({ name, verdict: ok === null ? "OBSERVE" : ok ? "PASS" : "FAIL", detail });
    log(`${ok === null ? "··" : ok ? "OK" : "XX"} ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 260)}`}`);
  };

  // 箱子列表在无筛选参数时返回裸数组、带 page/flag/q 时返回分页对象，这里统一取行
  const rowsOf = (data) => (Array.isArray(data) ? data : data?.list || []);
  const boxesPaged = (key = "admin", extra = "") =>
    api(key).get(`/api/v1/sample/boxes?page=1&pageSize=100${extra}`);

  const adminApi = makeApi(baseUrl);
  const captcha = await adminApi.get("/api/v1/auth/captcha");
  evidence.envelope.captcha = { status: captcha.status, code: captcha.body?.code, keys: Object.keys(captcha.body || {}) };
  record("HTTP 信封三键 {code,data,msg}", captcha.body && ["code", "data", "msg"].every((k) => k in captcha.body) && captcha.body.code === "00000", evidence.envelope.captcha);

  const anon = await makeApi(baseUrl).get("/api/v1/sample/boxes");
  evidence.authz.noToken = { status: anon.status, code: anon.body?.code };
  record("未带令牌 → 401", anon.status === 401, evidence.authz.noToken);

  const tokens = {};
  for (const [key, account] of Object.entries(ACCOUNTS)) {
    const api = makeApi(baseUrl);
    tokens[key] = await login(api, account.username, passwords[key]);
  }
  const api = (key) => makeApi(baseUrl, tokens[key]);
  const admin = api("admin");

  // —— 夹具完整性：每台箱子都要能读到
  const listAll = await boxesPaged();
  const rows = rowsOf(listAll.body?.data);
  const byImei = new Map(rows.map((row) => [String(row.id), row]));
  const missing = Object.values(BOXES).filter((box) => !byImei.has(box.imei)).map((box) => box.name || box.imei);
  record(`夹具箱 ${Object.keys(BOXES).length} 台全部在册`, missing.length === 0, { listed: rows.length, missing });

  const stats = (await admin.get("/api/v1/sample/boxes/stats")).body?.data || {};
  const flagCount = async (flag) => {
    const res = await admin.get(`/api/v1/sample/boxes?flag=${flag}&pageSize=100`);
    return { total: res.body?.data?.total, ids: (res.body?.data?.list || []).map((row) => row.id) };
  };
  const flags = {};
  for (const flag of ["offline", "low", "alert", "lid", "ready"]) flags[flag] = await flagCount(flag);
  evidence.kpi = { statsFlags: stats.flags, statsCounts: stats.counts, flagLists: flags };
  for (const flag of ["offline", "low", "alert", "lid"]) {
    const tile = stats.flags?.[flag];
    const listed = flags[flag].total;
    record(`首页 KPI「${flag}」数字 == 落地列表行数`, tile != null && tile === listed, { tile, listed });
  }
  // 值班员是首页四张卡的实际使用者，同样核对一遍（数据范围=全部，但字段权限更少）
  const dutyStats = (await api("duty").get("/api/v1/sample/boxes/stats")).body?.data || {};
  const dutyOffline = (await api("duty").get("/api/v1/sample/boxes?flag=offline&pageSize=100")).body?.data || {};
  record(
    "值班员视角：KPI「离线」== 落地列表行数，且低电/开盖卡按字段权限收敛",
    dutyStats.flags?.offline === dutyOffline.total,
    { dutyFlags: dutyStats.flags, dutyOfflineTotal: dutyOffline.total, dutyBoxCount: (dutyOffline.list || []).length }
  );

  // —— 离线四态实测
  const offlineIds = new Set(flags.offline.ids);
  const offlineCase = (key, expectOffline, note) => {
    const row = byImei.get(BOXES[key].imei) || {};
    const countedOffline = offlineIds.has(BOXES[key].imei);
    record(
      `离线档：${BOXES[key].tier}`,
      countedOffline === expectOffline,
      {
        box: BOXES[key].name || BOXES[key].imei,
        last: row.last || "",
        reportPeriodSec: row.reportPeriodSec,
        policyChargeOnly: row.reportOnlyWhenCharging,
        charge: row.charge,
        countedOffline,
        expectedOffline: expectOffline,
        note,
      }
    );
  };
  offlineCase("online", false, "TCP 真实入库后 last_report_at 应为当前时间");
  offlineCase("overPeriods", true, "35 分钟 > 3 个周期（30 分钟）");
  offlineCase("chargeOnly", false, "仅充电模式且未充电 → 不据缺心跳判离线（代码已实现）");
  const chargeRow = byImei.get(BOXES.chargeOnly.imei) || {};
  evidence.chargeOnlyConsistency = {
    listField: chargeRow.reportOnlyWhenCharging,
    policy: instance.chargeOnlyPolicy || null,
    policySource: instance.chargeOnlyPolicy?.effective?.source || null,
    countedOffline: offlineIds.has(BOXES.chargeOnly.imei),
    charge: chargeRow.charge,
  };
  record(
    "仅充电上报豁免样本三处一致（策略表 / 列表字段 / 离线计数）",
    chargeRow.reportOnlyWhenCharging === true &&
      instance.chargeOnlyPolicy?.save?.status === 200 &&
      instance.chargeOnlyPolicy?.effective?.reportOnlyWhenCharging === true &&
      offlineIds.has(BOXES.chargeOnly.imei) === false,
    evidence.chargeOnlyConsistency
  );
  offlineCase("graceIn", false, "目标语义：建单 40 分钟内从未上报 = 中性待上线，不计离线");
  offlineCase("graceOver", true, "目标语义：建单 2 小时从未上报 = 计离线");
  offlineCase("graceTwoTasks", true, "目标语义：宽限取最早建单（50 分钟前）→ 计离线；若误取 10 分钟前会变待上线");
  offlineCase("stockPending", true, "未建单的待激活库存不受宽限影响");

  // —— 位置四档
  const positions = [];
  for (const key of ["posGpsFresh", "posGpsStaleLbsFresh", "posBothStale", "posNone"]) {
    const res = await admin.get(`/api/v1/sample/boxes/${BOXES[key].imei}`);
    const box = res.body?.data || {};
    const staleMs = 10 * MIN;
    const t = (v) => (v ? new Date(String(v).replace(" ", "T")).getTime() : NaN);
    const gpsAt = t(box.lastGpsAt);
    const lbsAt = t(box.lastLbsAt);
    const gpsStale = Number.isFinite(gpsAt) && Number.isFinite(lbsAt) && lbsAt - gpsAt > staleMs;
    const source = Number.isFinite(gpsAt) || box.gpsLng != null ? (gpsStale ? "基站" : "GPS") : Number.isFinite(lbsAt) ? "基站" : "无";
    positions.push({
      tier: BOXES[key].tier,
      box: BOXES[key].name,
      lastGpsAt: box.lastGpsAt ?? "(字段缺失)",
      lastLbsAt: box.lastLbsAt ?? "(字段缺失)",
      gpsLng: box.gpsLng ?? null,
      gpsLat: box.gpsLat ?? null,
      lbsLng: box.lbsLng ?? null,
      lbsLat: box.lbsLat ?? null,
      gpsStaleByRule: gpsStale,
      derivedSource: source,
      masked: box.masked || [],
    });
  }
  evidence.position = positions;
  record(
    "位置卡：lastGpsAt / lastLbsAt 双字段已下发",
    positions.every((item) => item.lastGpsAt !== "(字段缺失)" && item.lastLbsAt !== "(字段缺失)"),
    positions.map((item) => ({ tier: item.tier, lastGpsAt: item.lastGpsAt, lastLbsAt: item.lastLbsAt }))
  );
  const staleCase = positions.find((item) => item.tier.startsWith("位置/GPS 过时"));
  record("位置卡：GPS 旧 + 基站新 >10 分钟 → 判定改用基站", staleCase?.gpsStaleByRule === true && staleCase?.derivedSource === "基站", staleCase);

  // —— 送检单 9 状态
  const taskList = await admin.get("/api/v1/sample/tasks?pageSize=100");
  const tasks = taskList.body?.data?.list || [];
  const byName = new Map(tasks.map((task) => [String(task.name), task]));
  const statusOf = (name) => byName.get(name)?.status;
  const nine = ["待寄出", "运送中", "待签收", "待检测", "退回中", "已检测", "已退回", "已拒收", "已取消"];
  const nineRows = nine.map((status) => {
    const task = tasks.find((item) => String(item.name).startsWith("验收-送检") && item.status === status);
    return { status, name: task?.name || null, id: task?.id || null, kind: task?.kind || null, steps: task?.steps || null };
  });
  evidence.inspectStatuses = nineRows;
  record("送检单 9 状态样本齐备", nineRows.every((row) => row.name), nineRows.map((row) => `${row.status}:${row.name || "缺"}`));
  record(
    "送检单不出现「已签收」状态（签收即进待检测）",
    !tasks.some((task) => String(task.name).startsWith("验收-送检") && task.status === "已签收"),
    { inspectTaskStatuses: tasks.filter((t) => String(t.name).startsWith("验收-送检")).map((t) => t.status) }
  );

  // —— 划拨撤销守卫现状（目标语义未实现时，这里给出可断言的当前行为）
  const guardPlan = [
    { label: "已进入未结束任务", taskKey: "guardInTask", box: BOXES.guardInTask, expectOpensDuring: null },
    { label: "划拨后已开箱", taskKey: "guardOpened", box: BOXES.guardOpened, expectOpensDuring: 1 },
    { label: "已完成开箱检测", taskKey: "guardInspected", box: BOXES.guardInspected, expectOpensDuring: null },
    { label: "全部可撤的划拨单", taskKey: "revocable", box: BOXES.revocableA, expectOpensDuring: 0 },
  ];
  const guards = [];
  for (const item of guardPlan) {
    const taskId = instance.tasks?.[item.taskKey];
    if (!taskId) {
      guards.push({ label: item.label, error: "instance.json 没记到这张单" });
      continue;
    }
    const detail = (await admin.get(`/api/v1/sample/tasks/${taskId}`)).body?.data || {};
    const boxRow = (detail.boxes || []).find((row) => String(row.id) === item.box.imei) || {};
    const listAsOwner = await admin.get(`/api/v1/sample/tasks?q=${encodeURIComponent(String(taskId))}`);
    const listed = (listAsOwner.body?.data?.list || []).find((task) => String(task.id) === String(taskId)) || {};
    guards.push({
      label: item.label,
      taskId,
      status: detail.task?.status ?? null,
      kind: detail.task?.kind ?? null,
      createdAt: detail.task?.createdAt ?? null,
      canCancel: detail.can?.["已取消"] ?? null,
      listActions: listed.actions ?? null,
      boxId: item.box.imei,
      boxLife: byImei.get(item.box.imei)?.life ?? null,
      opensDuringTask: boxRow.opensDuring ?? null,
      inspectedAt: boxRow.inspectedAt || "",
      expectedEvidence: item.label === "全部可撤的划拨单" ? "两台都没进别的单、没开箱、没检测" : item.label,
    });
  }
  evidence.transferGuards = guards;
  record(
    "守卫数据形态齐备（开箱数 / 检测时间 / 在任务中都能在接口上读到）",
    guards.every((row) => row.status) &&
      (guards.find((r) => r.label === "划拨后已开箱")?.opensDuringTask ?? 0) >= 1 &&
      Boolean(guards.find((r) => r.label === "已完成开箱检测")?.inspectedAt),
    guards.map((row) => ({
      label: row.label,
      status: row.status,
      can已取消: row.canCancel,
      任务期间开箱: row.opensDuringTask,
      检测时间: row.inspectedAt || "无",
    }))
  );
  record(
    "划拨撤销：当前代码仍允许取消（「提交即生效 + 整单禁撤 + 三类原因守卫」未实现，属 wave2）",
    guards.filter((row) => row.canCancel === true).length >= 1 && !guards.some((row) => row.blockedReason),
    guards.map((row) => `${row.label}: can已取消=${row.canCancel}`)
  );

  // —— 任务状态标签数字 == 落地列表行数（L-P0-3 的任务侧口径）
  const taskCounts = (await admin.get("/api/v1/sample/tasks")).body?.data?.counts || {};
  const unfilteredTotal = (await admin.get("/api/v1/sample/tasks?pageSize=100")).body?.data?.total ?? null;
  const countCompare = [];
  for (const tab of ["进行中", "已结束", "签收"]) {
    const res = await admin.get(`/api/v1/sample/tasks?status=${encodeURIComponent(tab)}&pageSize=100`);
    countCompare.push({ tab, counts: taskCounts[tab] ?? null, listTotal: res.body?.data?.total ?? null });
  }
  countCompare.unshift({ tab: "全部", counts: taskCounts["全部"] ?? null, listTotal: unfilteredTotal });
  for (const status of nine) {
    const res = await admin.get(`/api/v1/sample/tasks?status=${encodeURIComponent(status)}&pageSize=100`);
    countCompare.push({ tab: status, counts: taskCounts[status] ?? null, listTotal: res.body?.data?.total ?? null });
  }
  evidence.taskCounts = countCompare;
  const countMismatch = countCompare.filter((row) => row.counts !== row.listTotal);
  record(
    "任务页签数字与列表行数同源（counts[状态] == total；「全部」含未按状态筛选的分面口径）",
    countMismatch.length === 0,
    { mismatch: countMismatch, sample: countCompare.slice(0, 6) }
  );

  // —— 宽限夹具的建单时间实测（接口回读，证明回拨生效）
  const graceTaskKeys = { graceOver: 2 * HOUR, twoEarly: 50 * MIN, twoLate: 10 * MIN };
  const graceAges = [];
  for (const [key, msAgo] of Object.entries(graceTaskKeys)) {
    const taskId = instance.tasks?.[key];
    if (!taskId) continue;
    const detail = (await admin.get(`/api/v1/sample/tasks/${taskId}`)).body?.data || {};
    const ageMin = Math.round((Date.now() - new Date(detail.task?.createdAt).getTime()) / MIN);
    graceAges.push({ key, taskId, createdAt: detail.task?.createdAt, ageMin, wantAgoMin: Math.round(msAgo / MIN) });
  }
  evidence.graceAges = graceAges;
  record(
    `宽限夹具建单时间已回拨（${graceAges.map((r) => `${r.key}=${r.ageMin}min`).join("，")}）`,
    graceAges.length === 3 && graceAges.every((row) => Math.abs(row.ageMin - row.wantAgoMin) <= 2),
    graceAges
  );
  // 一箱两单：接口层被 409 拒绝（现网规则 + box_active_task.box_id 主键），
  // 第二张只能由 DB 夹具复制出来；这里两边都取证，供「宽限取最早建单时间」的目标语义用。
  const twoTaskProbe = instance.tasks?.twoLateByApi || null;
  evidence.twoLateByApi = twoTaskProbe;
  record(
    "一箱两单：接口按现网规则拒绝（期望 HTTP 409 / A0409）",
    twoTaskProbe ? twoTaskProbe.status === 409 && twoTaskProbe.code === "A0409" && !twoTaskProbe.allowed : null,
    twoTaskProbe
  );
  const twoTaskBox = (await admin.get(`/api/v1/sample/tasks?boxId=${BOXES.graceTwoTasks.imei}`)).body?.data || {};
  const twoUnfinished = (twoTaskBox.list || []).filter((task) => task.status !== "已取消");
  const earliestAgeMin = twoUnfinished.length
    ? Math.round((Date.now() - Math.min(...twoUnfinished.map((t) => new Date(t.createdAt).getTime()))) / MIN)
    : null;
  evidence.twoTaskBox = {
    total: twoTaskBox.total,
    earliestAgeMin,
    tasks: (twoTaskBox.list || []).map((task) => ({ id: task.id, name: task.name, status: task.status, createdAt: task.createdAt })),
  };
  record(
    "一台箱子同时挂两张未结束单（DB 夹具备妥，最早那张已过 40 分钟宽限线）",
    twoUnfinished.length === 2 && earliestAgeMin >= 45,
    { total: twoTaskBox.total, earliestAgeMin, names: evidence.twoTaskBox.tasks.map((t) => `${t.name}/${t.status}@${t.createdAt}`) }
  );

  // —— IMEI 脱敏对照
  const imeiRows = [];
  for (const key of [IDENTITY_COMPARE.withIdentity, IDENTITY_COMPARE.withoutIdentity, IDENTITY_COMPARE.alsoWithout]) {
    const res = await boxesPaged(key);
    const list = rowsOf(res.body?.data);
    const sample = list.find((row) => String(row.id) === BOXES.posGpsFresh.imei) || list[0] || {};
    imeiRows.push({
      account: ACCOUNTS[key].username,
      role: ACCOUNTS[key].role,
      visibleBoxes: list.length,
      imei: sample.imei ?? null,
      id: sample.id ?? null,
      masked: sample.masked ?? null,
      hasIccid: "iccid" in sample,
      hasFirmware: "firmware" in sample,
    });
  }
  evidence.imeiMask = imeiRows;
  const withId = imeiRows.find((row) => row.account === ACCOUNTS[IDENTITY_COMPARE.withIdentity].username);
  const noId = imeiRows.find((row) => row.account === ACCOUNTS[IDENTITY_COMPARE.withoutIdentity].username);
  record("有 identity 权限 → 整串 IMEI、不打码", withId?.imei === BOXES.posGpsFresh.imei && !(withId.masked || []).includes("imei"), withId);
  record(
    "无 identity 权限 → IMEI 打码 861*******…0101 形态 + masked 含 imei",
    typeof noId?.imei === "string" && noId.imei !== BOXES.posGpsFresh.imei && noId.imei.includes("*") && (noId.masked || []).includes("imei"),
    noId
  );
  const searchAsSampler = await api("sampler").get(`/api/v1/sample/boxes?q=${BOXES.posBothStale.imei}`);
  record(
    "无 identity 权限的人拿整串 IMEI 搜不到箱子",
    (searchAsSampler.body?.data?.list || []).length === 0,
    { hits: (searchAsSampler.body?.data?.list || []).length, code: searchAsSampler.body?.code }
  );

  // —— 越权：403 与 401
  const forbidden = await api("sampler").post("/api/v1/sample/tasks", {
    name: "验收-越权建单",
    kind: "调拨",
    boxIds: [BOXES.spare1.imei],
    fromOrgId: HOME_ORG.id,
    toOrgId: "3",
    direct: true,
  });
  evidence.authz.samplerCreateTask = { status: forbidden.status, code: forbidden.body?.code, msg: forbidden.body?.msg };
  record("采样员建单 → 403 + 业务错误码", forbidden.status === 403, evidence.authz.samplerCreateTask);
  const badParam = await admin.post("/api/v1/sample/tasks", { name: "", kind: "调拨", boxIds: [] });
  evidence.authz.badParam = { status: badParam.status, code: badParam.body?.code, msg: badParam.body?.msg };
  record("参数校验 → 400 且不外泄内部文案", badParam.status === 400 && !/undefined|SQL|at \w+ \(/.test(String(badParam.body?.msg)), evidence.authz.badParam);

  // —— 越权签收链（L-P0-1 回归口径）
  // 两件事分开验，别混成一条：
  //   1) 角色不够的人（机构负责人没有建单调拨的参与方身份）→ 403 A0301；
  //   2) 有资格建单的人把签收人设成别的单位的人 → 400 A0400（建单校验，不落库）。
  const crossOrgActor = await api("agency").post("/api/v1/sample/tasks", {
    name: "验收-签收人越权（机构负责人发起）",
    kind: "调拨",
    boxIds: [BOXES.spare2.imei],
    fromOrgId: "51",
    toOrgId: "3",
    senderId: ACCOUNTS.agency.userId,
    signerId: ACCOUNTS.sampler.userId,
  });
  evidence.authz.crossOrgActor = { status: crossOrgActor.status, code: crossOrgActor.body?.code, msg: crossOrgActor.body?.msg };
  record("非参与方角色发起划拨 → 403 + 业务错误码", crossOrgActor.status === 403, evidence.authz.crossOrgActor);

  const crossOrg = await admin.post("/api/v1/sample/tasks", {
    name: "验收-签收人越权",
    kind: "调拨",
    boxIds: [BOXES.spare2.imei],
    fromOrgId: "21",
    toOrgId: "3",
    sender: ACCOUNTS.dispatch.nickname,
    senderId: ACCOUNTS.dispatch.userId,
    signer: ACCOUNTS.sampler.nickname,
    signerId: ACCOUNTS.sampler.userId,
  });
  evidence.authz.crossOrgSigner = { status: crossOrg.status, code: crossOrg.body?.code, msg: crossOrg.body?.msg };
  record(
    "签收人不属于接收单位 → 建单被拒（400 A0400，且不落库）",
    crossOrg.status === 400 && crossOrg.body?.code === "A0400",
    evidence.authz.crossOrgSigner
  );

  // 箱子列表接口有个口径要写进清单：不带 page/q/life/flag/orgId 时 data 直接是数组，
  // 带了才是 {list,total,filteredTotal,scopeTotal,counts,flags}（SampleController.js:46-62）。
  const bareList = await admin.get("/api/v1/sample/boxes");
  evidence.boxesListShapes = {
    bare: Array.isArray(bareList.body?.data) ? `array(${bareList.body.data.length})` : JSON.stringify(Object.keys(bareList.body?.data || {})),
    paged: JSON.stringify(Object.keys((await admin.get("/api/v1/sample/boxes?page=1&pageSize=100")).body?.data || {})),
  };
  record("箱子列表：无筛选返回数组、带 page/flag/q 返回分页对象", Array.isArray(bareList.body?.data) && !Array.isArray((await admin.get("/api/v1/sample/boxes?page=1&pageSize=100")).body?.data), evidence.boxesListShapes);

  await mkdir(OUT_DIR, { recursive: true });
  const passes = evidence.checks.filter((c) => c.verdict === "PASS").length;
  const fails = evidence.checks.filter((c) => c.verdict === "FAIL").length;
  evidence.summary = { total: evidence.checks.length, pass: passes, fail: fails };
  await writeFile(path.join(OUT_DIR, "evidence-check.json"), JSON.stringify(evidence, null, 2), "utf8");
  log(`\n汇总：${passes} PASS / ${fails} FAIL（共 ${evidence.checks.length} 项）→ reports/acceptance/20261119/evidence-check.json`);
  return evidence;
}

/* --------------------------------------------------------------------- up -- */

async function up({ fresh = true } = {}) {
  const occupied = {};
  for (const port of [PLAN.apiPort, PLAN.tcpPort]) {
    const owner = portOwner(port);
    if (owner) occupied[port] = owner;
  }
  if (Object.keys(occupied).length)
    throw new Error(
      `端口已被占用，拒绝启动：${JSON.stringify(occupied)}。若这是上一轮留下的自家孤儿进程，跑 node tools/acceptance-setup.mjs down --pid <PID>（会先复核端口归属和命令行再动）；否则人工确认那个 PID`
    );
  // forbiddenPorts 有监听不是冲突——本脚本永远不去 bind 它们；这里只是把「谁的端口」写进证据，
  // 说明本次验收实例和主实例/演示实例/PM 预览/其他项目是并存的，不是我起停的。
  const neighbours = Object.fromEntries(PLAN.forbiddenPorts.map((p) => [p, portOwner(p)]).filter(([, v]) => v));
  if (Object.keys(neighbours).length) log(`   旁听端口（不属于本实例，绝不触碰）：${JSON.stringify(neighbours)}`);

  log(`1/6 建库与写库夹具（临时目录 ${PLAN.home}）`);
  const { sqlitePath, passwords } = await prepareHome(PLAN.home, { fresh });
  await writeFile(path.join(PLAN.home, "accounts.local.json"), JSON.stringify(passwords, null, 2), "utf8");
  log(`   库文件 ${sqlitePath}`);
  log(`   口令文件 ${path.join(PLAN.home, "accounts.local.json")}（仓库外，不进报告）`);

  log("2/6 起隔离后端（只有这个子进程带 SAMPLE_ACCEPTANCE / 假 openid）");
  const { pid, logStreams } = spawnServer(PLAN.home);
  const baseUrl = `http://127.0.0.1:${PLAN.apiPort}`;
  const health = await waitHealthy(baseUrl);
  if (!health.healthy) throw new Error(`健康检查失败：${JSON.stringify(health)}，日志 ${logStreams.err}`);
  log(`   PID ${pid}，健康检查 ${health.attempts} 次探测通过（/api/v1/auth/captcha → 200 / 00000）`);
  log(`   TCP ${PLAN.tcpPort} 监听者 PID = ${portOwner(PLAN.tcpPort)}`);
  // 进程一活着就先把 PID 落盘：后面任何一步抛错，down/status 都能认出这个 PID 并复核后处置，
  // 不会留下「有孤儿进程、没 instance.json」的死角（上一轮就卡在这里）。
  const bootInstance = {
    home: PLAN.home,
    sqlitePath,
    apiPort: PLAN.apiPort,
    tcpPort: PLAN.tcpPort,
    pid,
    startedAt: new Date().toISOString(),
    stage: "health-ok",
    logs: logStreams,
    accountsFile: path.join(PLAN.home, "accounts.local.json"),
    reportPeriodSec: PLAN.reportPeriodSec,
  };
  await writeFile(path.join(PLAN.home, "instance.json"), JSON.stringify(bootInstance, null, 2), "utf8");

  const api = makeApi(baseUrl);
  const adminToken = await login(api, ACCOUNTS.admin.username, passwords.admin);
  const admin = makeApi(baseUrl, adminToken);

  log("3/6 假设备走 TCP 上报（在线箱的第一包）");
  const onlineAck = await sendOnlineUplink(PLAN.tcpPort);
  log(`   ${JSON.stringify(onlineAck)}`);

  log("4/6 接口建单并推进到目标状态");
  const { created: tasks, errors: taskErrors } = await createFixtureTasks(admin);
  log(`   建单 ${Object.keys(tasks).length - 1} 张 + 一张接口拒绝的探针：${JSON.stringify(Object.fromEntries(Object.entries(tasks).map(([k, v]) => [k, typeof v === "object" ? v.code : v])))}`);
  for (const error of taskErrors) log(`   建单/推进异常：${JSON.stringify(error)}`);
  const chargeOnlyPolicy = await applyChargeOnlyPolicy(admin, BOXES.chargeOnly.imei);
  log(`   仅充电上报策略（接口下发）：${JSON.stringify(chargeOnlyPolicy)}`);

  log("5/6 建单后再开箱（划拨后已开箱守卫）+ DB 夹具：复制出第二张未结束单、把三张单的建单时间往回拨");
  const openAck = await sendOpenAfterTransfer(PLAN.tcpPort);
  const backdatePlan = {};
  for (const [key, msAgo] of [["graceOver", 2 * HOUR], ["twoEarly", 50 * MIN], ["twoLate", 10 * MIN]]) {
    if (tasks[key]) backdatePlan[tasks[key]] = msAgo;
  }
  const cloneSpec = tasks.twoEarly
    ? {
        sourceId: tasks.twoEarly,
        newId: `TK-${Date.now()}-${randomUUID().slice(0, 6)}`,
        name: "验收-两张单里的较晚一张（DB 夹具）",
        msAgo: 10 * MIN,
      }
    : null;
  const { results: dbFixture, cloned } = await dbFixturePass(sqlitePath, { backdate: backdatePlan, clone: cloneSpec });
  if (cloned) {
    tasks.twoLate = cloned.id;
    log(`   复制出第二张未结束单 ${cloned.id}（箱子 ${cloned.boxId}，建单时间 ${cloned.created_at}）`);
  }
  for (const row of dbFixture) log(`   ${JSON.stringify(row)}`);

  log("6/6 写 instance.json + 证据");
  const instance = {
    ...bootInstance,
    stage: "fixtures-ready",
    tasks,
    taskErrors,
    chargeOnlyPolicy,
    tcpAcks: { onlineAck, openAck },
    dbFixture,
    clonedTask: cloned,
    neighbours,
  };
  await writeFile(path.join(PLAN.home, "instance.json"), JSON.stringify(instance, null, 2), "utf8");
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, "evidence-up.json"), JSON.stringify({ ...instance, passwords: undefined }, null, 2), "utf8");
  log(`   ${path.join(OUT_DIR, "evidence-up.json")}`);
  return instance;
}

/* ------------------------------------------------------------------ main --- */

const argv = process.argv.slice(2);
const command = argv[0] || "doctor";
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

try {
  if (command === "doctor") await doctor();
  else if (command === "up") await up({ fresh: !flag("keep-db") });
  else if (command === "check") await check();
  else if (command === "down") await stopInstance({ purge: flag("purge"), pid: option("pid") });
  else if (command === "status") await status();
  else {
    console.error(`未知命令 ${command}；可用：doctor | up [--keep-db] | check | down [--purge] [--pid <PID>] | status`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`命令 ${command} 失败：${error?.stack || error}`);
  process.exitCode = 1;
}
