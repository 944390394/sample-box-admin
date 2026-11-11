<template>
  <div>
    <div class="filter-bar head">
      <el-radio-group v-model="kind" size="small">
        <el-radio-button value="">全部 {{ events.length }}</el-radio-button>
        <el-radio-button value="pad">开箱 {{ count("pad") }}</el-radio-button>
        <el-radio-button value="shut">关箱 {{ count("shut") }}</el-radio-button>
        <el-radio-button value="boot">上电 {{ count("boot") }}</el-radio-button>
      </el-radio-group>
      <el-select
        v-if="boxIds.length > 1"
        v-model="boxId"
        clearable
        placeholder="全部箱子"
        size="small"
        style="width: 180px"
      >
        <el-option v-for="id in boxIds" :key="id" :label="names[id] || id" :value="id" />
      </el-select>
    </div>
    <el-table
      :data="shown"
      size="small"
      empty-text="任务期间没有开关箱、上电记录"
      @row-click="(row: TaskEvent) => emit('focus', row.boxId)"
    >
      <el-table-column label="时间" width="170">
        <template #default="{ row }"><TimeText :value="row.time" mode="full" /></template>
      </el-table-column>
      <el-table-column label="事件" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="kindTone(row.kind)">{{ row.label }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="采样箱" min-width="160">
        <template #default="{ row }">{{ names[row.boxId] || row.boxId }}</template>
      </el-table-column>
      <el-table-column label="上报内容" min-width="240" show-overflow-tooltip prop="text" />
    </el-table>
  </div>
</template>

<script setup lang="ts">
import type { TaskEvent } from "@/api/sample/report-policy";
import TimeText from "@/components/biz/TimeText.vue";
import { toDate } from "@/utils/time";
import { kindTone } from "@/utils/tone";

/** 任务详情 · 事件：任务期间所有箱子的开箱、关箱、上电，新的在上。点一行在地图上定位那台箱子。 */
const props = defineProps<{ events: TaskEvent[]; names: Record<string, string> }>();
const emit = defineEmits<{ focus: [boxId: string] }>();
const kind = ref("");
const boxId = ref("");
const boxIds = computed(() => [...new Set(props.events.map((e) => e.boxId))]);
const count = (k: string) => props.events.filter((e) => e.kind === k).length;
const shown = computed(() =>
  props.events
    .filter(
      (e) => (!kind.value || e.kind === kind.value) && (!boxId.value || e.boxId === boxId.value)
    )
    .sort((a, b) => (toDate(b.time)?.getTime() ?? 0) - (toDate(a.time)?.getTime() ?? 0))
);
</script>

<style scoped>
.head {
  margin-bottom: 10px;
}
:deep(.el-table__row) {
  cursor: pointer;
}
</style>
