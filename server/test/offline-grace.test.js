import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, migrate } from "../db.js";
import { SqlBoxStore } from "../src/store/SqlBoxStore.js";
import { formatTimestamp } from "../src/domain/Clock.js";

test("B3 宽限边界：now-3600 内不算离线、超 grace 算离线；stats.flags.offline == flag=offline 落地总数", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "grace-"));
  const db = await openDatabase({ dialect: "sqlite", sqlitePath: path.join(home, "t.db") }, home);
  await migrate(db);
  const now = Date.now();
  const at = (secAgo) => formatTimestamp(new Date(now - secAgo * 1000)).slice(0, 19);
  // G-A 占用且从未上报、建单 3000s 前（宽限内）→ 不算离线
  // G-B 占用且从未上报、建单 4000s 前（超宽限）→ 离线
  // G-C 无占用、从未上报 → 离线（无宽限保护）
  // 注：onlineSql 的 now 有 5s 量化（L-P2-8），边界容差 ±5s，故用远离边界的值断言。
  // 自动补齐所有 NOT NULL 且无默认值的列，避免逐列追约束
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
  for (const [id, boundAt] of [
    ["G-A", at(3000)],
    ["G-B", at(4000)],
    ["G-C", ""],
  ]) {
    const vals = {
      ...base,
      id,
      imei: id,
      name: id,
      bound_task_id: boundAt ? "T-1" : "",
      bound_task_at: boundAt,
    };
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
  const store = new SqlBoxStore(db);
  const limits = { onlineSince: "9999", lowMv: 0, readyMv: 99999 };
  const stats = await store.stats({ scope: null, limits });
  const off = await store.page({ page: 1, pageSize: 50, scope: null, limits, flag: "offline" });
  assert.equal(stats.flags.offline, 2, "B+C 离线");
  assert.equal(off.total, 2, "落地总数==flags.offline");
  const ids = off.list.map((b) => b.id);
  assert.ok(!ids.includes("G-A"), "宽限内不算离线");
  assert.ok(ids.includes("G-B") && ids.includes("G-C"));
  await db.close();
  fs.rmSync(home, { recursive: true, force: true });
});
