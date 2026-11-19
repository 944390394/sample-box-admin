<template>
  <div class="insight">
    <ErrorState v-if="error" :message="error" @retry="emit('retry')" />
    <el-skeleton v-else-if="loading" :rows="4" animated />
    <EmptyState v-else-if="empty" :description="emptyText" />
    <ECharts v-else :options="options" :height="height" @select="(p) => emit('select', p)" />
  </div>
</template>

<script setup lang="ts">
import ECharts from "@/components/ECharts/index.vue";
import EmptyState from "./EmptyState.vue";
import ErrorState from "./ErrorState.vue";
import type { ChartSelect } from "./types";

withDefaults(
  defineProps<{
    options: Record<string, unknown>;
    height?: string;
    loading?: boolean;
    error?: string;
    empty?: boolean;
    emptyText?: string;
  }>(),
  { height: "240px", loading: false, error: "", empty: false, emptyText: "暂无数据" }
);
const emit = defineEmits<{ select: [p: ChartSelect]; retry: [] }>();
</script>

<style scoped>
.insight {
  min-width: 0;
}
</style>
