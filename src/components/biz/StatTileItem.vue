<template>
  <component
    :is="item.clickable === false ? 'div' : 'button'"
    :type="item.clickable === false ? undefined : 'button'"
    :title="item.title || undefined"
    class="tile"
    :class="[
      `tone-${item.tone || 'default'}`,
      { active, plain: item.clickable === false, 'is-zero': mutedZero && item.value === 0 },
    ]"
    @click="item.clickable !== false && emit('select')"
  >
    <span class="head">
      <span class="label">
        <span v-for="(part, i) in labelParts" :key="i" class="label-part">
          {{ i ? " · " : "" }}{{ part }}
        </span>
      </span>
      <span v-if="item.icon" class="chip">
        <el-icon :size="17"><component :is="item.icon" /></el-icon>
      </span>
    </span>
    <strong class="value">{{ display }}</strong>
    <span v-if="item.hint" class="hint">{{ item.hint }}</span>
  </component>
</template>

<script setup lang="ts">
import { useTransition } from "@vueuse/core";
import { computed, ref, watch, type Component } from "vue";

export interface StatTile {
  key: string;
  label: string;
  value: number | string | null | undefined;
  hint?: string;
  tone?: "default" | "primary" | "success" | "warning" | "danger" | "info";
  clickable?: boolean;
  icon?: Component;
  /** 悬停提示（原生 title），如「点击查看对应的筛选列表」。 */
  title?: string;
}

const props = defineProps<{ item: StatTile; active?: boolean; mutedZero?: boolean }>();
const emit = defineEmits<{ select: [] }>();

// 长标签按「 · 」断行，避免换行把词截断
const labelParts = computed(() => props.item.label.split(" · "));

// 数字变化时平滑滚到新值；首次渲染直接显示，不做入场动画
const numeric = computed(() => (typeof props.item.value === "number" ? props.item.value : null));
const source = ref(numeric.value ?? 0);
const output = useTransition(source, { duration: 300 });
watch(numeric, (n) => {
  if (n != null) source.value = n;
});
const display = computed(() =>
  numeric.value == null ? (props.item.value ?? "—") : Math.round(output.value).toLocaleString()
);
</script>

<style scoped>
.tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 14px 16px;
  font: inherit;
  text-align: left;
  cursor: pointer;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
  transition:
    border-color 0.15s,
    box-shadow 0.15s,
    transform 0.15s;
}
.tile:hover:not(.plain) {
  border-color: var(--card-border-hover);
  box-shadow: var(--card-shadow-hover);
  transform: translateY(-1px);
}
.tile.active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary) inset;
}
.tile.plain {
  cursor: default;
}
.head {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  justify-content: space-between;
  min-width: 0;
}
.label {
  font-size: 13px;
  line-height: 1.45;
  color: var(--el-text-color-secondary);
}
.label-part {
  white-space: nowrap;
}
.chip {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border-radius: 8px;
}
.value {
  font-size: 24px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
  color: var(--el-text-color-primary);
}
.hint {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
.tone-primary .value {
  color: var(--el-color-primary);
}
.tone-primary .chip {
  color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 12%, transparent);
}
.tone-success .value {
  color: var(--el-color-success);
}
.tone-success .chip {
  color: var(--el-color-success);
  background: color-mix(in srgb, var(--el-color-success) 12%, transparent);
}
.tone-warning .value {
  color: var(--el-color-warning);
}
.tone-warning .chip {
  color: var(--el-color-warning);
  background: color-mix(in srgb, var(--el-color-warning) 14%, transparent);
}
.tone-danger .value {
  color: var(--el-color-danger);
}
.tone-danger .chip {
  color: var(--el-color-danger);
  background: color-mix(in srgb, var(--el-color-danger) 12%, transparent);
}
.tone-info .value {
  color: var(--el-text-color-secondary);
}
/* mutedZero：零值数字降权（灰色小号），非零保持语义色；只影响数字，标签/图标不动 */
.tile.is-zero .value {
  font-size: 18px;
  font-weight: 600;
  color: var(--el-text-color-placeholder);
}
@media (max-width: 640px) {
  .tile {
    padding: 10px 12px;
  }
  .value {
    font-size: 20px;
  }
  .chip {
    width: 26px;
    height: 26px;
  }
}
</style>
