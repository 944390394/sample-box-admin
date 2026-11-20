/**
 * 验收机器人的测试数据。全部写进临时目录里的新库，和开发库、线上无关。
 * 分三步：服务端启动前直接写库（组织、账号、箱子、历史上报）；
 * 启动后用假设备走 TCP 真实上报；再用管理员账号调接口建任务单。
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { hashPassword } from "../../server/auth.js";
import { migrate, openDatabase, seedOrg } from "../../server/db.js";
import { seedRolePerms } from "../../server/src/auth/boxAccess.js";
import { upgradeCodes } from "../../server/src/auth/permCatalog.js";
import { formatTimestamp } from "../../server/src/domain/Clock.js";
import { UplinkBatch } from "../../server/src/store/UplinkBatch.js";

/** 验收用的箱子。名字里写明它代表哪种情况，截图一看就懂。 */
export const BOXES = {
  fresh: { imei: "860000000000001", name: "验收-GPS新" },
  staleGps: { imei: "860000000000002", name: "验收-GPS旧基站新" },
  lbsOnly: { imei: "860000000000003", name: "验收-只有基站" },
  offline: { imei: "860000000000004", name: "验收-离线" },
  lowLid: { imei: "860000000000005", name: "验收-低电开盖" },
  pending: { imei: "860000000000009", name: "" },
  // 寄总部检测站的两台（合并采样单）：A 途中开了 1 次箱，B 开了 3 次（任务上限 2 次，签收时标超限）
  inspectA: { imei: "860000000000006", name: "验收-送检A" },
  inspectB: { imei: "860000000000007", name: "验收-送检B" },
  // 寄检测站途中开箱超限、待拒收退回的一台
  back: { imei: "860000000000008", name: "验收-退回箱" },
};

/** 总部检测站（组织简化 B4a/P5）：新种子 13＝总部检测站 type=检测站、挂总公司 1 下；config 显式指定。 */
export const STATION = { id: "13", name: "总部检测站" };

/** 角色和账号。密码每次随机生成，只在机器人进程里用，不写进报告。 */
export const ACCOUNTS = {
  admin: { userId: "2", username: "admin", label: "系统管理员" },
  dispatch: { userId: "6", username: "chen.ke", label: "调度员" },
  sampler: { userId: "7", username: "lin.xia", label: "现场采样员" },
  taskOnly: { userId: "90", username: "accept.task", label: "只看任务轨迹" },
  roleEditor: { userId: "91", username: "accept.editor", label: "能编辑角色、不能分配权限" },
  southPeople: { userId: "92", username: "accept.south", label: "华南人员管理" },
};

/** 授权界面验收用的角色（没有人用它，随便改）。 */
export const GRANTER_ROLE = { id: "93", name: "验收-授权员" };

/**
 * 华东分公司的人员样本（id 94，挂 31 华东调度室，角色 13 调度员）。
 * 历史用途：批次 A 收紧「寄出人/签收人必须是那一单位的人」后，调拨到华东（org 3）的单子
 * 必须用华东的人签收（shared/org.js 的 3/31 下 originally 一个用户都没有）。
 * 组织简化（B4a）后调拨新建退役、划拨无签收人，此账号保留为华东人员样本
 * （seed-verify §4 仍核对 31 下有人），不再参与建单。
 */
export const EAST_SIGNER = { userId: "94", username: "accept.east", nickname: "验收华东签收", deptId: "31", label: "华东签收人" };

const HOME_ORG = { id: "21", name: "调度室" };
const SZ = { lng: 114.0579, lat: 22.5431 };

