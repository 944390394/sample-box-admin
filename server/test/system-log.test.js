import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { SystemLog, redact, setSystemLog, observeRequest } from "../src/log/systemLog.js";

const withLog = (fn) => {
  const log = new SystemLog(":memory:");
  try {
    return fn(log);
  } finally {
    log.close();
  }
};
test("问题汇总取最近实例，支持频次、耗时排序与登录噪声过滤", () =>
  withLog((log) => {
    const old = log.record({ message: "zz-old", kind: "exception", status: 500, duration: 200 });
    const latest = log.record({
      message: "aa-latest",
      kind: "exception",
      status: 502,
      duration: 900,
    });
    log.db
      .prepare("UPDATE runtime_log SET fingerprint='same',time=? WHERE id=?")
      .run(Date.now() - 3000, old.id);
    log.db
      .prepare("UPDATE runtime_log SET fingerprint='same',time=? WHERE id=?")
      .run(Date.now() - 2000, latest.id);
    log.record({
      message: "expired",
      kind: "auth",
      code: "A0230",
      status: 401,
      level: "info",
      requestId: "expired-id",
    });
    const grouped = log.query({ group: "true", sort: "count", excludeAuth: "true" });
    assert.equal(grouped.list[0].message, "aa-latest");
    assert.equal(grouped.list[0].latestId, latest.id);
    assert.equal(grouped.list[0].maxDuration, 900);
    assert.equal(grouped.summary.total, 2);
    assert.equal(log.query({ status: "502" }).list.length, 1);
    assert.equal(log.query({ kind: "auth", excludeAuth: "true" }).list.length, 1);
    assert.equal(log.query({ requestId: "expired-id", excludeAuth: "true" }).list.length, 1);
    assert.throws(() => log.query({ status: "bad" }));
  }));
test("diagnostics redact credentials, URL query and long device identifiers", () => {
  const text = redact(
    'password="secret123" Authorization: Bearer xyz token=abc mysql://root:dbpass@host/db https://host/path?sk=sensitive 864317080992517'
  );
  for (const secret of ["secret123", "xyz", "abc", "dbpass", "sensitive", "864317080992517"])
    assert.ok(!text.includes(secret), text);
});
test("group repeated problems and preserve millisecond duration and exception stack", () =>
  withLog((log) => {
    for (let i = 0; i < 3; i++)
      log.record({
        source: "http",
        kind: "exception",
        path: "/api/boxes?token=secret",
        message: "database failed",
        stack: "Error: database failed\n at handler (server.js:1)",
        duration: 2200 + i,
        requestId: `trace-${i}`,
      });
    log.record({ source: "tcp", message: "invalid JSON" });
    const groups = log.query({ group: "true" });
    assert.equal(groups.summary.total, 4);
    assert.equal(groups.summary.issues, 2);
    const row = groups.list.find((x) => x.source === "http");
    assert.equal(row.occurrences, 3);
    assert.equal(row.maxDuration, 2202);
    assert.equal(row.avgDuration, 2201);
    const page = log.query({ requestId: "trace-1" });
    assert.equal(page.list.length, 1);
    assert.equal(page.list[0].path, "/api/boxes");
    assert.equal(page.list[0].stack, undefined);
    assert.match(log.detail(page.list[0].id).stack, /handler/);
    assert.equal(log.query({ q: "%' OR 1=1--" }).list.length, 0);
    assert.throws(() => log.query({ from: 0, to: Date.now() }), /31/);
  }));
test("keyset pagination has no duplicates when timestamps are equal", () =>
  withLog((log) => {
    for (let i = 0; i < 70; i++) log.record({ message: `item ${i}` });
    log.db.prepare("UPDATE runtime_log SET time=?").run(Date.now() - 1000);
    const first = log.query(),
      second = log.query({ cursorId: first.nextCursor.id, cursorTime: first.nextCursor.time });
    assert.equal(first.list.length, 50);
    assert.equal(second.list.length, 20);
    assert.equal(new Set([...first.list, ...second.list].map((x) => x.id)).size, 70);
  }));
test("persistent independent database survives business restart and prunes only diagnostic records", () => {
  const dir = mkdtempSync(join(tmpdir(), "sample-log-")),
    file = join(dir, "logs.sqlite");
  let log = new SystemLog(file, { maxRows: 2 });
  try {
    log.record({ message: "first" });
    log.record({ message: "second" });
    log.record({ message: "third" });
    log.prune();
    assert.equal(log.query().summary.total, 2);
    log.close();
    log = new SystemLog(file);
    assert.equal(log.query().summary.total, 2);
  } finally {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("diagnostic storage failure never throws into business path; drop count visible", () => {
  const log = new SystemLog(":memory:", { stderr: () => {} });
  log.close();
  assert.equal(log.record({ message: "x" }), null);
  assert.equal(log.health().dropped, 1);
  assert.ok(log.health().lastFailure);
});
test("real HTTP response logs 200 business errors, thrown errors, slow requests and trace ids", async () => {
  const log = new SystemLog(":memory:");
  setSystemLog(log);
  const server = createServer(async (req, res) => {
    const info = observeRequest(req, res);
    if (req.url === "/slow") await new Promise((r) => setTimeout(r, 2050));
    if (req.url === "/fail") {
      info.code = "B0001";
      info.message = "business failed";
    }
    if (req.url === "/throw") {
      info.error = new Error("database offline");
      res.statusCode = 500;
    }
    res.end("done");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ["/ok", "/fail", "/throw", "/slow"]) {
      const r = await fetch(base + path);
      assert.ok(r.headers.get("x-request-id"));
      await r.text();
    }
    const rows = log.query().list;
    assert.equal(rows.length, 3);
    assert.equal(rows.find((x) => x.path === "/fail").status, 200);
    assert.ok(
      log.detail(rows.find((x) => x.path === "/throw").id).stack.includes("database offline")
    );
    assert.equal(rows.find((x) => x.path === "/slow").kind, "slow");
  } finally {
    await new Promise((r) => server.close(r));
    setSystemLog(null);
    log.close();
  }
});
