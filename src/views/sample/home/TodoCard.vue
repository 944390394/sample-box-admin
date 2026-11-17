<template>
  <div class="todo-card" :class="`tone-${tone}`">
    <div class="head">
      <span class="title">{{ title }}</span>
      <strong class="count">{{ bucket.total }}</strong>
    </div>
    <p v-if="hint" class="hint">{{ hint }}</p>
    <ul>
      <li v-for="item in bucket.list" :key="item.id" @click="emit('open', item.id)">
        <slot :item="item" />
      </li>
    </ul>
    <el-button
      v-if="bucket.total > bucket.list.length && more"
      link
      type="primary"
      class="more"
      @click="emit('more')"
    >
      全部 {{ bucket.total }} 项
    </el-button>
  </div>
</template>

<script setup lang="ts" generic="T extends { id: string }">
/** 工作台的一张待办卡：标题、数量、前几条，点一条打开详情，「全部」跳到筛好的列表。 */
defineProps<{
  title: string;
  bucket: { total: number; list: T[] };
  hint?: string;
  tone?: "primary" | "warning" | "danger" | "success";
  more?: boolean;
}>();
const emit = defineEmits<{ open: [id: string]; more: [] }>();
</script>

<style scoped>
.todo-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 12px 14px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-top: 3px solid var(--el-color-primary);
  border-radius: 8px;
}
.tone-warning {
  border-top-color: var(--el-color-warning);
}
.tone-danger {
  border-top-color: var(--el-color-danger);
}
.tone-success {
  border-top-color: var(--el-color-success);
}
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.title {
  font-weight: 600;
}
.count {
  font-size: 22px;
  font-variant-numeric: tabular-nums;
}
.hint {
  margin: 2px 0 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
ul {
  padding: 0;
  margin: 4px 0 0;
  list-style: none;
}
li {
  padding: 6px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 6px;
}
li:hover {
  background: var(--el-fill-color-lighter);
}
.more {
  align-self: flex-start;
  margin-top: 4px;
}
</style>
