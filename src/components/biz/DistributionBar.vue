<template>
  <div class="dist-bar" :style="{ height: `${height}px` }" :title="tooltip">
    <template v-if="total > 0">
      <i
        v-for="seg in visible"
        :key="seg.label"
        class="dist-bar__seg"
        :style="{ width: `${(seg.value / total) * 100}%`, background: seg.color }"
      />
    </template>
    <i v-else class="dist-bar__empty" />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

export interface DistSegment {
  label: string;
  value: number;
  /** 任意 CSS 颜色，建议传 var(--el-color-*) 以跟随主题 */
  color: string;
}

const props = withDefaults(defineProps<{ segments: DistSegment[]; height?: number }>(), {
  height: 6,
});
const visible = computed(() => props.segments.filter((s) => s.value > 0));
const total = computed(() => visible.value.reduce((n, s) => n + s.value, 0));
const tooltip = computed(() =>
  total.value ? visible.value.map((s) => `${s.label} ${s.value}`).join(" · ") : "暂无箱子"
);
</script>

<style scoped>
.dist-bar {
  display: flex;
  gap: 2px;
  width: 100%;
  overflow: hidden;
  border-radius: 999px;
}
.dist-bar__seg {
  min-width: 3px;
  border-radius: 999px;
  transition: width 0.3s;
}
.dist-bar__empty {
  width: 100%;
  background: var(--el-fill-color-light);
  border-radius: 999px;
}
</style>
