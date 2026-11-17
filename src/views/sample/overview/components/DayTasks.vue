<template>
  <div class="day-tasks">
    <div v-if="tasks.length" class="summary">
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
    <el-table
      v-if="tasks.length"
      :data="tasks"
      class="click-table"
      max-height="420"
      @row-click="(row: DayTask) => router.push(`/task/detail/${row.id}`)"
    >
      <el-table-column label="任务" min-width="200">
        <template #default="{ row }">
          <b>{{ row.name }}</b>
          <div class="text-muted mono">{{ row.id }}</div>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="76">
        <template #default="{ row }">
          <el-tag size="small" :type="row.kind === '调拨' ? 'warning' : 'primary'" effect="plain">
            {{ row.kind }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="路线" min-width="170">
        <template #default="{ row }">
          <span class="route">
            {{
              row.kind === "调拨"
                ? `${row.from || "—"} → ${row.to || "—"}`
                : `采样 · ${row.to || "—"}`
            }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="taskTone(row.status)">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="箱子" width="80" align="right">
        <template #default="{ row }">
          <span class="num">{{ row.boxes }}</span>
        </template>
      </el-table-column>
      <el-table-column label="创建" width="120">
        <template #default="{ row }"><TimeText :value="row.createdAt" /></template>
      </el-table-column>
    </el-table>
    <el-empty v-else :description="`${dayText}没有任务`" :image-size="70" />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DayTask } from "@/api/sample/overview";
import TimeText from "@/components/biz/TimeText.vue";
import { taskTone } from "@/utils/tone";

/** 选中那天进行过的任务：先一行小结，再一张可点进详情的表。 */
const props = defineProps<{ tasks: DayTask[]; dayText: string }>();
const router = useRouter();

const sampling = computed(() => props.tasks.filter((task) => task.kind === "采样").length);
const transfer = computed(() => props.tasks.filter((task) => task.kind === "调拨").length);
const boxSum = computed(() => props.tasks.reduce((n, task) => n + task.boxes, 0));
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
.click-table {
  width: 100%;
}
.click-table :deep(.el-table__row) {
  cursor: pointer;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.route {
  font-size: 13px;
}
.num {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
