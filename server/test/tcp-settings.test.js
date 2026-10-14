import assert from "node:assert/strict";
import test from "node:test";

import { TcpIngestServer } from "../src/transport/TcpIngestServer.js";
import { tcpPassthroughSettings } from "../src/tcpSettings.js";

test("缺省主机名，端口用实际监听值，不带路径", () => {
  const data = tcpPassthroughSettings(9000, {});
  assert.deepEqual(data, { address: "sample.baiyuhub.top", port: 9000 });
  assert.deepEqual(Object.keys(data), ["address", "port"]);
});

test("主机名来自环境变量，路径和写在地址里的端口会被丢掉", () => {
  const data = tcpPassthroughSettings(9001, {
    SAMPLE_TCP_HOST: "https://box.example.com:443/tcp/path?x=1",
  });
  assert.deepEqual(data, { address: "box.example.com", port: 9001 });
});

test("没有实际监听端口时不返回", () => {
  assert.equal(tcpPassthroughSettings(undefined, {}), null);
  assert.equal(tcpPassthroughSettings(0, {}), null);
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
    assert.equal(Object.hasOwn(data, "path"), false);
  } finally {
    await server.close();
  }
});
