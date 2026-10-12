import assert from "node:assert/strict";
import test from "node:test";

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
  assert.equal(uplink.hasGps(), true);
  assert.equal(uplink.gpsLng, Number("120.1551000"));
  assert.equal(uplink.lbsLng, Number("120.1500000"));
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
