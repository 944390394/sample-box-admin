<template>
  <div class="stat-tiles" :style="{ '--cols': Math.min(items.length, max) }">
    <component
      :is="item.clickable === false ? 'div' : 'button'"
      v-for="item in items"
      :key="item.key"
      :type="item.clickable === false ? undefined : 'button'"
      class="tile"
      :class="[
        `tone-${item.tone || 'default'}`,
        { active: modelValue === item.key, plain: item.clickable === false },
      ]"
      @click="
        item.clickable !== false &&
        emit('update:modelValue', modelValue === item.key ? '' : item.key)
      "
    >
      <span class="label">{{ item.label }}</span>
      <strong class="value">{{ item.value ?? "—" }}</strong>
      <span v-if="item.hint" class="hint">{{ item.hint }}</span>
    </component>
  </div>
</template>

<script setup lang="ts">
/**
 * 指标卡：一排数字。可以兼作筛选，点一下选中、再点取消（v-model 是选中的 key）。
 * clickable 为 false 的只展示。tone 决定数字颜色。
 */
export interface StatTile {
  key: string;
  label: string;
  value: number | string | null | undefined;
  hint?: string;
  tone?: "default" | "primary" | "success" | "warning" | "danger" | "info";
  clickable?: boolean;
}

withDefaults(defineProps<{ items: StatTile[]; modelValue?: string; max?: number }>(), {
  modelValue: "",
  max: 6,
});
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
.tile {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 12px 14px;
  font: inherit;
  text-align: left;
  cursor: pointer;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.tile:hover:not(.plain) {
  border-color: var(--el-color-primary-light-5);
}
.tile.active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary) inset;
}
.tile.plain {
  cursor: default;
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.value {
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
  color: var(--el-text-color-primary);
}
.hint {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
.tone-primary .value {
  color: var(--el-color-primary);
}
.tone-success .value {
  color: var(--el-color-success);
}
.tone-warning .value {
  color: var(--el-color-warning);
}
.tone-danger .value {
  color: var(--el-color-danger);
}
.tone-info .value {
  color: var(--el-text-color-secondary);
}
@media (max-width: 640px) {
  .tile {
    padding: 8px 10px;
  }
  .value {
    font-size: 18px;
  }
}
</style>
