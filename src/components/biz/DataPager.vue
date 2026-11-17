<template>
  <div class="data-pager">
    <span class="count">
      <template v-if="total != null">共 {{ total }} 条</template>
      <template v-else-if="shown != null">已显示 {{ shown }} 条</template>
    </span>
    <el-pagination
      v-if="total != null && total > pageSize"
      :current-page="page"
      :page-size="pageSize"
      :total="total"
      :page-sizes="sizes"
      :layout="sizes ? 'sizes, prev, pager, next' : 'prev, pager, next'"
      background
      size="small"
      @current-change="(value: number) => emit('update:page', value)"
      @size-change="(value: number) => emit('update:pageSize', value)"
    />
    <el-button v-else-if="hasMore" size="small" :loading="loading" @click="emit('more')">
      加载更多
    </el-button>
  </div>
</template>

<script setup lang="ts">
/**
 * 统一的翻页：知道总数时用页码（v-model:page、v-model:page-size），
 * 游标分页（只知道还有没有下一页）时显示「加载更多」。
 */
withDefaults(
  defineProps<{
    total?: number | null;
    shown?: number;
    page?: number;
    pageSize?: number;
    sizes?: number[];
    hasMore?: boolean;
    loading?: boolean;
  }>(),
  {
    total: null,
    shown: undefined,
    page: 1,
    pageSize: 20,
    sizes: undefined,
    hasMore: false,
    loading: false,
  }
);
const emit = defineEmits<{
  "update:page": [page: number];
  "update:pageSize": [size: number];
  more: [];
}>();
</script>

<style scoped>
.data-pager {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
}
.count {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
