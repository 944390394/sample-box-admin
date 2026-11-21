<template>
  <div class="stat-tiles" :style="{ '--cols': Math.min(items.length, max) }">
    <StatTileItem
      v-for="item in items"
      :key="item.key"
      :item="item"
      :active="modelValue === item.key"
      :muted-zero="mutedZero"
      @select="emit('update:modelValue', modelValue === item.key ? '' : item.key)"
    />
  </div>
</template>

<script setup lang="ts">
import StatTileItem, { type StatTile } from "./StatTileItem.vue";

/**
 * 指标卡：一排数字。可以兼作筛选，点一下选中、再点取消（v-model 是选中的 key）。
 * clickable 为 false 的只展示。tone 决定数字和图标颜色，icon 可选。
 * mutedZero 为真时零值数字降权（灰色小号），默认关，不影响既有页面。
 */
export type { StatTile };

withDefaults(
  defineProps<{ items: StatTile[]; modelValue?: string; max?: number; mutedZero?: boolean }>(),
  {
    modelValue: "",
    max: 6,
    mutedZero: false,
  }
);
const emit = defineEmits<{ "update:modelValue": [key: string] }>();
</script>

<style scoped>
.stat-tiles {
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  gap: 10px;
}
@media (max-width: 1100px) {
  .stat-tiles {
    grid-template-columns: repeat(min(var(--cols), 4), minmax(0, 1fr));
  }
}
@media (max-width: 640px) {
  .stat-tiles {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