const at = (msAgo) => formatTimestamp(new Date(Date.now() - msAgo));
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 建临时环境：配置、安装标记、库表、组织、账号、箱子、历史上报。返回各账号的随机密码。 */
export async function prepareHome(home) {
  await mkdir(home, { recursive: true });
  const sqlitePath = path.join(home, "sample.db");
  // 组织简化（B4a）：唯一检测站显式写 config（13 总部检测站，新种子 type=检测站，不再改类型）
  const config = { dialect: "sqlite", sqlitePath, host: "", port: 3306, user: "", password: "", database: "", secret: randomBytes(24).toString("hex"), box: { reportPeriodSec: 600, stationDeptId: STATION.id, enableTransferInspect: true } };
  await writeFile(path.join(home, "db.config.json"), JSON.stringify(config, null, 2), "utf8");
  await writeFile(path.join(home, "install.lock"), new Date().toISOString(), "utf8");

  const db = await openDatabase(config, process.cwd());
  try {
    await migrate(db);
    await seedOrg(db);
    await seedRolePerms(db);
    const passwords = await seedAccounts(db);
    await seedBoxes(db);
    return passwords;
  } finally {
    await db.close();
  }
}

async function seedAccounts(db) {
  const now = new Date().toISOString();
  // 只看任务轨迹：能看箱子、任务和当前位置，没有「历史轨迹」
  await db.run("INSERT INTO sys_role (id, name, code, data_scope, sort, status, create_time, update_time) VALUES ('90', '验收-只看任务轨迹', 'ACCEPT_TASK', 1, 90, 1, ?, ?)", [now, now]);
  for (const perm of upgradeCodes(["device:box:list", "device:box:detail", "device:box:task", "device:box:location", "device:box:status", "device:box:event"])) {
    await db.run("INSERT INTO sys_role_perm (role_id, perm) VALUES ('90', ?)", [perm]);
  }
  // 能编辑角色、不能分配权限
  await db.run("INSERT INTO sys_role (id, name, code, data_scope, sort, status, create_time, update_time) VALUES ('91', '验收-角色编辑', 'ACCEPT_EDITOR', 2, 91, 1, ?, ?)", [now, now]);
  for (const perm of ["sys:role:view", "sys:role:create", "sys:role:update", "sys:role:delete", "device:box:list"]) {
    await db.run("INSERT INTO sys_role_perm (role_id, perm) VALUES ('91', ?)", [perm]);
  }
  // 华南的人员管理：能看、编辑、停用、删除人员；华南收回「删除人员」后应该删不了
  await db.run("INSERT INTO sys_role (id, name, code, data_scope, sort, status, create_time, update_time) VALUES ('92', '验收-人员管理', 'ACCEPT_PEOPLE', 2, 92, 1, ?, ?)", [now, now]);
  for (const perm of ["sys:user:view", "sys:user:update", "sys:user:disable", "sys:user:delete"]) {
    await db.run("INSERT INTO sys_role_perm (role_id, perm) VALUES ('92', ?)", [perm]);
  }
  // 授权员：有「给角色分配权限」，所以角色页显示「可转授」列；没有人用，验收时随便改
  await db.run("INSERT INTO sys_role (id, name, code, data_scope, sort, status, create_time, update_time) VALUES (?, ?, 'ACCEPT_GRANTER', 3, 93, 1, ?, ?)", [GRANTER_ROLE.id, GRANTER_ROLE.name, now, now]);
  for (const perm of ["sys:role:view", "sys:role:grant", "device:box:list", "device:box:detail"]) {
    await db.run("INSERT INTO sys_role_perm (role_id, perm) VALUES (?, ?)", [GRANTER_ROLE.id, perm]);
  }
  for (const [id, username, nickname, dept, role] of [
    ["90", "accept.task", "验收任务方", "21", "90"],
    ["91", "accept.editor", "验收角色编辑", "21", "91"],
    ["92", "accept.south", "验收华南人事", "21", "92"],
  ]) {
    await db.run("INSERT INTO sys_user (id, username, nickname, password_hash, dept_id, status, create_time, update_time) VALUES (?, ?, ?, 'x', ?, 1, ?, ?)", [id, username, nickname, dept, now, now]);
    await db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, ?)", [id, role]);
  }
  // 华东签收人：只当调拨单的签收人用，不登录（password_hash 占位），所以不进 passwords
  await db.run("INSERT INTO sys_user (id, username, nickname, password_hash, dept_id, status, create_time, update_time) VALUES (?, ?, ?, 'x', ?, 1, ?, ?)", [EAST_SIGNER.userId, EAST_SIGNER.username, EAST_SIGNER.nickname, EAST_SIGNER.deptId, now, now]);
  await db.run("INSERT INTO sys_user_role (user_id, role_id) VALUES (?, '13')", [EAST_SIGNER.userId]);
  const passwords = {};
  for (const [key, account] of Object.entries(ACCOUNTS)) {
    const password = `Acc-${randomBytes(9).toString("base64url")}9a`;
    passwords[key] = password;
    await db.run("UPDATE sys_user SET password_hash = ?, must_change_password = 0, password_changed_at = ? WHERE id = ?", [hashPassword(password), now, account.userId]);
  }
  return passwords;
}

