/**
 * 演示数据种子：建一个本地临时 SAMPLE_HOME（非线上），按真实业务编一套虚构演示数据。
 * 用法: node tools/seed-demo.mjs [homeDir]  → 打印 home 路径；随后 SAMPLE_HOME=<home> PORT=8002 node server/index.js
 * 单位/人名/箱号均虚构。复用 server 的 openDatabase/migrate/hashPassword。
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { openDatabase, migrate } from "../server/db.js";
import { hashPassword } from "../server/auth.js";
import { Uplink } from "../server/src/domain/Uplink.js";

const home = process.argv[2] || (await mkdtemp(path.join(os.tmpdir(), "sample-demo-")));
await mkdir(home, { recursive: true });
// 组织简化（B4a）：唯一检测站＝6 总部检测站（type=检测站，挂总公司下），config 显式指定
const config = { dialect: "sqlite", sqlitePath: path.join(home, "sample.db"), host: "", port: 3306, user: "", password: "", database: "", secret: randomBytes(24).toString("hex"), box: { reportPeriodSec: 600, stationDeptId: "6" } };
await writeFile(path.join(home, "db.config.json"), JSON.stringify(config, null, 2));
await writeFile(path.join(home, "install.lock"), new Date().toISOString());
const db = await openDatabase(config, process.cwd());
const now = Date.now();
const pad = (n) => String(n).padStart(2, "0");
// 服务器写库用本地时间字符串，种子同口径，范围查询（电量/事件）才比对得上
const iso = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const day = (offset) => { const d = new Date(now + offset * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

try {
  await migrate(db);
  const tx = async (fn) => db.transaction(fn);
  await tx(async (t) => {
    // 单位：集团→华南(调度室/仓库)/华东；总公司下唯一总部检测站；鹏城采样服务队(现场一/二组)
    // 组织简化（B4a）：无采样机构层——分公司（公司类型）自采；检测站全局唯一（6，type=检测站）；
    // 原 7 深圳检测站删除（第二检测站违反唯一性），其历史任务改寄 6。
    // 总览按顶级公司+任意层级检测站列单位。
    const depts = [
      ["1", "0", "智采环境检测集团", "公司", 1],
      ["2", "0", "华南分公司", "公司", 2],
      ["21", "2", "调度室", "公司", 1],
      ["22", "2", "仓库", "公司", 2],
      ["3", "0", "华东分公司", "公司", 3],
      ["6", "1", "总部检测站", "检测站", 4],
      ["8", "0", "鹏城环境采样服务队", "公司", 6],
      ["81", "8", "现场一组", "公司", 1],
      ["82", "8", "现场二组", "公司", 2],
    ];
    for (const [id, parent, name, type, sort] of depts)
      await t.run("INSERT INTO sys_dept (id,parent_id,name,code,sort,status,type) VALUES (?,?,?,?,?,1,?)", [id, parent, name, `D${id}`, sort, type]);
    // 人员（密码统一 demo1234，仅演示）
    // 组织简化（B4a/P3）：王立新改绑 BRANCH_ADMIN（AGENCY_LEAD 废弃，056 存量同口径）
    const pw = hashPassword("demo1234");
    const users = [
      ["1", "zhoulan", "周岚", "1", "ADMIN"],
      ["2", "chenke", "陈可", "21", "DISPATCH"],
      ["3", "huangzhiqiang", "黄志强", "22", "ASSET"],
      ["4", "wanglixin", "王立新", "6", "BRANCH_ADMIN"],
      ["5", "linxia", "林夏", "81", "SAMPLER"],
      ["6", "zhaoyiming", "赵一鸣", "81", "SAMPLER"],
      ["7", "liusiyuan", "刘思远", "1", "HOME_SWITCH"],
    ];
    for (const [id, username, nickname, dept, role] of users)
      await t.run("INSERT INTO sys_user (id,username,nickname,password_hash,dept_id,status) VALUES (?,?,?,?,?,1)", [id, username, nickname, pw, dept]);
    // 角色 + 默认权限（复用 permCatalog），采样员改本单位范围+任务权限
    const { DEFAULT_ROLE_PERMS } = await import("../server/src/auth/permCatalog.js");
    const scopeOf = { ADMIN: 1, HOME_SWITCH: 1, SAMPLER: 2, DISPATCH: 2, ASSET: 2, BRANCH_ADMIN: 2, LEADER: 2, DUTY: 2, VERIFY: 2 };
    const roleIds = [];
    let ri = 900;
    for (const code of Object.keys(DEFAULT_ROLE_PERMS)) {
      const id = String(ri++);
      await t.run("INSERT INTO sys_role (id,name,code,data_scope,sort,status) VALUES (?,?,?,?,?,1)", [id, code, code, scopeOf[code] ?? 2, ri]);
      for (const perm of DEFAULT_ROLE_PERMS[code]) await t.run("INSERT INTO sys_role_perm (role_id,perm) VALUES (?,?)", [id, perm]);
      roleIds.push({ id, name: code });
    }
    const rid = (name) => (roleIds.find((r) => r.name === name) || roleIds[0]).id;
    for (const [id, , , , role] of users)
      await t.run("INSERT INTO sys_user_role (user_id,role_id) VALUES (?,?)", [id, rid(role)]);
    // 采样箱 16 台 ZC-SZ-001..016，多状态
    const boxes = [];
    const boxMeta = new Map();
    const statuses = ["未使用", "在途", "未使用", "在途", "待激活", "未使用", "在途", "未使用", "停用", "未使用", "在途", "未使用", "待激活", "未使用", "在途", "未使用"];
    // 001 号原属仓库 22，T09 划拨（22→2）提交即生效 → 现归属华南 2（快照仍留原单位）
    const orgOf = ["2", "2", "22", "3", "22", "22", "8", "22", "22", "3", "8", "22", "22", "22", "2", "22"];
    // 保管人：003/004 号曾由林夏保管、建任务后移交单位（快照仍留林夏，工作台口径案例）；010/014 号现由林夏保管
    const ownerOf = (i) =>
      i === 2 || i === 3 ? ["", ""] : i === 9 || i === 13 ? ["林夏", "5"] : i % 3 === 0 ? ["黄志强", "3"] : ["", ""];
    for (let i = 0; i < 16; i++) {
      const id = `ZC-SZ-${String(i + 1).padStart(3, "0")}`;
      const life = statuses[i];
      const offline = i === 4 || i === 8;
      const low = i === 5 || i === 12;
      const alert = i === 6 ? "温度异常" : "";
      const lid = i === 6 ? 1 : 0;
      const mv = low ? 3300 : 3900 - (i % 5) * 40;
      const last = offline ? iso(now - 3 * 86400000) : iso(now - (i % 4) * 60000 - 30000);
      const lng = 114.0 + (i % 8) * 0.03;
      const lat = 22.5 + (i % 6) * 0.02;
      const [owner, ownerId] = ownerOf(i);
      boxes.push(id);
      boxMeta.set(id, { orgId: orgOf[i], ownerId });
      await t.run(
        `INSERT INTO sample_box (id,imei,iccid,imsi,firmware,org,org_id,owner,owner_id,life,alert,battery,battery_mv,csq,last_report_at,lbs,gps,gps_lng,gps_lat,lbs_lng,lbs_lat,opens,activate_step,powered_at,lid)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, `86431708099${String(1000 + i)}`, `898600${i}`, `46000${i}`, "1.0.17", "智采环境检测集团", orgOf[i], owner, ownerId, life, alert, "", mv, offline ? 0 : 20 + (i % 5), last, "", "", lng, lat, lng, lat, i % 4, life === "待激活" ? "等待激活" : "已确认", iso(now - 86400000), lid]
      );
    }
    // 任务 12 张覆盖合并流 7 步＋分支＋划拨（组织简化 B4a）：
    // 采样＝合并单（采样＋送检一张，TK-），接收方固定唯一检测站 6、inspect 恒真、trip 作废不写；
    // 划拨 AL- 提交即生效（T09，箱子归属已转）。旧调拨/送检 kind 不再构造。
    const tasks = [
      ["T01", "龙华民治土壤采样", "采样", "采样中", "8", "6"],
      ["T02", "宝安西乡河水质采样", "采样", "待采样", "8", "6"],
      ["T03", "光明农田土壤采样", "采样", "待检测", "8", "6"],
      ["T04", "华南→总部 采样寄检", "采样", "在途", "2", "6"],
      ["T05", "华东→总部 采样寄检", "采样", "待签收", "3", "6"],
      ["T06", "华南寄检·土壤重金属", "采样", "待检测", "2", "6"],
      ["T07", "华东寄检·水质复核", "采样", "已检测", "3", "6"],
      ["T08", "鹏城采样复测", "采样", "已封箱", "8", "6"],
      ["T09", "仓库→华南 划拨", "划拨", "已划拨", "22", "2"],
      ["T10", "已检测采样归档", "采样", "已检测", "8", "6"],
      ["T11", "拒收退回案例", "采样", "退回中", "2", "6"],
      ["T12", "开箱超限案例", "采样", "待签收", "3", "6"],
    ];
    const nameOf = Object.fromEntries(depts.map(([id, , name]) => [id, name]));
    let bi = 0;
    for (const [id, name, kind, status, from, to] of tasks) {
      const ids = [boxes[bi % 16], boxes[(bi + 1) % 16]]; bi += 2;
      // 合并单采样单位＝寄出分公司本身（org/orgId 与 from 同）；划拨无采样段
      const body = { name, kind, inspect: kind === "采样", boxIds: ids, fromOrg: nameOf[from], org: nameOf[from], orgId: from, toOrg: nameOf[to], toOrgId: to, fromOrgId: from, maxOpens: 2, sample: kind === "采样" ? "表层土壤（0–20 cm）五点混合样 3 份，每份约 1 kg，聚乙烯密封袋；检测铅、镉、汞、砷、pH" : undefined, placeAt: kind === "采样" ? { address: "深圳市龙华区民治街道", lng: 114.03, lat: 22.62, radiusM: 500 } : undefined };
      await t.run("INSERT INTO sample_task (id,name,kind,status,body,from_org_id,to_org_id,created_at) VALUES (?,?,?,?,?,?,?,?)", [id, name, kind, status, JSON.stringify(body), from, to, iso(now - (12 - Number(id.slice(1))) * 3600000)]);
      for (const b of ids) {
        const inspected = status === "已检测" ? iso(now - 3600000) : null;
        // 建任务时快照箱子当时的单位/保管人（与线上 create 同口径）；T02 的箱子当时归林夏保管
        const snap = id === "T02" ? { orgId: boxMeta.get(b).orgId, ownerId: "5" } : boxMeta.get(b);
        await t.run("INSERT INTO sample_task_box (task_id,box_id,opens_start,opens_end,inspected_at,inspected_by,org_id,owner_id) VALUES (?,?,?,?,?,?,?,?)", [id, b, 0, id === "T12" ? 3 : 1, inspected, inspected ? "王立新" : null, snap.orgId, snap.ownerId]);
      }
      await t.run("INSERT INTO sample_task_log (task_id,status,action,actor_name,created_at) VALUES (?,?,?,?,?)", [id, status, "创建", "陈可", iso(now - 86400000)]);
    }
    // 上报：给两台箱造 7 天电量+轨迹点（供曲线/轨迹截图）；近 24 小时每 10 分钟一点，电量各时间档都有数据
    for (const b of [boxes[0], boxes[1]]) {
      const imei = `86431708099${String(1000 + boxes.indexOf(b))}`;
      const put = async (at, mv, chg, lng, lat, extra = {}) => {
        // 稀疏老报文不带计数字段，避免和连续报文的 opens/lid/seq 前态互相污染
        const fields = [`why=timer`, `bat=${mv}`, `chg=${chg}`];
        if (extra.opens != null) fields.push(`opens=${extra.opens}`);
        if (extra.lid != null) fields.push(`lid=${extra.lid}`);
        if (extra.seq != null) fields.push(`seq=${extra.seq}`);
        fields.push(`csq=22`);
        const uart = fields.join(",");
        // 摘要与线上 ingest 同口径（UplinkRecord 存 digest）：定时上报 · seq N · X.XX V · 开/关着
        const summary = new Uplink({ why: "timer", vbat: mv, lid: extra.lid, seq: extra.seq }).digest;
        await t.run("INSERT INTO sample_uplink (box_id,imei,received_at,kind,summary,raw,device_time,gps_lng,gps_lat) VALUES (?,?,?,?,?,?,?,?,?)", [b, imei, iso(at), "timer", summary, Buffer.from(uart), iso(at), lng, lat]);
      };
      for (let h = 0; h < 7 * 24; h += 5) {
        const at = now - (7 * 24 - h) * 3600000;
        const mv = 3900 - (h % 48) * 8 + (h % 96 < 12 ? 200 : 0);
        await put(at, mv, h % 96 < 12 ? 1 : 0, 114.03 + (h % 20) * 0.002, 22.62 + (h % 15) * 0.002);
      }
      // 连续上报模式：事件只藏在字段变化里（开箱计数、箱盖、seq 复位、插拔充电器），验证 kindOf 补判
      for (let m = 0; m < 24 * 60; m += 10) {
        const at = now - (24 * 60 - m) * 60000;
        const mv = 3860 - Math.round(m * 0.55) + (m % 120 < 20 ? 60 : 0);
        const seq = m < 600 ? 1000 + m / 10 : 1 + (m - 600) / 10;
        const opens = m < 300 ? 0 : m < 900 ? 1 : 2;
        const lid = m >= 300 && m < 360 ? 1 : 0;
        await put(at, mv, m % 120 < 20 ? 1 : 0, 114.03 + (m % 20) * 0.002, 22.62 + (m % 15) * 0.002, { seq, opens, lid });
      }
    }
  });
  await writeFile(path.join(home, "demo-password.txt"), "demo1234");
  console.log(home);
} finally {
  await db.close();
}