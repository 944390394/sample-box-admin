<template>
  <el-calendar v-model="date" class="unit-calendar">
    <template #date-cell="{ data: cell }">
      <div
        class="cell"
        :class="{ picked: cell.day === day, has: Boolean(calendar?.[cell.day]) }"
        :data-day="cell.day"
      >
        <span>{{ Number(cell.day.slice(8)) }}</span>
        <i v-if="calendar?.[cell.day]" class="dot">{{ calendar[cell.day] }}</i>
      </div>
    </template>
  </el-calendar>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";

/**
 * 总览日历：选一天看当天任务，角标是那天进行中的单数。不能选未来的日子。
 * 翻月由 el-calendar 自带按钮完成，月份变化通过 change 事件带给父级重新取数。
 */
const props = defineProps<{ day: string; calendar: Record<string, number> | null }>();
const emit = defineEmits<{ change: [day: string, month: string] }>();

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function localDay(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const today = localDay(new Date());
const date = ref(new Date(`${props.day}T00:00:00`));

watch(
  () => props.day,
  (day) => {
    if (day !== localDay(date.value)) date.value = new Date(`${day}T00:00:00`);
  }
);
watch(date, (value) => {
  const next = localDay(value);
  if (next > today) {
    date.value = new Date(`${props.day}T00:00:00`);
    return;
  }
  if (next === props.day) return;
  emit("change", next, next.slice(0, 7));
});
</script>

<style scoped>
.unit-calendar {
  --el-calendar-border: var(--card-divider);
}
.unit-calendar :deep(.el-calendar__header) {
  padding: 4px 8px 8px;
  border-bottom: 0;
}
.unit-calendar :deep(.el-calendar__title) {
  font-size: 14px;
  font-weight: 600;
}
.unit-calendar :deep(.el-calendar__body) {
  padding: 0 8px 8px;
}
.unit-calendar :deep(.el-calendar-table thead th) {
  padding: 4px 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.unit-calendar :deep(.el-calendar-table .el-calendar-day) {
  height: 44px;
  padding: 2px;
}
.unit-calendar :deep(.el-calendar-table td.is-selected) {
  background: none;
}
.unit-calendar :deep(.el-calendar-table td.is-today .cell:not(.picked)) {
  font-weight: 700;
  color: var(--el-color-primary);
}
.unit-calendar :deep(td.prev),
.unit-calendar :deep(td.next) {
  opacity: 0.38;
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  border-radius: 6px;
  transition: background 0.15s;
}
.cell.has {
  font-weight: 600;
}
.cell:hover:not(.picked) {
  background: var(--el-fill-color-light);
}
.cell.picked {
  color: #fff;
  background: var(--el-color-primary);
}
.dot {
  font-size: 10px;
  font-style: normal;
  font-weight: 500;
  line-height: 1;
  color: var(--el-color-primary);
}
.cell.picked .dot {
  color: #fff;
}
</style>
