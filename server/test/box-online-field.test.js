import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, migrate } from "../db.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { SampleController } from "../src/http/SampleController.js";
import { formatTimestamp } from "../src/domain/Clock.js";

/**
 * 列表/详情 JSON 随箱下发查询时刻算好的 online（地图/抽屉直接显示，不拿本地快照重算）。
 * 口径与 onlineSql/flagMatch 同源：3×自身周期、仅充电豁免、建单宽限；
 * 且与 SQL 侧 flags.offline 计数逐箱对齐。
 */
test("box JSON 带查询时刻 online，与 flags.offline 同口径", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "online-field-"));
  const db = await openDatabase({ dialect: "sqlite", sqlitePath: path.join(home, "t.db") }, home);
  await migrate(db);
  const now = Date.now();
  const at = (secAgo) => formatTimestamp(new Date(now - secAgo * 1000));
  const info = await db.all("PRAGMA table_info(sample_box)");
  const base = {
    id: "",
    imei: "",
    name: "",
    org: "总公司",
    life: "在途",
    last_report_at: "",
    bound_task_id: "",
    bound_task_at: "",
    activate_step: "等待激活",
  };
  const rows = [
    // 5s 前上报（默认周期 5s，阈值 15s）→ 在线
    { id: "O-FRESH", vals: { last_report_at: at(5) }, online: true },
    // 1h 前上报 → 离线
    { id: "O-STALE", vals: { last_report_at: at(3600) }, online: false },
    // 1h 前上报但仅充电模式且未充电 → 豁免在线
    {
      id: "O-EXEMPT",
      vals: { last_report_at: at(3600), policy_charge_only: 1, charge: 0 },
      online: true,
    },
    // 自身周期 3600s：60s 前上报在 3×周期内 → 在线（默认 15s 窗口会误判离线）
    { id: "O-PERIOD", vals: { last_report_at: at(60), policy_period_sec: 3600 }, online: true },
    // 占用且从未上报、建单 600s 前（宽限 3600s 内）→ 宽限在线
    {
      id: "O-GRACE",
      vals: { bound_task_id: "T-1", bound_task_at: at(600) },
      online: true,
    },
    // 从未上报、无占用 → 离线
    { id: "O-NEVER", vals: {}, online: false },
  ];
  for (const row of rows) {
    const vals = { ...base, ...row.vals, id: row.id, imei: row.id, name: row.id };
    const cols = [];
    const params = [];
    for (const col of info) {
      const n = col.name;
      if (n in vals) {
        cols.push(n);
        params.push(vals[n]);
      } else if (col.notnull === 1 && col.dflt_value == null && col.pk === 0) {
        cols.push(n);
        params.push(/int|real|num/i.test(col.type) ? 0 : "");
      }
    }
    await db.run(
      `INSERT INTO sample_box (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      params
    );
  }

  const controller = new SampleController(new SqlBoxStore(db));
  const ctx = {
    query: { page: "1", pageSize: "50" },
    access: null,
    ok(data) {
      this.data = data;
    },
    fail(msg, code) {
      throw new Error(`${code}: ${msg}`);
    },
  };
  await controller.list(ctx);
  const list = ctx.data.list;
  assert.equal(list.length, rows.length);
  for (const row of rows) {
    const json = list.find((b) => b.id === row.id);
    assert.equal(typeof json.online, "boolean", `${row.id} 带 online 字段`);
    assert.equal(json.online, row.online, `${row.id} online 判定`);
  }
  // SQL 侧离线计数与逐箱 online 对齐（同一口径的两条实现路径互证）
  assert.equal(
    ctx.data.flags.offline,
    rows.filter((r) => !r.online).length,
    "flags.offline == online=false 箱数"
  );

  // 非分页 list 路径（pageInMemory/view 同函数）也带 online
  const plain = {
    query: {},
    access: null,
    ok(d) {
      this.data = d;
    },
    fail: ctx.fail,
  };
  await controller.list(plain);
  for (const row of rows) {
    const json = plain.data.find((b) => b.id === row.id);
    assert.equal(json.online, row.online, `${row.id} 非分页 online`);
  }
  await db.close();
  fs.rmSync(home, { recursive: true, force: true });
});
