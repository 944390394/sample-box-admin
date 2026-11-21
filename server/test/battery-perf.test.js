/**
 * 估算总电量图切换卡顿修复（服务端）回归。
 * 根因＝listBattery 全量拉行＋逐行 gunzipSync 同步阻塞事件循环（7 天真机 ~7 万行）。
 * 钉死：1) 分页＋分块解码后输出与旧全量算法逐字段等价（含补传/窗口外行/充电态/startFull）；
 *       2) 解码期间事件循环不被长阻塞（心跳最大间隔 <150ms）；
 *       3) 按箱缓存：子范围切换命中（不再全量 SELECT raw），新上报/删行使守卫失效后重建；
 *       4) 端点点数上限（360 段＋空点 ≤720）＋ X-Battery-Point-Count/X-Battery-Raw-Count 头，数组形状不变。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { migrate, openDatabase } from "../db.js";
import { formatTimestamp } from "../src/domain/Clock.js";
import { chargeFromRaw, uplinkText } from "../src/domain/BatterySeries.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { SampleController } from "../src/http/SampleController.js";

const BOX = "860000000000901";
const pad = (n, w = 2) => String(n).padStart(w, "0");
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

async function makeDb() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "battery-perf-"));
  const db = await openDatabase({ dialect: "sqlite", sqlitePath: path.join(home, "t.db") }, home);
  await migrate(db);
  const info = await db.all("PRAGMA table_info(sample_box)");
  const cols = [];
  const params = [];
  for (const col of info) {
    if (col.name === "id" || col.name === "imei" || col.name === "name") {
      cols.push(col.name);
      params.push(BOX);
    } else if (col.name === "org") {
      cols.push(col.name);
      params.push("总公司");
    } else if (col.name === "life") {
      cols.push(col.name);
      params.push("在途");
    } else if (col.name === "activate_step") {
      cols.push(col.name);
      params.push("已确认");
    } else if (col.notnull === 1 && col.dflt_value == null && col.pk === 0) {
      cols.push(col.name);
      params.push(/int|real|num/i.test(col.type) ? 0 : "");
    }
  }
  await db.run(
    `INSERT INTO sample_box (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    params
  );
  return { db, home };
}

/** 批量灌上报：raw 走 gzip（与生产 SQLite 存储一致）。 */
async function seedUplinks(db, rows) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const marks = part.map(() => "(?,?,?,?,?,?,?,?,?,?,?)").join(",");
    const params = [];
    for (const r of part) {
      const raw = gzipSync(
        Buffer.from(JSON.stringify({ imei: BOX, uart: r.uart, vbat: r.mv, time: r.device || r.at }))
      );
      params.push(
        BOX,
        BOX,
        r.at,
        r.device || "",
        r.kind || "timer",
        `定时上报 · ${(r.mv / 1000).toFixed(2)} V`,
        raw,
        114.06,
        22.54,
        null,
        null
      );
    }
    await db.run(
      `INSERT INTO sample_uplink (box_id, imei, received_at, device_time, kind, summary, raw, lbs_lng, lbs_lat, gps_lng, gps_lat) VALUES ${marks}`,
      params
    );
  }
}

const uart = (mv, chg, extra = "") => `why=timer,bat=${mv},chg=${chg},lid=0${extra}`;

