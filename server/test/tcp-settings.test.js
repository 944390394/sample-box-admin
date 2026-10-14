import assert from "node:assert/strict";
import test from "node:test";

import { TcpIngestServer } from "../src/transport/TcpIngestServer.js";
import { tcpPassthroughSettings } from "../src/tcpSettings.js";

const fields = [
  "mode",
  "address",
  "port",
  "hint",
  "adminUrl",
  "listening",
  "version",
  "certExpiresAt",
];

test("缺省主机名，端口用实际监听值，不带路径", () => {
  const data = tcpPassthroughSettings(9000, {});
  assert.equal(data.mode, "TCP 透传");
  assert.equal(data.address, "sample.baiyuhub.top");
  assert.equal(data.port, 9000);
  assert.equal(data.hint, "不要填写路径");
  assert.equal(data.adminUrl, "https://sample.baiyuhub.top");
  assert.equal(data.listening, true);
  assert.deepEqual(Object.keys(data), fields);
  assert.equal(Object.hasOwn(data, "path"), false);
});

test("主机名来自环境变量，路径和写在地址里的端口会被丢掉", () => {
  const data = tcpPassthroughSettings(9001, {
    SAMPLE_TCP_HOST: "https://box.example.com:443/tcp/path?x=1",
    SAMPLE_ADMIN_URL: "https://sample.baiyuhub.top/admin/index",
  });
  assert.equal(data.address, "box.example.com");
  assert.equal(data.port, 9001);
  assert.equal(data.adminUrl, "https://sample.baiyuhub.top");
  assert.equal(Object.hasOwn(data, "path"), false);
});

test("没有实际监听端口时仍返回其余只读信息", () => {
  const data = tcpPassthroughSettings(
    undefined,
    {},
    { version: "abc", certExpiresAt: "2027-01-12" }
  );
  assert.equal(data.listening, false);
  assert.equal(data.port, null);
  assert.equal(data.address, "sample.baiyuhub.top");
  assert.equal(data.version, "abc");
  assert.equal(data.certExpiresAt, "2027-01-12");
  assert.equal(tcpPassthroughSettings(0, {}).listening, false);
});

test("设置使用 TCP 服务实际监听到的端口", async () => {
  const server = new TcpIngestServer({
    port: 0,
    host: "127.0.0.1",
    ingest: { async accept() {} },
  });
  await server.start();
  try {
    const listeningPort = server.address().port;
    const data = tcpPassthroughSettings(listeningPort, {});
    assert.equal(data.port, listeningPort);
    assert.equal(data.address, "sample.baiyuhub.top");
    assert.equal(data.listening, true);
    assert.equal(Object.hasOwn(data, "path"), false);
  } finally {
    await server.close();
  }
});
