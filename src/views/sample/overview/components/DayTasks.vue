<template>
  <div class="day-tasks">
    <div v-if="tasks.length" class="summary" role="group" aria-label="当日任务小结">
      <span class="chip">
        共
        <b>{{ tasks.length }}</b>
        张
      </span>
      <span v-if="sampling" class="chip">
        采样
        <b>{{ sampling }}</b>
      </span>
      <span v-if="transfer" class="chip">
        调拨
        <b>{{ transfer }}</b>
      </span>
      <span class="chip">
        合计
        <b>{{ boxSum }}</b>
        台箱子
      </span>
    </div>

    <ol v-if="tasks.length" class="timeline">
      <li
        v-for="task in tasks"
        :key="task.id"
        class="tl-item"
        :class="`is-${taskTone(task.status)}`"
      >
        <button
          type="button"
          class="tl-row"
          :aria-label="`${task.name}，${task.kind}，${task.status}，${task.boxes} 台箱子，查看详情`"
          :title="timeTitle(task)"
          @click="openTask(task)"
        >
          <span class="tl-dot" aria-hidden="true" />
          <span class="tl-body">
            <span class="tl-head">
              <b class="tl-name">{{ task.name }}</b>
              <el-tag
                size="small"
                :type="task.kind === '调拨' ? 'warning' : 'primary'"
                effect="plain"
              >
                {{ task.kind }}
              </el-tag>
              <el-tag size="small" :type="taskTone(task.status)">{{ task.status }}</el-tag>
              <span class="tl-boxes">{{ task.boxes }} 台</span>
            </span>
            <span class="tl-route">
              <span class="tl-route-text">{{ routeText(task) }}</span>
              <span class="tl-id mono">{{ task.id }}</span>
            </span>
            <span class="tl-time">
              <i class="lbl">创建</i>
              <TimeText :value="task.createdAt" mode="short" />
              <i class="tl-arrow" aria-hidden="true">→</i>
              <template v-if="task.endedAt">
                <i class="lbl">结束</i>
                <TimeText :value="task.endedAt" mode="short" />
              </template>
              <em v-else class="ongoing">进行中</em>
            </span>
          </span>
        </button>
      </li>
    </ol>
    <EmptyState v-else :description="`${dayText}没有任务`" />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DayTask } from "@/api/sample/overview";
import EmptyState from "@/components/ov/EmptyState.vue";
import TimeText from "@/components/biz/TimeText.vue";
import { fullTime } from "@/utils/time";
import { taskTone } from "@/utils/tone";

/** 选中那天进行过的任务：小结 chips + 竖向时间线，点一条进任务详情。 */
const props = defineProps<{ tasks: DayTask[]; dayText: string }>();
const router = useRouter();

const sampling = computed(() => props.tasks.filter((task) => task.kind === "采样").length);
const transfer = computed(() => props.tasks.filter((task) => task.kind === "调拨").length);
const boxSum = computed(() => props.tasks.reduce((n, task) => n + task.boxes, 0));

function routeText(task: DayTask) {
  return task.kind === "调拨"
    ? `${task.from || "—"} → ${task.to || "—"}`
    : `采样 · ${task.to || "—"}`;
}
function timeTitle(task: DayTask) {
  const start = `创建 ${fullTime(task.createdAt)}`;
  return task.endedAt ? `${start} · 结束 ${fullTime(task.endedAt)}` : `${start} · 进行中`;
}
function openTask(task: DayTask) {
  void router.push(`/task/detail/${task.id}`);
}
</script>

<style scoped>
.day-tasks {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  padding: 3px 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-lighter);
  border-radius: 999px;
}
.chip b {
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}
.timeline {
  display: flex;
  flex-direction: column;
  max-height: 460px;
  padding: 2px;
  margin: 0;
  overflow-y: auto;
  list-style: none;
}
.tl-item {
  --tl-color: var(--el-color-primary);

  position: relative;
  padding-left: 20px;
}
.tl-item.is-success {
  --tl-color: var(--el-color-success);
}
.tl-item.is-warning {
  --tl-color: var(--el-color-warning);
}
.tl-item.is-danger {
  --tl-color: var(--el-color-danger);
}
.tl-item.is-info {
  --tl-color: var(--status-stale);
}
.tl-item::before {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 5px;
  width: 2px;
  content: "";
  background: var(--card-divider);
}
.tl-item:first-child::before {
  top: 16px;
}
.tl-item:last-child::before {
  bottom: auto;
  height: 16px;
}
.tl-item:only-child::before {
  display: none;
}
.tl-dot {
  position: absolute;
  top: 12px;
  left: 0;
  width: 12px;
  height: 12px;
  background: var(--tl-color);
  border-radius: 50%;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--tl-color) 18%, transparent);
}
.tl-row {
  display: flex;
  width: 100%;
  padding: 8px 10px;
  font: inherit;
  text-align: left;
  cursor: pointer;
  background: none;
  border: 1px solid transparent;
  border-radius: 8px;
  transition:
    background var(--motion-fast, 150ms),
    border-color var(--motion-fast, 150ms);
}
.tl-row:hover {
  background: var(--el-fill-color-lighter);
  border-color: var(--card-border);
}
.tl-row:focus-visible {
  outline: var(--focus-ring, 2px solid var(--el-color-primary));
  outline-offset: 1px;
}
.tl-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.tl-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  min-width: 0;
}
.tl-name {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  white-space: nowrap;
}
.tl-boxes {
  margin-left: auto;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.tl-route {
  display: flex;
  gap: 8px;
  align-items: baseline;
  min-width: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.tl-route-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tl-id {
  flex-shrink: 0;
  margin-left: auto;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.tl-time {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}
.tl-time .lbl {
  font-size: 11px;
  font-style: normal;
  color: var(--el-text-color-placeholder);
}
.tl-arrow {
  font-style: normal;
  color: var(--el-text-color-placeholder);
}
.ongoing {
  padding: 0 8px;
  font-size: 11px;
  font-style: normal;
  line-height: 17px;
  color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 10%, transparent);
  border-radius: 999px;
}
</style>
