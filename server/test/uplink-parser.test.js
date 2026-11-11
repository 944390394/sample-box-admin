import assert from "node:assert/strict";
import test from "node:test";

import { formatUnixMs } from "../src/domain/Clock.js";
import { UplinkError } from "../src/domain/UplinkError.js";
import { UplinkParser } from "../src/domain/UplinkParser.js";
import { packet } from "./fixture.js";

const parser = new UplinkParser();

test("上电报文拆出基站，GPS 未定位，并保留原始 JSON", () => {
  const raw = packet({
    uart: "why=boot,aa55=0,lbs=now,lng=114.1172010,lat=022.6790730",
    lbslng: "114.1172010",
    lbslat: "022.6790730",
    gpsfix: 0,
  });
  const uplink = parser.parse(raw);
  assert.equal(uplink.why, "boot");
  assert.equal(uplink.label, "上电上报");
  assert.equal(uplink.lbsLng, Number("114.1172010"));
  assert.equal(uplink.lbsLat, Number("022.6790730"));
  assert.equal(uplink.hasGps(), false);
  assert.equal(uplink.raw, raw);
});

test("GPS 定位和基站坐标分开读取", () => {
  const uplink = parser.parse(
    packet({
      uart: "why=pad,aa55=1,opens=2,lbs=now,lng=120.1500000,lat=030.2800000",
      gpsfix: 1,
      lng: "120.1551000",
      lat: "030.2741000",
      lbslng: "120.1500000",
      lbslat: "030.2800000",
      imei: "864317080991774",
    })
  );
  assert.equal(uplink.label, "开箱上报");
  assert.equal(uplink.opens, 2);
  assert.equal(uplink.lid, null);
  assert.equal(uplink.openAge, null);
  assert.equal(uplink.hasGps(), true);
  assert.equal(uplink.gpsLng, Number("120.1551000"));
  assert.equal(uplink.lbsLng, Number("120.1500000"));
});

test("开箱次数、箱盖状态和上次开箱间隔从 uart 读出", () => {
  const uplink = parser.parse(
    packet({
      uart: "why=timer,opens=4,lid=0,openage=35",
      time: "2026-10-21 09:40:53",
    })
  );
  assert.equal(uplink.opens, 4);
  assert.equal(uplink.lid, 0);
  assert.equal(uplink.openAge, 35);
  assert.equal(uplink.charge, null);
  assert.equal(uplink.deviceTime, "2026-10-21 09:40:53");
});

test("充电状态从 uart 读出，why=chg 不当成充电值", () => {
  const uplink = parser.parse(packet({ uart: "why=chg,opens=1,lid=1,chg=1" }));
  assert.equal(uplink.why, "chg");
  assert.equal(uplink.label, "充电上报");
  assert.equal(uplink.charge, 1);
  assert.equal(uplink.opens, 1);
});

test("任务和发送模板套了两层时，仍读出充电上报", () => {
  const inner = {
    uart: "why=chg,opens=0,lid=1,chg=1,bat=4155,seq=2",
    chg: 1,
    opens: 0,
    lid: 1,
    imei: "864317080992517",
    time: "2026-10-21 14:31:49",
  };
  const uplink = parser.parse(
    packet({
      uart: JSON.stringify(inner),
      chg: 1,
      opens: 0,
      lid: 1,
      vbat: 4155,
      time: "2026-10-21 14:31:49",
      lbslng: "114.1175537",
      lbslat: "022.6795310",
    })
  );
  assert.equal(uplink.why, "chg");
  assert.equal(uplink.label, "充电上报");
  assert.equal(uplink.opens, 0);
  assert.equal(uplink.lid, 1);
  assert.equal(uplink.charge, 1);
  assert.equal(uplink.openAge, null);
  assert.equal(uplink.lbsLng, Number("114.1175537"));
});

test("STM 的 t 覆盖模块时间，关箱单独成类", () => {
  const uplink = parser.parse(
    packet({
      uart: "why=shut,opens=1,lid=0,chg=0,t=1792564309000,seq=3",
      time: "1999-01-01 00:00:00",
    })
  );
  assert.equal(uplink.why, "shut");
  assert.equal(uplink.label, "关箱上报");
  assert.equal(uplink.lid, 0);
  assert.equal(uplink.opens, 1);
  assert.equal(uplink.deviceTime, "2026-10-21 14:31:49");
  assert.equal(uplink.deviceTime, formatUnixMs(1792564309000));
});

test("10 位秒和套娃里的 t 都按东八区", () => {
  const seconds = parser.parse(
    packet({ uart: "why=boot,t=1792564309", time: "1999-01-01 00:00:00" })
  );
  assert.equal(seconds.deviceTime, "2026-10-21 14:31:49");
  const nested = parser.parse(
    packet({
      uart: JSON.stringify({ uart: "why=pad,opens=1,lid=1,t=1792564309000" }),
      time: "1999-01-01 00:00:00",
    })
  );
  assert.equal(nested.why, "pad");
  assert.equal(nested.label, "开箱上报");
  assert.equal(nested.deviceTime, "2026-10-21 14:31:49");
});

test("粘在一起的两行拆成两条上报", () => {
  const raw = packet({
    uart: "why=timer,opens=0,lid=1,bat=4002,seq=58\r\nwhy=timer,opens=0,lid=1,bat=4000,seq=59\r\n",
    vbat: 4002,
    time: "2026-10-21 23:45:05",
  });
  const rows = parser.parseMany(raw);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].seq, 58);
  assert.equal(rows[1].seq, 59);
  assert.equal(rows[1].vbat, 4000);
});

