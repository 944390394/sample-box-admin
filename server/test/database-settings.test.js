import assert from "node:assert/strict";
import test from "node:test";

import { mergeDatabaseSettings, publicDatabase, scrub } from "../src/settings/databaseConfig.js";

test("数据库密码只写入配置，读出来的设置里没有密码", () => {
  const saved = mergeDatabaseSettings(
    { dialect: "sqlite", secret: "keep", sqlitePath: "server/data/sample-box.db" },
    {
      host: "db.internal",
      port: 3306,
      database: "sample_box",
      user: "box",
      password: "s3cr3t-db",
    }
  );
  assert.equal(saved.dialect, "mysql");
  assert.equal(saved.password, "s3cr3t-db");
  assert.equal(saved.secret, "keep");
  const visible = publicDatabase(saved);
  assert.equal(visible.passwordSet, true);
  assert.equal(visible.host, "db.internal");
  assert.equal(Object.hasOwn(visible, "password"), false);
  assert.equal(JSON.stringify(visible).includes("s3cr3t-db"), false);

  const kept = mergeDatabaseSettings(saved, {
    host: "db.internal",
    port: 3306,
    database: "sample_box",
    user: "box",
    password: "",
  });
  assert.equal(kept.password, "s3cr3t-db");

  const sqlite = mergeDatabaseSettings(kept, { host: "" });
  assert.equal(sqlite.dialect, "sqlite");
  assert.equal(sqlite.host, "");
  assert.equal(sqlite.password, "");
  assert.deepEqual(publicDatabase(sqlite), {
    host: "",
    port: 3306,
    database: "",
    user: "",
    passwordSet: false,
  });
  assert.throws(() =>
    mergeDatabaseSettings(
      { dialect: "sqlite" },
      { host: "db.internal", port: 3306, database: "sample_box", user: "box", password: "" }
    )
  );
  assert.equal(scrub("Access denied for s3cr3t-db", "s3cr3t-db").includes("s3cr3t-db"), false);
});
