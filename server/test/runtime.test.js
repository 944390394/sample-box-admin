import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocket } from "ws";

import { RedisStateCache } from "../src/cache/RedisStateCache.js";
import { BoxState } from "../src/domain/BoxState.js";
import { SampleController } from "../src/http/SampleController.js";
import { MysqlPool } from "../src/store/MysqlPool.js";
import { MemoryBoxStore } from "../src/store/MemoryBoxStore.js";
import { RealtimeHub } from "../src/transport/RealtimeHub.js";
import { SampleSocketServer } from "../src/transport/SampleSocketServer.js";

function sampleBox() {
  return new BoxState({
    id: "BOX-001",
    imei: "864317080992517",
    iccid: "",
    imsi: "",
    firmware: "",
    org: "总公司",
    owner: "—",
    life: "在途",
    alert: "",
    battery: "3.76 V",
    csq: 19,
    last: "2026-09-28 17:11:27.128",
    lbs: "",
    lbsLng: 114.117201,
    lbsLat: 22.679073,
    gps: "未定位",
    gpsLng: null,
    gpsLat: null,
    opens: 1,
    activateStep: "已确认",
    poweredAt: "2026-09-26 09:10:00.000",
  });
}

test("Redis 缓存写入最新状态并发布同一份 JSON", async () => {
  const commands = [];
  const cache = new RedisStateCache({
    async set(key, value) {
      commands.push(["set", key, value]);
    },
    async publish(channel, value) {
      commands.push(["publish", channel, value]);
    },
    async get(key) {
      const found = commands.find((item) => item[0] === "set" && item[1] === key);
      return found ? found[2] : null;
    },
  });
  await cache.put(sampleBox());
  assert.equal(commands[0][1], "sample:box:BOX-001");
  assert.equal(commands[1][0], "publish");
  assert.equal(commands[1][1], "sample:box");
  assert.equal(commands[0][2], commands[1][2]);
  assert.equal((await cache.get("BOX-001")).gps, "未定位");
});

test("连接池事务在同一条连接上提交", async () => {
  const events = [];
  const connection = {
    async beginTransaction() {
      events.push("begin");
    },
    async commit() {
      events.push("commit");
    },
    async rollback() {
      events.push("rollback");
    },
    async execute(sql) {
      events.push(sql);
      return [[{ next_no: 7 }]];
    },
    release() {
      events.push("release");
    },
  };
  const pool = new MysqlPool({
    async getConnection() {
      return connection;
    },
  });
  const value = await pool.transaction(async (tx) => {
    const row = await tx.get("SELECT next_no FROM sample_box_seq WHERE id = 1 FOR UPDATE");
    return row.next_no;
  });
  assert.equal(value, 7);
  assert.deepEqual(events, [
    "begin",
    "SELECT next_no FROM sample_box_seq WHERE id = 1 FOR UPDATE",
    "commit",
    "release",
  ]);
});

test("查询接口按箱号返回日志", async () => {
  const boxes = new MemoryBoxStore();
  const box = sampleBox();
  await boxes.save(box);
  await boxes.appendLog({
    boxId: box.id,
    toJSON() {
      return { time: box.last, text: "定时上报", by: "设备", raw: '{"imei":"864317080992517"}' };
    },
  });
  const controller = new SampleController(boxes);
  const listed = {
    data: null,
    ok(data) {
      this.data = data;
    },
  };
  await controller.list(listed);
  assert.equal(listed.data[0].lbsLng, 114.117201);
  const missing = {
    params: { id: "BOX-404" },
    status: 0,
    fail(_msg, _code, status) {
      this.status = status;
    },
    ok() {},
  };
  await controller.detail(missing);
  assert.equal(missing.status, 404);
  const logs = {
    params: { id: "BOX-001" },
    data: null,
    ok(data) {
      this.data = data;
    },
  };
  await controller.logs(logs);
  assert.match(logs.data[0].raw, /864317080992517/);
  assert.equal(logs.data[0].time, "2026-09-28 17:11:27.128");
});

test("WebSocket 在令牌有效时收到箱子状态", async () => {
  const httpServer = http.createServer();
  const hub = new RealtimeHub();
  const sockets = new SampleSocketServer({
    httpServer,
    hub,
    authorize: (token) => token === "ok",
  });
  sockets.start();
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = httpServer.address().port;
  try {
    const denied = new WebSocket(`ws://127.0.0.1:${port}/api/v1/sample/stream?token=no`);
    const deniedCode = await new Promise((resolve) => denied.on("close", resolve));
    assert.equal(deniedCode, 4401);
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/v1/sample/stream?token=ok`);
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const incoming = new Promise((resolve, reject) => {
      client.once("message", (data) => resolve(JSON.parse(String(data))));
      client.once("error", reject);
    });
    hub.publish(sampleBox());
    const message = await incoming;
    assert.equal(message.type, "box");
    assert.equal(message.box.imei, "864317080992517");
    assert.equal(message.box.gps, "未定位");
    client.close();
  } finally {
    await sockets.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});