test("掉电时间从 poff 读出，没有这个字段就空着", () => {
  const uplink = parser.parse(
    packet({
      uart: "why=boot,opens=0,lid=0,t=1792564309000,poff=1792564000000",
      time: "1999-01-01 00:00:00",
    })
  );
  assert.equal(uplink.deviceTime, "2026-10-21 14:31:49");
  assert.equal(uplink.powerOff, formatUnixMs(1792564000000));
  const later = parser.parse(
    packet({ uart: "why=timer,opens=0,lid=0", time: "2026-10-21 15:00:00" })
  );
  assert.equal(later.powerOff, "");
  const stored = parser.parse(packet({ uart: "why=timer,free=3145728,bat=4000" }));
  assert.equal(stored.storageFree, 3145728);
  const marked = parser.parse(packet({ uart: "why=timer,fw=1.0.0,seq=45" }));
  assert.equal(marked.firmware, "1.0.0");
  assert.equal(marked.seq, 45);
});

test("全零坐标不当成有效位置", () => {
  const uplink = parser.parse(packet());
  assert.equal(uplink.hasLbs(), false);
  assert.equal(uplink.hasGps(), false);
});

test("非法报文被拒绝", () => {
  assert.throws(() => parser.parse("不是 json"), UplinkError);
  assert.throws(() => parser.parse(packet({ imei: "abc" })), UplinkError);
  assert.throws(() => parser.parse(""), UplinkError);
});

test("定位成功时读 GPS 扩展信息；没定位或旧模板不读", async () => {
  const { UplinkParser } = await import("../src/domain/UplinkParser.js");
  const parser = new UplinkParser();
  const base = { imei: "864317080992517", uart: "why=timer,opens=0,fw=1.0.10,seq=1" };
  const fixed = parser.parse(
    JSON.stringify({
      ...base,
      gpsfix: 1,
      lng: 114.1,
      lat: 22.6,
      speed: 3.2,
      course: 181,
      alt: 45.5,
      sats: 9,
      hdop: 0.9,
      gpstime: "2026-10-29 10:00:00",
    })
  );
  assert.deepEqual(fixed.gpsInfo, {
    speed: 3.2,
    course: 181,
    alt: 45.5,
    sats: 9,
    hdop: 0.9,
    time: "2026-10-29 10:00:00",
  });
  assert.equal(parser.parse(JSON.stringify({ ...base, gpsfix: 0, speed: 3 })).gpsInfo, null);
  assert.equal(
    parser.parse(JSON.stringify({ ...base, gpsfix: 1, lng: 114.1, lat: 22.6 })).gpsInfo,
    null
  );
  assert.equal(
    parser.parse(
      JSON.stringify({ ...base, gpsfix: 1, lng: 114.1, lat: 22.6, course: 999, sats: 7 })
    ).gpsInfo.course,
    null
  );
});

test("补传批次：只有当前那行带模块此刻的位置；带上次 GPS 时按那次的时间记", () => {
  const now = Date.parse("2026-11-03T08:00:00Z");
  const body = {
    imei: "864317080992517",
    time: "2026-11-03 16:00:00",
    timem: String(now),
    gpsfix: 1,
    lng: 114.1,
    lat: 22.6,
    lbslng: 114.2,
    lbslat: 22.7,
    csq: 20,
    uart: [
      `why=timer,seq=10,q=10,qe=1,t=${now - 3600000}`,
      "why=timer,imei=bad\u0000",
      `why=pad,seq=11,q=11,qe=1,t=${now - 1000}`,
    ].join("\r\n"),
  };
  const lines = parser.parseMany(JSON.stringify(body));
  assert.equal(lines.length, 3);
  const [old, , current] = lines;
  assert.equal(old.hasGps(), false);
  assert.equal(old.hasLbs(), false);
  assert.equal(current.hasGps(), true);
  assert.equal(current.lbsLng, 114.2);

  // 单独补传上来的一条旧记录也不带此刻的位置
  const single = parser.parseMany(
    JSON.stringify({ ...body, uart: `why=timer,seq=9,q=9,qe=1,t=${now - 7200000}` })
  );
  assert.equal(single[0].hasGps(), false);

  // 新模板：此刻没定位，带 10 分钟内的上次 GPS
  const cached = parser.parse(
    JSON.stringify({
      ...body,
      gpsfix: 0,
      lng: undefined,
      glng: 114.3,
      glat: 22.5,
      gat: Math.floor(now / 1000) - 120,
      uart: `why=timer,t=${now}`,
    })
  );
  assert.equal(cached.hasGps(), true);
  assert.equal(cached.gpsLng, 114.3);
  assert.equal(cached.gpsAt, formatUnixMs(now - 120000));
});

test("固件 1.0.15 从闪存补发的行带 bf=1，摘要标「补传」；实时行不带", () => {
  const parser = new UplinkParser();
  const late = parser.parse(
    packet({ uart: "why=timer,opens=2,lid=0,chg=0,bat=3900,seq=8,q=7,qe=0,bf=1\r\n" })
  );
  assert.equal(late.backfill, true);
  assert.equal(late.q, 7);
  assert.match(late.digest, /补传$/);
  const live = parser.parse(
    packet({ uart: "why=timer,opens=2,lid=0,chg=0,bat=3900,seq=9,q=8,qe=0\r\n" })
  );
  assert.equal(live.backfill, false);
  assert.doesNotMatch(live.digest, /补传/);
  // bf 和 qz 同时出现（开机后第一条从闪存发出）时都能读到
  const both = parser.parse(packet({ uart: "why=boot,opens=0,q=512,qe=0,bf=1,qz=384\r\n" }));
  assert.equal(both.backfill, true);
  assert.equal(both.qz, 384);
});
