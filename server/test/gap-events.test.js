import test from "node:test";
import assert from "node:assert/strict";
import { gapEvents } from "../src/settings/taskTrack.js";

const BASE = new Date("2026-10-30T14:00:00").getTime();
const stamp = (minutes) => {
  const d = new Date(BASE + minutes * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
/** 收到时间（分钟）和设备时间（分钟，默认同收到时间）。 */
const row = (received, device = received) => ({
  received_at: stamp(received),
  device_time: stamp(device),
});
const policy = { periodSec: 60, chargeOnly: false };
const closed = { live: false };

test("一段接一段的 5 分钟失联合成一条「连接不稳定」", () => {
  const rows = [0, 6, 12, 18, 24, 30, 36].map((m) => row(m));
  const events = gapEvents("b", rows, policy, closed, Date.now());
  assert.equal(events.length, 1, JSON.stringify(events));
  assert.equal(events[0].label, "连接不稳定");
  assert.equal(events[0].count, 6);
  assert.match(events[0].text, /断了 6 次，最长 6 分钟/);
});

test("隔得远的两次失联分开记", () => {
  const rows = [row(0), row(10), ...Array.from({ length: 60 }, (_, i) => row(11 + i)), row(100)];
  const events = gapEvents("b", rows, policy, closed, Date.now());
  assert.equal(events.length, 2, JSON.stringify(events));
});

test("补回八成以上才说数据已补全；补得少要写缺多少", () => {
  // 失联 2 天，只补回 16 条
  const twoDays = 2 * 24 * 60;
  const few = [
    row(0),
    ...Array.from({ length: 16 }, (_, i) => row(twoDays + 1, 10 + i * 60)),
    row(twoDays),
  ];
  few.sort((a, b) => a.received_at.localeCompare(b.received_at));
  const [partial] = gapEvents("b", few, policy, closed, Date.now());
  assert.equal(partial.kind, "partial");
  assert.equal(partial.label, "数据不全");
  assert.match(partial.text, /只补传了 16 条，按上报周期应有约 2879 条，缺约 2863 条/);

  // 30 分钟空档补回 28 条（应有 29 条）
  const full = [row(0), row(30), ...Array.from({ length: 28 }, (_, i) => row(31, 1 + i))];
  const [weak] = gapEvents("b", full, policy, closed, Date.now());
  assert.equal(weak.kind, "weak");
  assert.match(weak.text, /补传了 28 条离线记录，数据已补全/);
});

test("补传晚到也算：不限恢复后 30 分钟内", () => {
  const rows = [row(0), row(20), row(120, 5), row(121, 10)];
  const [event] = gapEvents("b", rows, policy, closed, Date.now());
  assert.equal(event.backfilled, 2);
});

test("一条没补回是连接中断", () => {
  const [event] = gapEvents("b", [row(0), row(20)], policy, closed, Date.now());
  assert.equal(event.kind, "gap");
  assert.equal(event.label, "连接中断");
});
