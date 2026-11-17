<template>
  <section class="section-card" :class="{ 'is-flush': flush }">
    <header v-if="title || $slots.title || $slots.extra" class="section-card__head">
      <div class="section-card__title">
        <slot name="title">{{ title }}</slot>
        <span v-if="sub" class="section-card__sub">{{ sub }}</span>
      </div>
      <div v-if="$slots.extra" class="section-card__extra"><slot name="extra" /></div>
    </header>
    <div class="section-card__body"><slot /></div>
  </section>
</template>

<script setup lang="ts">
/**
 * 全站统一的内容卡片：标题（可带一句补充）+ 右侧操作 + 内容。
 * flush 时内容贴边（放地图、表格）。
 */
defineProps<{ title?: string; sub?: string; flush?: boolean }>();
</script>

<style scoped>
.section-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
}
.section-card__head {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  align-items: center;
  justify-content: space-between;
  min-height: 46px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--card-divider);
}
.section-card__title {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}
.section-card__sub {
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.section-card__extra {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 13px;
}
.section-card__body {
  flex: 1;
  min-width: 0;
  padding: 16px;
}
.is-flush .section-card__body {
  padding: 0;
  overflow: hidden;
  border-radius: 0 0 var(--card-radius) var(--card-radius);
}
</style>
