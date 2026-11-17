<template>
  <header class="page-header">
    <div class="main">
      <el-button v-if="back" class="back" :icon="ArrowLeft" text @click="goBack">返回</el-button>
      <div class="titles">
        <div class="title-line">
          <h1>{{ title }}</h1>
          <slot name="tags" />
        </div>
        <p v-if="$slots.meta || subtitle" class="meta">
          <slot name="meta">{{ subtitle }}</slot>
        </p>
      </div>
    </div>
    <div v-if="$slots.actions" class="actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<script setup lang="ts">
import { ArrowLeft } from "@element-plus/icons-vue";

/**
 * 全站统一的页头：标题、标签、补充信息和右侧操作。
 * back 传一个兜底地址：有上一页就返回上一页（保留列表的筛选和翻页），直接打开的就去这个地址。
 */
const props = defineProps<{ title: string; subtitle?: string; back?: string }>();
const router = useRouter();

function goBack() {
  if (window.history.state?.back) router.back();
  else if (props.back) void router.push(props.back);
}
</script>

<style scoped>
.page-header {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  align-items: center;
  justify-content: space-between;
}
.main {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  min-width: 0;
}
.back {
  padding: 4px 8px;
  margin-top: 2px;
}
.titles {
  min-width: 0;
}
.title-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 28px;
  color: var(--el-text-color-primary);
}
.meta {
  margin: 2px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
</style>