/** 旧全量算法参照（修复前的 map+filter 逐行解压），用于等价性对照。 */
async function referenceRows(db, from, to) {
  const later = new Date(Date.parse(to.replace(" ", "T")) + 86400000);
  const until = formatTimestamp(later);
  const rows = await db.all(
    `SELECT received_at, summary, device_time, raw FROM sample_uplink
     WHERE box_id = ? AND received_at >= ? AND received_at <= ? ORDER BY received_at`,
    [BOX, from, until]
  );
  const mapped = rows
    .map((row) => {
      const raw = uplinkText(row);
      return {
        received_at: row.received_at,
        device_time: row.device_time || "",
        summary: row.summary,
        stmMv: raw.match(/,bat=(\d+)(?=,|\\|\s|"|$)/)?.[1],
        charge: chargeFromRaw(raw),
        periodSec: Number(raw.match(/,rp=(\d+)(?=,|\\|\s|"|$)/)?.[1]),
        chargeOnly: /,rc=1(?=,|\\|\s|"|$)/.test(raw),
      };
    })
    .filter((row) => {
      const time = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(row.device_time)
        ? row.device_time.slice(0, 19)
        : String(row.received_at).slice(0, 19);
      return time >= from && time <= to;
    });
  const before = await db.all(
    `SELECT summary, raw FROM sample_uplink WHERE box_id = ? AND received_at < ? ORDER BY received_at DESC LIMIT 2000`,
    [BOX, from]
  );
  let startFull = false;
  for (const row of before) {
    const match = String(row.summary || "").match(/(\d+(?:\.\d+)?)\s*V/);
    const mv = match ? Math.round(Number(match[1]) * 1000) : null;
    if (mv != null && mv >= 2500 && mv <= 4500 && mv < 4100) {
      startFull = false;
      break;
    }
    if (chargeFromRaw(uplinkText(row)) === 2) {
      startFull = true;
      break;
    }
  }
  mapped.startFull = startFull;
  return mapped;
}

test("分页分块解码与旧全量算法逐字段等价（补传/窗口外/充电态/startFull）", async () => {
  const { db, home } = await makeDb();
  try {
    const base = Date.parse("2026-11-10T00:00:00");
    const rows = [];
    for (let i = 0; i < 600; i++) {
      const at = base + i * 60000;
      const chg = i >= 200 && i < 260 ? 1 : i >= 260 && i < 300 ? 2 : 0;
      rows.push({
        at: stamp(at),
        mv: 3800 + (i % 40) * 5,
        uart: uart(3800 + (i % 40) * 5, chg, ",rp=60"),
      });
    }
    // 补传：收到时间在窗口内、设备时间在窗口前（应被设备时间过滤掉）
    rows.push({
      at: stamp(base + 300 * 60000),
      device: stamp(base - 5 * 3600000),
      mv: 3900,
      uart: uart(3900, 0),
    });
    // 补传：收到时间晚（to+1d  lookahead 内）、设备时间落在窗口内（应保留）
    rows.push({
      at: stamp(base + 700 * 60000),
      device: stamp(base + 350 * 60000),
      mv: 3950,
      uart: uart(3950, 1),
    });
    // 无 chg 的行（charge=null）与仅充电标记
    rows.push({ at: stamp(base + 360 * 60000), mv: 3880, uart: "why=timer,bat=3880,lid=0,rc=1" });
    // 窗口前有一条充满：startFull 应为 true
    rows.unshift({ at: stamp(base - 60000), mv: 4160, uart: uart(4160, 2) });
    await seedUplinks(db, rows);
    const store = new SqlBoxStore(db);
    const from = stamp(base);
    const to = stamp(base + 400 * 60000);
    const actual = await store.listBattery(BOX, from, to);
    const ref = await referenceRows(db, from, to);
    assert.equal(actual.length, ref.length);
    assert.deepEqual(
      actual.map((r) => ({ ...r })),
      ref.map((r) => ({ ...r }))
    );
    assert.equal(actual.startFull, ref.startFull);
    assert.equal(actual.startFull, true);
  } finally {
    await db.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("大序列解码期间事件循环不被长阻塞（心跳最大间隔 <150ms）", async () => {
  const { db, home } = await makeDb();
  try {
    const base = Date.now() - 7 * 86400000;
    const rows = [];
    for (let i = 0; i < 12000; i++) {
      const at = base + i * 50000; // ~8.3 分钟一条，12k 行覆盖 7 天
      rows.push({
        at: stamp(at),
        mv: 3700 + (i % 300),
        uart: uart(3700 + (i % 300), i % 2000 < 300 ? 1 : 0, ",rp=5"),
      });
    }
    await seedUplinks(db, rows);
    const store = new SqlBoxStore(db);
    const gaps = [];
    let last = performance.now();
    const beat = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }, 15);
    const t0 = performance.now();
    const rowsOut = await store.listBattery(BOX, stamp(base), stamp(Date.now()));
    const elapsed = performance.now() - t0;
    clearInterval(beat);
    const maxGap = Math.max(...gaps);
    assert.ok(rowsOut.length > 10000, `应解码全部行，实际 ${rowsOut.length}`);
    assert.ok(
      maxGap < 150,
      `事件循环最大阻塞 ${Math.round(maxGap)}ms 应 <150ms（总耗时 ${Math.round(elapsed)}ms）`
    );
  } finally {
    await db.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("按箱缓存：子范围切换不再全量解压；新上报/删行触发守卫失效重建", async () => {
  const { db, home } = await makeDb();
  try {
    const base = Date.now() - 7 * 86400000;
    const rows = [];
    for (let i = 0; i < 3000; i++) {
      const at = base + i * 201600; // 3000 条铺满 7 天，最后一条落在 now-200s
      rows.push({ at: stamp(at), mv: 3800 + (i % 100), uart: uart(3800 + (i % 100), 0, ",rp=5") });
    }
    await seedUplinks(db, rows);
    const store = new SqlBoxStore(db);
    const from7 = stamp(base);
    const to = stamp(Date.now());
    const first = await store.listBattery(BOX, from7, to);
    assert.ok(store.batteryCache.has(BOX), "大序列应进缓存");

    // 子范围（1h）：只允许守卫 COUNT/MAX 与 startFull 查询，不允许再分页拉 raw
    const sqls = [];
    const origAll = db.all.bind(db);
    db.all = async (sql, params) => {
      sqls.push(sql);
      return origAll(sql, params);
    };
    const from1 = stamp(Date.now() - 3600000);
    const sub = await store.listBattery(BOX, from1, to);
    db.all = origAll;
    assert.equal(
      sqls.some((s) => s.includes("LIMIT 4000")),
      false,
      `缓存命中不应再分页拉行：${sqls.join(" | ")}`
    );
    assert.ok(sub.length > 0 && sub.length < first.length);
    // 与无缓存新 store 的同范围结果一致
    const fresh = await new SqlBoxStore(db).listBattery(BOX, from1, to);
    assert.deepEqual(
      sub.map((r) => ({ ...r })),
      fresh.map((r) => ({ ...r }))
    );
    assert.equal(sub.startFull, fresh.startFull);

    // 新上报一条（窗口内）→ 守卫变化 → 重建并包含新行
    const newAt = stamp(Date.now() - 60000);
    await seedUplinks(db, [{ at: newAt, mv: 4160, uart: uart(4160, 2) }]);
    const after = await store.listBattery(BOX, from7, to);
    assert.equal(after.length, first.length + 1);
    assert.ok(after.some((r) => r.received_at === newAt && r.charge === 2));

    // 删行（抹除/清理场景）→ 守卫变化 → 重建反映删除
    await db.run("DELETE FROM sample_uplink WHERE box_id = ? AND received_at = ?", [BOX, newAt]);
    const afterDelete = await store.listBattery(BOX, from7, to);
    assert.equal(afterDelete.length, first.length);
  } finally {
    await db.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("电量端点：点数上限 360 段＋空点，响应头带 pointCount/rawCount，数组形状不变", async () => {
  const { db, home } = await makeDb();
  try {
    const base = Date.now() - 7 * 86400000;
    const rows = [];
    for (let i = 0; i < 12000; i++) {
      if (i >= 5000 && i < 5120) continue; // 3h 级静默 → 一个空点
      const at = base + i * 50000;
      rows.push({ at: stamp(at), mv: 3800 + (i % 200), uart: uart(3800 + (i % 200), 0, ",rp=5") });
    }
    await seedUplinks(db, rows);
    const controller = new SampleController(new SqlBoxStore(db));
    const headers = {};
    const ctx = {
      params: { id: BOX },
      query: { from: stamp(base), to: stamp(Date.now()) },
      access: null,
      ok(data) {
        this.data = data;
      },
      fail(msg, code) {
        throw new Error(`${code}: ${msg}`);
      },
      header(name, value) {
        headers[name] = value;
      },
    };
    await controller.battery(ctx);
    assert.ok(Array.isArray(ctx.data), "旧客户端契约：data 仍是数组");
    assert.ok(ctx.data.length <= 720, `点数 ${ctx.data.length} 应 ≤720（360 段＋空点）`);
    assert.ok(ctx.data.length >= 300, `7 天密集上报应合并出 ≥300 点，实际 ${ctx.data.length}`);
    assert.equal(headers["X-Battery-Point-Count"], String(ctx.data.length));
    assert.equal(Number(headers["X-Battery-Raw-Count"]), rows.length);
    assert.ok(
      ctx.data.some((p) => p.gap),
      "静默段应插空点断开"
    );
  } finally {
    await db.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
