<template>
  <div class="cal" :class="{ 'is-loading': loading }">
    <div class="cal-head">
      <button
        type="button"
        class="cal-nav"
        aria-label="上一月"
        @click="emit('monthChange', shiftMonth(month, -1))"
      >
        ‹
      </button>
      <div class="cal-title" aria-live="polite">{{ monthTitle(month) }}</div>
      <button
        type="button"
        class="cal-nav"
        aria-label="下一月"
        @click="emit('monthChange', shiftMonth(month, 1))"
      >
        ›
      </button>
      <button type="button" class="cal-today" :disabled="day === maxDay" @click="emit('today')">
        今天
      </button>
    </div>
    <div class="cal-week" aria-hidden="true">
      <span v-for="w in WEEK" :key="w">{{ w }}</span>
    </div>
    <div class="cal-grid" role="grid" :aria-label="`${monthTitle(month)}任务日历`" @keydown="onKey">
      <button
        v-for="cell in cells"
        :key="cell.day"
        type="button"
        role="gridcell"
        class="cal-cell"
        :class="{
          out: !cell.inMonth,
          picked: cell.day === day,
          today: cell.day === maxDay,
          future: cell.day > maxDay,
        }"
        :data-day="cell.day"
        :aria-selected="cell.day === day"
        :aria-label="`${cell.day}${counts && counts[cell.day] ? `，${counts[cell.day]} 张任务` : ''}`"
        :disabled="cell.day > maxDay"
        :tabindex="cell.day === day ? 0 : -1"
        @click="emit('select', cell.day)"
      >
        <span class="num">{{ cell.num }}</span>
        <span v-if="counts && counts[cell.day]" class="count">{{ counts[cell.day] }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { calendarGrid, monthTitle, shiftMonth, todayStr } from "@/composables/useCalendarGrid";

/**
 * 完全受控月历：选中日/显示月/角标全部由父级 props 驱动，组件零内部 state。
 * 轮询刷新只换 counts，不会重置选中日；翻月只发 monthChange 不动 day。
 */
const props = withDefaults(
  defineProps<{
    day: string;
    month: string;
    counts?: Record<string, number> | null;
    maxDay?: string;
    loading?: boolean;
  }>(),
  { counts: null, maxDay: todayStr(), loading: false }
);
const emit = defineEmits<{ select: [day: string]; monthChange: [month: string]; today: [] }>();

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];
const cells = computed(() => calendarGrid(props.month));

function focusDay(day: string) {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLButtonElement>(`.cal-grid [data-day="${day}"]`);
    el?.focus();
  });
}
function onKey(e: KeyboardEvent) {
  const cur = (e.target as HTMLElement).dataset.day;
  if (!cur) return;
  const d = new Date(`${cur}T00:00:00`);
  let next: string | null = null;
  if (e.key === "ArrowLeft") d.setDate(d.getDate() - 1);
  else if (e.key === "ArrowRight") d.setDate(d.getDate() + 1);
  else if (e.key === "ArrowUp") d.setDate(d.getDate() - 7);
  else if (e.key === "ArrowDown") d.setDate(d.getDate() + 7);
  else if (e.key === "PageUp") emit("monthChange", shiftMonth(props.month, -1));
  else if (e.key === "PageDown") emit("monthChange", shiftMonth(props.month, 1));
  else return;
  e.preventDefault();
  if (next === null && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
    next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (next > props.maxDay) return;
    if (next.slice(0, 7) !== props.month) emit("monthChange", next.slice(0, 7));
    emit("select", next);
    focusDay(next);
  }
}
</script>

<style scoped>
.cal-head {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}
.cal-nav {
  width: 28px;
  height: 28px;
  font-size: 16px;
  line-height: 1;
  color: var(--el-text-color-regular);
  cursor: pointer;
  background: var(--el-fill-color-light);
  border: none;
  border-radius: 6px;
  transition: background var(--motion-fast, 150ms);
}
.cal-nav:hover {
  background: var(--el-fill-color);
}
.cal-title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  text-align: center;
}
.cal-today {
  padding: 4px 12px;
  font-size: 12px;
  color: var(--el-color-primary);
  cursor: pointer;
  background: color-mix(in srgb, var(--el-color-primary) 10%, transparent);
  border: none;
  border-radius: 999px;
}
.cal-today:disabled {
  color: var(--el-text-color-placeholder);
  cursor: default;
  background: var(--el-fill-color-light);
}
.cal-week {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  margin-bottom: 4px;
}
.cal-week span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-align: center;
}
.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}
.cal-cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
  align-items: center;
  justify-content: center;
  height: 44px;
  font: inherit;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
  cursor: pointer;
  background: none;
  border: none;
  border-radius: 8px;
  transition: background var(--motion-fast, 150ms);
}
.cal-cell:hover:not(.picked):not(:disabled) {
  background: var(--el-fill-color-light);
}
.cal-cell:focus-visible {
  outline: var(--focus-ring, 2px solid var(--el-color-primary));
  outline-offset: 1px;
}
.cal-cell.out {
  opacity: 0.38;
}
.cal-cell.future {
  cursor: default;
  opacity: 0.35;
}
.cal-cell.today:not(.picked) .num {
  font-weight: 700;
  color: var(--el-color-primary);
}
.cal-cell.picked {
  color: #fff;
  background: var(--el-color-primary);
}
.cal-cell .count {
  font-size: 10px;
  line-height: 1;
  color: var(--el-color-primary);
}
.cal-cell.picked .count {
  color: #fff;
}
.is-loading .cal-grid {
  opacity: 0.6;
}
</style>
