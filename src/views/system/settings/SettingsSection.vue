<template>
  <SectionCard :title="title" class="settings-section">
    <p v-if="desc" class="settings-section__desc">{{ desc }}</p>
    <slot />
  </SectionCard>
</template>

<script setup lang="ts">
import SectionCard from "@/components/biz/SectionCard.vue";

/**
 * 系统设置 › 统一分区壳：复用全站 SectionCard（同 padding/圆角/边框），
 * 标题 + 一行描述 + 内容 slot，八个分区与名称图标卡共用。
 * id、v-loading 等经 attrs/指令透传落到根节点，供 scrollspy 与加载遮罩使用。
 */
defineProps<{ title: string; desc?: string }>();
</script>

<style scoped>
.settings-section {
  scroll-margin-top: 12px;
}
.settings-section__desc {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
</style>
