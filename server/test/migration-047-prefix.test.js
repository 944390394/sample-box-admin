/**
 * 迁移号 047 重复（R-8，论证保留）。
 *
 * 047_task_opens_from_create.js 与 047_wechat_multi_account.js 共用数字前缀 047。
 * 机制安全的关键：db.js migrate() 以「全文件名」作 schema_migrations.version（不是数字前缀），
 * 按文件名字典序执行。这里守住：
 * 1. migrate 后两个 047 的 version 都在 schema_migrations，且是两个不同字符串（不会互相覆盖/跳过）；
 * 2. 执行顺序确定：文件名字典序 task_opens 先于 wechat，applied_at 与该顺序一致；
 * 3. 重跑 migrate 不重复插入、不漏掉任一 047（runner 以全文件名去重）。
 * 不改名/不改号——已应用过的库以全文件名为 version 键，改名会让生产重跑。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, migrate } from "../db.js";

const TASK = "047_task_opens_from_create";
const WECHAT = "047_wechat_multi_account";

test("R-8：两个 047 前缀迁移都入库、version 是全文件名、执行顺序确定且重跑不重复", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "migration-047-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(dir, "db") },
    process.cwd()
  );
  try {
    await migrate(db);
    const rows = await db.all(
      "SELECT version, applied_at FROM schema_migrations WHERE version IN (?, ?)",
      [TASK, WECHAT]
    );
    const versions = rows.map((r) => r.version);
    assert.ok(versions.includes(TASK), "047_task_opens_from_create 没入库");
    assert.ok(versions.includes(WECHAT), "047_wechat_multi_account 没入库");
    assert.equal(new Set(versions).size, 2, "两个 047 的 version 必须是不同字符串（全文件名）");

    // 执行顺序 = 文件名字典序（与 db.js migrate 同一套排序），task_opens 先于 wechat，确定
    const migDir = fileURLToPath(new URL("../migrations/", import.meta.url));
    const names = (await readdir(migDir)).filter((n) => /^\d+.+\.js$/.test(n)).sort();
    assert.ok(
      names.indexOf(`${TASK}.js`) < names.indexOf(`${WECHAT}.js`),
      "字典序应 task_opens 先于 wechat"
    );

    // applied_at 与执行顺序一致（task 不晚于 wechat；ISO 字符串字典序即时间序）
    const at = Object.fromEntries(rows.map((r) => [r.version, r.applied_at]));
    assert.ok(at[TASK] <= at[WECHAT], "applied_at 应与文件名执行顺序一致");

    // 再跑一次 migrate：两个 version 仍各只有一条（以全文件名去重，不重跑、不漏）
    await migrate(db);
    const again = await db.all("SELECT version FROM schema_migrations WHERE version IN (?, ?)", [
      TASK,
      WECHAT,
    ]);
    assert.equal(again.length, 2, "重跑 migrate 不应重复插入或漏掉任一 047");
  } finally {
    await db.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});
