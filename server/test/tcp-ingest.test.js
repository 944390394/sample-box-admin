import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { JsonFramer } from "../src/transport/JsonFramer.js";
import { TcpIngestServer } from "../src/transport/TcpIngestServer.js";
import { packet } from "./fixture.js";

test("半包拼接和粘包都能切出完整 JSON", () => {
  const framer = new JsonFramer();
  const raw = packet();
  assert.deepEqual(framer.push(raw.slice(0, 12)), []);
  assert.deepEqual(framer.push(raw.slice(12)), [raw]);
  const second = packet({ imei: "864317080992208" });
  assert.deepEqual(framer.push(`${raw}${second}`), [raw, second]);
});

test("TCP 收到一包 JSON 后交给接入服务", async () => {
  const received = [];
  let arrived;
  const done = new Promise((resolve) => {
    arrived = resolve;
  });
  const server = new TcpIngestServer({
    port: 0,
    host: "127.0.0.1",
    ingest: {
      async accept(raw) {
        received.push(raw);
        arrived();
      },
    },
  });
  await server.start();
  const port = server.address().port;
  const raw = packet({ uart: "why=boot,aa55=0" });
  const reply = await new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.write(raw);
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      socket.end();
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(chunks.join("")));
  });
  await done;
  assert.equal(received[0], raw);
  assert.equal(reply, "ok\n");
  await server.close();
});

test("非法报文不会拖垮监听", async () => {
  let arrived;
  const done = new Promise((resolve) => {
    arrived = resolve;
  });
  const server = new TcpIngestServer({
    port: 0,
    host: "127.0.0.1",
    ingest: {
      async accept(raw) {
        if (raw.includes('"bad"')) throw new Error("上报缺少有效 IMEI");
        arrived(raw);
      },
    },
  });
  await server.start();
  const port = server.address().port;
  await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.end('{"imei":"bad"}');
    });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve();
    }, 500);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.on("error", finish);
    socket.on("close", finish);
  });
  const raw = packet({ uart: "why=timer,aa55=0" });
  await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.end(raw);
    });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve();
    }, 500);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.on("data", () => socket.destroy());
    socket.on("error", finish);
    socket.on("close", finish);
  });
  const accepted = await Promise.race([
    done,
    new Promise((_, reject) => setTimeout(() => reject(new Error("下一包没有入库")), 1000)),
  ]);
  assert.equal(accepted, raw);
  assert.equal(server.address().port, port);
  await server.close();
});