async function seedBoxes(db) {
  const base = { org: HOME_ORG.name, org_id: HOME_ORG.id, activate_step: "已确认", firmware: "1.0.14", iccid: "898600000000000000", imsi: "460000000000000", powered_at: at(7 * DAY), battery_model: "" };
  const insert = async (fields) => {
    const row = { ...base, ...fields };
    const keys = Object.keys(row);
    await db.run(`INSERT INTO sample_box (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, keys.map((k) => row[k]));
  };
  // 系统默认上报周期设成 10 分钟（见上面的 box），机器人跑几分钟箱子也一直算在线
  await insert({ id: BOXES.fresh.imei, imei: BOXES.fresh.imei, name: BOXES.fresh.name, life: "在途", owner: "林夏", owner_id: "7", policy_period_sec: 600 });
  // 你截图里的情况：GPS 三天前定到、之后一直在室内，基站每次上报都在更新
  await insert({
    id: BOXES.staleGps.imei, imei: BOXES.staleGps.imei, name: BOXES.staleGps.name, life: "在途", policy_period_sec: 600,
    gps: "", gps_lng: 114.116921, gps_lat: 22.678402, gps_address: "广东省深圳市龙岗区平湖街道平新北路133号",
    gps_info: JSON.stringify({ speed: 4.6999998, course: 213.4, alt: 61.3, sats: 7, hdop: 1.27, at: at(3 * DAY + 2 * HOUR) }),
  });
  await insert({ id: BOXES.lbsOnly.imei, imei: BOXES.lbsOnly.imei, name: BOXES.lbsOnly.name, life: "未使用", policy_period_sec: 600 });
  await insert({
    id: BOXES.offline.imei, imei: BOXES.offline.imei, name: BOXES.offline.name, life: "未使用", last_report_at: at(2 * DAY), battery: "3.71V", battery_mv: 3710, csq: 12,
    lbs: "深圳", lbs_lng: 114.0601, lbs_lat: 22.5412, lbs_at: at(2 * DAY), lbs_address: "广东省深圳市福田区福华路",
  });
  await insert({ id: BOXES.lowLid.imei, imei: BOXES.lowLid.imei, name: BOXES.lowLid.name, life: "在途", policy_period_sec: 600 });
  // 送检的两台：A 途中开了 1 次箱，B 开了 3 次（任务上限 2 次，签收时标超限）
  await insert({ id: BOXES.inspectA.imei, imei: BOXES.inspectA.imei, name: BOXES.inspectA.name, life: "未使用", opens: 0, policy_period_sec: 600, last_report_at: at(2 * MIN), battery: "3.95V", battery_mv: 3950 });
  await insert({ id: BOXES.inspectB.imei, imei: BOXES.inspectB.imei, name: BOXES.inspectB.name, life: "未使用", opens: 0, policy_period_sec: 600, last_report_at: at(2 * MIN), battery: "3.90V", battery_mv: 3900 });
  await insert({ id: BOXES.back.imei, imei: BOXES.back.imei, name: BOXES.back.name, life: "未使用", opens: 0, lid: 0, policy_period_sec: 600, last_report_at: at(2 * MIN), battery: "4.00V", battery_mv: 4000 });

  // 「GPS 新」这台补 7 天、每 5 分钟一条的历史上报：轨迹和电量曲线有东西看，
  // 7 天视图超过 360 个点会按段合并，正好验合并后曲线连不连得上。第 3 天停报 3 小时，那里应该断开一次。
  const batch = new UplinkBatch(db);
  const total = 7 * 24 * 12;
  for (let i = total; i >= 1; i--) {
    if (i > 4 * 24 * 12 && i <= 4 * 24 * 12 + 36) continue;
    const t = new Date(Date.now() - i * 5 * MIN);
    const step = total - i;
    const recent = i <= 36;
    const lng = SZ.lng + (recent ? (36 - i) * 0.0021 : 0);
    const lat = SZ.lat + (recent ? (36 - i) * 0.0009 + Math.sin(i / 3) * 0.0006 : 0);
    // 先放电，第 5 天充一次电再放
    const charging = step > 4 * 288 && step <= 4 * 288 + 36;
    const vbat = charging ? 3700 + (step - 4 * 288) * 13 : step <= 4 * 288 ? 4150 - Math.round(step * 0.4) : 4150 - Math.round((step - 4 * 288 - 36) * 0.5);
    const chg = charging ? 1 : 0;
    const raw = JSON.stringify({ imei: BOXES.fresh.imei, uart: `why=timer,bat=${vbat},chg=${chg},lid=0,opens=2`, gpsfix: recent ? 1 : 0, lng, lat, vbat, csq: 21, time: formatTimestamp(t) });
    await batch.add({ boxId: BOXES.fresh.imei, imei: BOXES.fresh.imei, receivedAt: formatTimestamp(t), deviceTime: formatTimestamp(t), kind: "timer", summary: `定时上报 · ${(vbat / 1000).toFixed(2)}V`, raw, lbsLng: lng + 0.003, lbsLat: lat - 0.002, gpsLng: recent ? lng : null, gpsLat: recent ? lat : null });
  }
  // 「只有基站」这台过去 10 小时反复重启 8 次（像插拔 USB、烧录）：工作台动态里应该合成一条「上电 8 次」
  for (let i = 1; i <= 8; i++) {
    const t = new Date(Date.now() - (i * 70 + 30) * MIN);
    const raw = JSON.stringify({ imei: BOXES.lbsOnly.imei, uart: "why=boot,bat=4010,chg=1,lid=0,opens=0", vbat: 4010, csq: 9, time: formatTimestamp(t) });
    await batch.add({ boxId: BOXES.lbsOnly.imei, imei: BOXES.lbsOnly.imei, receivedAt: formatTimestamp(t), deviceTime: formatTimestamp(t), kind: "boot", summary: "上电上报 · 4.01V", raw, lbsLng: 114.0712, lbsLat: 22.5523, gpsLng: null, gpsLat: null });
  }
  await batch.flush();
}

/** 一包设备上报，字段和银尔达模板一致。 */
function packet(imei, { uart, gps, lbs, csq = 20, vbat }) {
  const body = { imei, iccid: "898600000000000000", imsi: "460000000000000", csq, time: formatTimestamp(new Date()), uart, gpsfix: gps ? 1 : 0, lbslng: lbs ? String(lbs.lng) : "000.0000000", lbslat: lbs ? String(lbs.lat) : "000.0000000" };
  if (gps) Object.assign(body, { lng: gps.lng, lat: gps.lat, speed: 12.3, course: 88, alt: 40.2, sats: 9, hdop: 0.9 });
  body.vbat = vbat || Number(/bat=(\d+)/.exec(uart)?.[1]) || undefined;
  return JSON.stringify(body);
}

/** 假设备：连上 TCP 接入口，把各箱子这一次的上报发出去，等服务端回确认。 */
export async function sendLiveUplinks(tcpPort) {
  const last = { lng: SZ.lng + 35 * 0.0021, lat: SZ.lat + 35 * 0.0009 };
  const packets = [
    packet(BOXES.fresh.imei, { uart: "why=timer,bat=3840,chg=0,lid=0,opens=2", gps: last, lbs: { lng: last.lng + 0.003, lat: last.lat - 0.002 }, csq: 22 }),
    packet(BOXES.staleGps.imei, { uart: "why=timer,bat=3920,chg=1,lid=0,opens=1", lbs: { lng: 114.117665, lat: 22.67469 }, csq: 17 }),
    packet(BOXES.lbsOnly.imei, { uart: "why=timer,bat=4010,chg=0,lid=0,opens=0", lbs: { lng: 114.0712, lat: 22.5523 }, csq: 9 }),
    packet(BOXES.lowLid.imei, { uart: "why=pad,bat=3360,chg=0,lid=1,opens=5", gps: { lng: 114.0301, lat: 22.6204 }, lbs: { lng: 114.0322, lat: 22.6187 }, csq: 14 }),
    packet(BOXES.pending.imei, { uart: "why=boot,bat=3990,chg=0,lid=0,opens=0", lbs: { lng: 114.05, lat: 22.55 } }),
  ];
  await sendPackets(tcpPort, packets);
}

/** 送检的两台在途中开箱：A 开 1 次，B 开 3 次（超过上限 2 次）。寄出之后、签收之前发。 */
export async function sendInspectOpens(tcpPort) {
  await sendPackets(tcpPort, [
    packet(BOXES.inspectA.imei, { uart: "why=pad,bat=3950,chg=0,lid=1,opens=1", lbs: { lng: 114.06, lat: 22.55 } }),
    packet(BOXES.inspectB.imei, { uart: "why=pad,bat=3900,chg=0,lid=1,opens=3", lbs: { lng: 114.06, lat: 22.55 } }),
    // 退回箱：途中开过 1 次、现在关着；任务上限 0 次，签收核验会拦下
    packet(BOXES.back.imei, { uart: "why=shut,bat=4000,chg=0,lid=0,opens=1", lbs: { lng: 114.06, lat: 22.55 } }),
  ]);
}

async function sendPackets(tcpPort, packets) {
  for (const text of packets) {
    await new Promise((resolve, reject) => {
      const socket = net.connect(tcpPort, "127.0.0.1");
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, 3000);
      socket.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on("data", () => {
        clearTimeout(timer);
        socket.end();
        resolve();
      });
      socket.write(text);
    });
  }
}

/**
 * 用管理员账号调接口建任务单（组织简化 B4a 口径）：
 * 一张划拨（AL-，GPS 新 + GPS 旧两台，提交即生效）、一张合并采样单（低电开盖那台，停待采样）、
 * 两张寄检测站的合并采样单（一台推到在途待签收——run.mjs 再强制签收进待检测；一台开箱超限拒收退回）。
 * 通用建单端点只收 kind=采样（接收方固定唯一检测站 13）；调拨/送检新建已退役。
 *
 * **逐张容错**：建单接口会因「寄出人/签收人必须是那一单位的人」等规则返回 A0400，
 * 一张建不出来不能把整个数据准备阶段打断（`run.mjs` 原来没有 try/catch，机器人直接中止）。
 * 现在每张单单独尝试，失败原因（业务码 + 服务端原文）如实记进返回值，由 `run.mjs` 落到证据里；
 * 后续依赖某张单的步骤拿不到 id 就跳过并记一条失败，不抛异常。
 *
 * 返回：`{ transfer, sample, inspect, back, seeded[], failures[], skipped[] }`
 */
export async function createTasks(api) {
  const seeded = [];
  const failures = [];
  const skipped = [];
  const out = { transfer: null, sample: null, inspect: null, back: null, seeded, failures, skipped };

  /** 建一张单：成功记 id 和单号，失败记业务码与服务端原文 */
  const create = async (key, label, body, endpoint = "/api/v1/sample/tasks") => {
    try {
      const task = await api.post(endpoint, body);
      out[key] = task.id;
      // 建单接口只回 id（`ctx.ok({ id })`），单号/状态由 seed-verify 再拉一次详情取证
      seeded.push({ key, label, id: task.id });
      return task;
    } catch (error) {
      failures.push({ key, label, stage: "建单", code: error.code || "", reason: error.message });
      return null;
    }
  };

  /** 推进状态：拿不到那张单就跳过（并说明是被建单失败连累的），失败也只记录 */
  const advance = async (key, label, id, status, note) => {
    if (!id) {
      skipped.push({ key, label, stage: `推进到${status}`, reason: "这张单没建出来，跳过" });
      return;
    }
    try {
      await api.put(`/api/v1/sample/tasks/${id}/status`, { status, note });
    } catch (error) {
      failures.push({ key, label, stage: `推进到${status}`, code: error.code || "", reason: error.message });
    }
  };

  // 划拨（提交即生效，无物流步骤、无签收人）：两台箱子归属立即转到华东 3。
  // 带 SAMPLE_ACCEPTANCE_BREAK_TRANSFER=1 时故意把目标改成检测站 13（P8 闸门拒绝），
  // 验证「一张单失败不中止整个准备」这条容错路径。
  await create("transfer", "验收-划拨深圳到杭州", {
    name: "验收-划拨深圳到杭州",
    toOrgId: process.env.SAMPLE_ACCEPTANCE_BREAK_TRANSFER === "1" ? STATION.id : "3",
    boxIds: [BOXES.fresh.imei, BOXES.staleGps.imei],
  }, "/api/v1/sample/transfers");

  // 合并采样单（分公司自采）：采样单位＝寄出分公司调度室 21，接收方服务端固定 13
  await create("sample", "验收-龙华采样", {
    name: "验收-龙华采样",
    kind: "采样",
    boxIds: [BOXES.lowLid.imei],
    fromOrgId: HOME_ORG.id,
    sender: "陈可",
    signer: "吴迪",
    placeAt: { address: "深圳市龙华区民治街道", lng: 114.0301, lat: 22.6204, radiusM: 500 },
  });

  // 寄检测站（合并单）：调度室寄到总部检测站，上限开箱 2 次；推到在途后两台在途中开箱，
  // run.mjs 再推进待签收、强制签收（B 开箱超限）进待检测
  const inspect = await create("inspect", "验收-送检总部", {
    name: "验收-送检总部",
    kind: "采样",
    boxIds: [BOXES.inspectA.imei, BOXES.inspectB.imei],
    fromOrgId: HOME_ORG.id,
    senderId: ACCOUNTS.dispatch.userId,
    // 检测站（13）的签收人是吴迪（user 5），admin 不在这个单位
    signerId: "5",
    maxOpens: 2,
  });
  for (const status of ["采样中", "已封箱", "在途"])
    await advance("inspect", "验收-送检总部", inspect?.id, status, "");

  // 拒收退回：一路开箱上限 0 次，寄出后开过一次箱，检测站扫码时只能拒收或强制签收
  const back = await create("back", "验收-拒收退回", {
    name: "验收-拒收退回",
    kind: "采样",
    boxIds: [BOXES.back.imei],
    fromOrgId: HOME_ORG.id,
    senderId: ACCOUNTS.dispatch.userId,
    signerId: "5",
    maxOpens: 0,
  });
  for (const status of ["采样中", "已封箱", "在途"])
    await advance("back", "验收-拒收退回", back?.id, status, "");

  return out;
}
