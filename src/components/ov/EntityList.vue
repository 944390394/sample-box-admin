<template>
  <div class="entity">
    <el-table
      v-if="!isMobile"
      v-loading="loading"
      :data="rows"
      :row-key="rowKey"
      class="entity-table"
      @row-click="(row) => emit('rowClick', row)"
    >
      <slot />
      <template #empty>
        <EmptyState :description="emptyText">
          <slot name="empty-action" />
        </EmptyState>
      </template>
    </el-table>
    <div v-else v-loading="loading" class="entity-cards">
      <button
        v-for="row in rows"
        :key="String(row[rowKey])"
        type="button"
        class="entity-card"
        @click="emit('rowClick', row)"
      >
        <slot name="card" :row="row" />
      </button>
      <EmptyState v-if="!rows.length && !loading" :description="emptyText">
        <slot name="empty-action" />
      </EmptyState>
    </div>
    <div v-if="total > 0" class="entity-foot">
      <el-pagination
        background
        :layout="isMobile ? 'total, prev, pager, next' : 'total, sizes, prev, pager, next, jumper'"
        :total="total"
        :page-sizes="[20, 50, 100]"
        :current-page="page"
        :page-size="pageSize"
        @update:current-page="(p) => emit('update:page', p)"
        @update:page-size="(s) => emit('update:pageSize', s)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useMediaQuery } from "@vueuse/core";
import EmptyState from "./EmptyState.vue";

withDefaults(
  defineProps<{
    rows: Record<string, unknown>[];
    total: number;
    page: number;
    pageSize: number;
    rowKey?: string;
    loading?: boolean;
    emptyText?: string;
  }>(),
  { rowKey: "id", loading: false, emptyText: "暂无数据" }
);
const emit = defineEmits<{
  rowClick: [row: Record<string, unknown>];
  "update:page": [p: number];
  "update:pageSize": [s: number];
}>();
const isMobile = useMediaQuery("(max-width: 767px)");
</script>

<style scoped>
.entity-table {
  width: 100%;
}
.entity-table :deep(.el-table__row) {
  cursor: pointer;
}
.entity-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 80px;
  padding: 12px;
}
.entity-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  font: inherit;
  text-align: left;
  cursor: pointer;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: 8px;
}
.entity-card:focus-visible {
  outline: var(--focus-ring, 2px solid var(--el-color-primary));
}
.entity-foot {
  display: flex;
  justify-content: flex-end;
  padding: 12px 16px;
  border-top: 1px solid var(--card-divider);
}
</style>
