<template>
  <div class="box-summary" data-test="summary-strip">
    <div v-if="can(BOX_PERM.power)" class="cell">
      <span class="label">{{ box.batteryUsable == null ? "电池电压" : "可用电量" }}</span>
      <div class="value">
        <strong :style="{ color: batteryTone }">{{ batteryValue }}</strong>
        <span
          v-if="can(BOX_PERM.charging) && (box.charge === 1 || box.charge === 2)"
          class="chip is-ok"
        >
          {{ chargeLabel(box.charge) }}
        </span>
      </div>
      <span class="hint">{{ batteryHint }}</span>
    </div>
    <div v-if="can(BOX_PERM.lid) || can(BOX_PERM.opens)" class="cell">
      <span class="label">{{ can(BOX_PERM.lid) ? "箱盖" : "开箱次数" }}</span>
      <div class="value">
        <strong v-if="can(BOX_PERM.lid)" :class="{ warn: box.lid === 1 }">
          {{ lidLabel(box.lid) }}
        </strong>
        <strong v-else>{{ box.opens ?? 0 }} 次</strong>
      </div>
      <span v-if="can(BOX_PERM.opens)" class="hint">
        {{ box.lastOpen ? `上次开箱 ${ageText(box.lastOpen, now)}` : "还没有开箱记录" }} · 累计
        {{ box.opens ?? 0 }} 次
      </span>
    </div>
    <div v-if="can(BOX_PERM.signal)" class="cell">
      <span class="label">信号</span>
      <div class="value">
        <span class="bars" :class="`is-${signal.level}`">
          <i v-for="n in 4" :key="n" :class="{ on: n <= signal.bars }" />
        </span>
        <strong>{{ signal.text }}</strong>
      </div>
      <span class="hint">{{ box.csq != null && box.csq !== 99 ? `CSQ ${box.csq}` : "" }}</span>
    </div>
    <div class="cell">
      <span class="label">最近上报</span>
      <div class="value">
        <span class="tick-box">
          <Transition name="tick" mode="out-in">
            <strong :key="lastText" data-test="summary-last">{{ lastText }}</strong>
          </Transition>
        </span>
        <span class="chip" :class="online ? 'is-ok' : 'is-stale'">
          {{ online ? "在线" : "离线" }}
        </span>
      </div>
      <span class="hint">
        {{
          box.reportPeriodSec
            ? `每 ${box.reportPeriodSec} 秒一次${box.reportOnlyWhenCharging ? "（只在充电时）" : ""}`
            : ""
        }}
      </span>
    </div>
    <div v-if="canLocation" class="cell cell--wide" data-test="summary-location">
      <span class="label">位置</span>
      <LocationLine :box="box" :period-sec="box.reportPeriodSec" compact />
    </div>
  </div>
</template>

<script setup lang="ts">
import LocationLine from "@/components/biz/LocationLine.vue";
import { usePerm } from "@/composables/usePerm";
import { chargeLabel, lidLabel } from "@/utils/labels";
import { ageText } from "@/utils/position";
import { clock } from "@/utils/time";
import { telemetryState } from "./telemetry";
import { BOX_PERM, type SampleBox } from "../data";

/**
 * 采样箱详情页头下面的状态条：电量、箱盖、信号、最近上报、当前位置。切换标签页也一直在。
 * 电量、箱盖、信号要「状态」权限，位置要「当前位置」权限。
 */
const props = defineProps<{ box: SampleBox }>();
// 全站时钟：「x 秒前」和在线状态每秒刷新
const now = computed(() => clock.value);
const can = usePerm();

const canLocation = computed(() => can(BOX_PERM.location));
const online = computed(
  () => telemetryState(props.box.last, props.box.reportPeriodSec, now.value).online
);
const lastText = computed(() => (props.box.last ? ageText(props.box.last, now.value) : "从未上报"));

const batteryValue = computed(() =>
  props.box.batteryUsable != null ? `${props.box.batteryUsable}%` : props.box.battery || "—"
);
const batteryTone = computed(() => {
  const v = props.box.batteryUsable;
  if (v == null) return "";
  return v < 20 ? "var(--status-danger)" : v < 50 ? "var(--status-warn)" : "";
});
const batteryHint = computed(() => {
  const b = props.box;
  if (b.batteryUsable == null) return "充放电学习后才有百分比";
  return [b.battery, b.batterySoc != null ? `总电量 ${b.batterySoc}%` : ""]
    .filter(Boolean)
    .join(" · ");
});

const signal = computed(() => {
  const csq = props.box.csq;
  if (csq == null) return { text: "—", bars: 0, level: "none" };
  if (csq === 99 || csq <= 0) return { text: "无信号", bars: 0, level: "none" };
  if (csq >= 20) return { text: "强", bars: 4, level: "ok" };
  if (csq >= 15) return { text: "中", bars: 3, level: "ok" };
  if (csq >= 10) return { text: "中", bars: 2, level: "warn" };
  return { text: "弱", bars: 1, level: "danger" };
});
</script>

<style scoped>
.box-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(120px, 1fr)) minmax(240px, 2fr);
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 12px 16px;
}
.cell + .cell {
  border-left: 1px solid var(--card-divider);
}
.label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.value {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 30px;
}
.value strong {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
  white-space: nowrap;
}
/* 「最近上报」每秒变一次：旧的往下淡出、新的从上淡入，很轻，不晃眼 */
.tick-box {
  display: inline-flex;
  overflow: hidden;
}
.tick-enter-active,
.tick-leave-active {
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}
.tick-enter-from {
  opacity: 0;
  transform: translateY(-40%);
}
.tick-leave-to {
  opacity: 0;
  transform: translateY(40%);
}
@media (prefers-reduced-motion: reduce) {
  .tick-enter-active,
  .tick-leave-active {
    transition: none;
  }
}
.value strong.warn {
  color: var(--status-warn);
}
.hint {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.chip {
  padding: 0 6px;
  font-size: 12px;
  line-height: 20px;
  border-radius: 4px;
}
.chip.is-ok {
  color: var(--status-ok);
  background: var(--status-ok-bg);
}
.chip.is-stale {
  color: var(--status-stale);
  background: var(--status-stale-bg);
}
.bars {
  display: inline-flex;
  gap: 2px;
  align-items: flex-end;
  height: 16px;
}
.bars i {
  width: 4px;
  background: var(--el-border-color);
  border-radius: 1px;
}
.bars i:nth-child(1) {
  height: 5px;
}
.bars i:nth-child(2) {
  height: 8px;
}
.bars i:nth-child(3) {
  height: 12px;
}
.bars i:nth-child(4) {
  height: 16px;
}
.bars.is-ok i.on {
  background: var(--status-ok);
}
.bars.is-warn i.on {
  background: var(--status-warn);
}
.bars.is-danger i.on {
  background: var(--status-danger);
}
.cell--wide :deep(.location-line) {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 30px;
  font-size: 13px;
}
@media (max-width: 1100px) {
  .box-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .cell + .cell {
    border-left: 0;
  }
  .cell {
    border-top: 1px solid var(--card-divider);
  }
  .cell:nth-child(-n + 2) {
    border-top: 0;
  }
  .cell:nth-child(2n) {
    border-left: 1px solid var(--card-divider);
  }
  .cell--wide {
    grid-column: 1 / -1;
    border-left: 0 !important;
  }
}
@media (max-width: 480px) {
  .cell {
    padding: 10px 12px;
  }
  .value strong {
    font-size: 17px;
  }
}
</style>
