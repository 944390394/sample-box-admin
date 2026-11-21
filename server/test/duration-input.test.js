/**
 * R14 上报周期时分秒联动：纯逻辑回归。
 * 被测＝src/utils/duration.ts（node type-stripping 直导 .ts；零依赖无需解析 hooks），
 * 与 DurationInput.vue 共用同一套函数。
 * 钉死：1) 自动进位（90 秒→0时1分30秒、60 分→1时）；2) 显示自适应归一（秒/分秒/时分）；
 *       3) clamp（低于 min/高于 max/非法值）；4) chips 按范围过滤；
 *       5) 分量变更 emit 的总秒数（applyDurationPart，含超范围 clamped 标记）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  DURATION_CHIPS,
  applyDurationPart,
  clampDuration,
  durationChips,
  durationEquals,
  formatDuration,
  joinDuration,
  splitDuration,
} from "../../src/utils/duration.ts";

test("splitDuration 自动进位：90 秒→0时1分30秒", () => {
  assert.deepEqual(splitDuration(90), { hours: 0, minutes: 1, seconds: 30 });
  assert.deepEqual(splitDuration(60), { hours: 0, minutes: 1, seconds: 0 });
  assert.deepEqual(splitDuration(59), { hours: 0, minutes: 0, seconds: 59 });
  assert.deepEqual(splitDuration(3600), { hours: 1, minutes: 0, seconds: 0 });
  assert.deepEqual(splitDuration(3661), { hours: 1, minutes: 1, seconds: 1 });
  assert.deepEqual(splitDuration(3599), { hours: 0, minutes: 59, seconds: 59 });
});

test("splitDuration 兜底：0/负数/小数/非法值不产生负分量", () => {
  assert.deepEqual(splitDuration(0), { hours: 0, minutes: 0, seconds: 0 });
  assert.deepEqual(splitDuration(-10), { hours: 0, minutes: 0, seconds: 0 });
  assert.deepEqual(splitDuration(90.9), { hours: 0, minutes: 1, seconds: 30 });
  assert.deepEqual(splitDuration(Number.NaN), { hours: 0, minutes: 0, seconds: 0 });
});

test("joinDuration 合量：分量允许超 59，进位交给归一", () => {
  assert.equal(joinDuration({ hours: 0, minutes: 1, seconds: 30 }), 90);
  assert.equal(joinDuration({ hours: 1, minutes: 0, seconds: 0 }), 3600);
  assert.equal(joinDuration({ hours: 0, minutes: 0, seconds: 90 }), 90);
  assert.equal(joinDuration({ hours: 0, minutes: 90, seconds: 0 }), 5400);
  assert.equal(joinDuration({ hours: 0, minutes: 1, seconds: 90 }), 150);
  // 合量→归一往返一致
  assert.deepEqual(splitDuration(joinDuration({ hours: 0, minutes: 0, seconds: 90 })), {
    hours: 0,
    minutes: 1,
    seconds: 30,
  });
});

test("clampDuration：低于 min 抬到 min、高于 max 压到 max、非法回落 min", () => {
  assert.equal(clampDuration(3, 5, 3600), 5);
  assert.equal(clampDuration(0, 5, 3600), 5);
  assert.equal(clampDuration(5000, 5, 3600), 3600);
  assert.equal(clampDuration(90, 5, 3600), 90);
  assert.equal(clampDuration(5, 5, 3600), 5);
  assert.equal(clampDuration(3600, 5, 3600), 3600);
  assert.equal(clampDuration(Number.NaN, 5, 3600), 5);
  assert.equal(clampDuration(90.6, 5, 3600), 91);
});

test("formatDuration 自适应：<60 秒、<3600 分秒、≥3600 时分", () => {
  assert.equal(formatDuration(0), "0 秒");
  assert.equal(formatDuration(30), "30 秒");
  assert.equal(formatDuration(59), "59 秒");
  assert.equal(formatDuration(60), "1 分 0 秒");
  assert.equal(formatDuration(90), "1 分 30 秒");
  assert.equal(formatDuration(3599), "59 分 59 秒");
  assert.equal(formatDuration(3600), "1 时 0 分");
  assert.equal(formatDuration(3661), "1 时 1 分");
  assert.equal(formatDuration(7200), "2 时 0 分");
});

test("durationEquals 灰字：恒含＝X秒，≥60 附归一括号（验收锚点 90/3600）", () => {
  assert.equal(durationEquals(30), "＝ 30 秒");
  assert.equal(durationEquals(90), "＝ 90 秒（1 分 30 秒）");
  assert.equal(durationEquals(600), "＝ 600 秒（10 分 0 秒）");
  assert.equal(durationEquals(3600), "＝ 3600 秒（1 时 0 分）");
});

test("chips：默认 5–3600 八枚全在，含 30 分钟/1 小时", () => {
  const chips = durationChips(5, 3600);
  assert.deepEqual(
    chips.map((c) => c.value),
    [5, 30, 60, 300, 600, 900, 1800, 3600]
  );
  assert.equal(chips.at(-1).label, "1 小时");
  assert.equal(chips[2].label, "1 分钟");
  assert.equal(DURATION_CHIPS.length, 8);
});

test("chips 按 max/min 过滤：范围外快捷值不出现", () => {
  assert.deepEqual(
    durationChips(5, 600).map((c) => c.value),
    [5, 30, 60, 300, 600]
  );
  assert.deepEqual(
    durationChips(60, 3600).map((c) => c.value),
    [60, 300, 600, 900, 1800, 3600]
  );
  assert.deepEqual(durationChips(5, 30), [
    { value: 5, label: "5 秒" },
    { value: 30, label: "30 秒" },
  ]);
});

test("分量变更 emit 总秒数：秒 90 进位后总量 90（显示 0时1分30秒）", () => {
  const { total, clamped } = applyDurationPart(
    { hours: 0, minutes: 0, seconds: 0 },
    "seconds",
    90,
    5,
    3600
  );
  assert.equal(total, 90);
  assert.equal(clamped, false);
  assert.deepEqual(splitDuration(total), { hours: 0, minutes: 1, seconds: 30 });
});

test("分量变更 emit 总秒数：分 60 进时（宽范围不 clamp）", () => {
  const r = applyDurationPart({ hours: 0, minutes: 0, seconds: 30 }, "minutes", 90, 5, 86400);
  assert.equal(r.total, 5430);
  assert.equal(r.clamped, false);
  assert.deepEqual(splitDuration(r.total), { hours: 1, minutes: 30, seconds: 30 });
  // 默认 max 3600 下 60 分＝3600 秒恰好到顶（进位到 1 时）
  const edge = applyDurationPart({ hours: 0, minutes: 0, seconds: 0 }, "minutes", 60, 5, 3600);
  assert.equal(edge.total, 3600);
  assert.equal(edge.clamped, false);
  assert.deepEqual(splitDuration(edge.total), { hours: 1, minutes: 0, seconds: 0 });
});

test("分量变更 clamp：秒输 5000 压到 3600 并标记 clamped（tooltip 依据）", () => {
  const r = applyDurationPart({ hours: 0, minutes: 1, seconds: 30 }, "seconds", 5000, 5, 3600);
  assert.equal(r.total, 3600);
  assert.equal(r.clamped, true);
  const h = applyDurationPart({ hours: 0, minutes: 0, seconds: 0 }, "hours", 2, 5, 3600);
  assert.equal(h.total, 3600);
  assert.equal(h.clamped, true);
});

test("分量变更 clamp：总量低于 min 抬到 5", () => {
  const r = applyDurationPart({ hours: 0, minutes: 0, seconds: 30 }, "seconds", 0, 5, 3600);
  assert.equal(r.total, 5);
  assert.equal(r.clamped, true);
  // 有分量托底时清秒不触发 clamp
  const ok = applyDurationPart({ hours: 0, minutes: 1, seconds: 30 }, "seconds", 0, 5, 3600);
  assert.equal(ok.total, 60);
  assert.equal(ok.clamped, false);
});

test("chip 选中＝直接 emit 该总秒数（范围内无需 clamp）", () => {
  for (const chip of durationChips(5, 3600)) {
    assert.equal(clampDuration(chip.value, 5, 3600), chip.value);
    assert.deepEqual(
      splitDuration(chip.value),
      splitDuration(joinDuration(splitDuration(chip.value)))
    );
  }
  assert.deepEqual(splitDuration(3600), { hours: 1, minutes: 0, seconds: 0 });
});
