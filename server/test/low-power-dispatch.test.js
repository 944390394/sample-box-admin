import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openDatabase, migrate } from "../db.js";
import { ReportPolicy } from "../src/settings/ReportPolicy.js";
import { TcpIngestServer } from "../src/transport/TcpIngestServer.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";

test("on dispatch send frozen policy without a second uplink; disconnected device picks it up later", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "dispatch-"));
  const db = await openDatabase(
    { dialect: "sqlite", sqlitePath: path.join(tmp, "box.db") },
    process.cwd()
  );
  const box = { id: "BOX", firmware: "1.0.17" };
  const policies = new ReportPolicy(db);
  const tcp = new TcpIngestServer({
    port: 0,
    host: "127.0.0.1",
    policies,
    ingest: {
      async accept() {
        return { box, netLink: 1, scheduled: true };
      },
    },
  });
  let socket;
  try {
    await migrate(db);
    await db.run(
      "INSERT INTO sample_box (id,imei,life,firmware,org,activate_step) VALUES (?,?,?,?,?,?)",
      [box.id, "123456789012345", "未使用", box.firmware, "总公司", "已确认"]
    );
    const p = { reportPeriodSec: 300, reportOnlyWhenCharging: false, periodicGps: false };
    await policies.save([box.id], "single", p);
    await tcp.start();
    policies.onPolicyChanged = (ids) => tcp.pushPolicies(ids);
    socket = net.connect(tcp.address().port, "127.0.0.1");
    socket.setTimeout(5000, () => socket.destroy(new Error("timed out waiting for policy")));
    await once(socket, "connect");
    let data = once(socket, "data");
    socket.write(JSON.stringify({ imei: "123456789012345" }));
    assert.match(String((await data)[0]), /p=300 .*t=0 j=0 v=/);
    data = once(socket, "data");
    const task = await policies.createTask({
      name: "dispatch",
      kind: "采样",
      boxIds: [box.id],
      overrides: { [box.id]: { ...p, reportPeriodSec: 600, periodicGps: true } },
    });
    assert.match(String((await data)[0]), /p=600 .*t=1 j=1 v=/);
    socket.destroy();
    await policies.save([box.id], "single", { ...p, reportPeriodSec: 900 });
    const packet = await new ReportPolicy(db).packet(box, { scheduled: true });
    assert.match(packet.text, /p=600 .*t=1 j=1/);
    assert.equal((await policies.get(box)).taskId, task);
  } finally {
    socket?.destroy();
    if (tcp.address()) await tcp.close();
    await db.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test("replayed timer retains captured coordinates and sample time on only its own line", () => {
  const parser = new UplinkParser();
  const base = { imei: "123456789012345", lpp: 1, timem: "1793000999000", gpsfix: 0 };
  const records = parser.parseMany(
    JSON.stringify({
      ...base,
      uart: "why=timer,t=1793000000000,xy=114000000/30000000/1792999999,bf=1\r\nwhy=shut,t=1793000001000,bf=1\r\n",
    })
  );
  assert.equal(records[0].gpsLng, 114);
  assert.equal(records[0].gpsLat, 30);
  assert.ok(records[0].gpsAt);
  assert.equal(records[1].gpsfix, 0);
  assert.equal(records[0].scheduled, true);
});
