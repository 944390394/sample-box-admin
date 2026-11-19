<template>
  <component
    :is="item.clickable === false ? 'div' : 'button'"
    :type="item.clickable === false ? undefined : 'button'"
    class="kpi"
    :class="[`tone-${item.tone || 'default'}`, { active, plain: item.clickable === false }]"
    @click="item.clickable !== false && emit('select', item.key)"
  >
    <span class="kpi-head">
      <span class="kpi-label">{{ item.label }}</span>
      <span v-if="item.icon" class="kpi-chip">
        <el-icon :size="17"><component :is="item.icon" /></el-icon>
      </span>
    </span>
    <strong class="kpi-value" aria-hidden="true">{{ display }}</strong>
    <span class="sr-only">{{ item.value }}</span>
    <span v-if="item.hint" class="kpi-hint">{{ item.hint }}</span>
  </component>
</template>

<script setup lang="ts">
import { useTransition } from "@vueuse/core";
import { computed, ref, watch } from "vue";
import type { KpiItem } from "./types";

const props = defineProps<{ item: KpiItem; active?: boolean }>();
const emit = defineEmits<{ select: [key: string] }>();

const source = ref(props.item.value);
const output = useTransition(source, { duration: 300 });
watch(
  () => props.item.value,
  (v) => (source.value = v)
);
const display = computed(() => Math.round(output.value).toLocaleString());
</script>

<style scoped>
.kpi {
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
    border-color var(--motion-fast, 150ms),
    box-shadow var(--motion-fast, 150ms),
    transform var(--motion-fast, 150ms);
}
.kpi:hover:not(.plain) {
  border-color: var(--card-border-hover);
  box-shadow: var(--card-shadow-hover);
  transform: translateY(-1px);
}
.kpi:focus-visible {
  outline: var(--focus-ring, 2px solid var(--el-color-primary));
  outline-offset: 1px;
}
.kpi.active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary) inset;
}
.kpi.plain {
  cursor: default;
}
.kpi-head {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  justify-content: space-between;
  min-width: 0;
}
.kpi-label {
  font-size: 13px;
  line-height: 1.45;
  color: var(--el-text-color-secondary);
}
.kpi-chip {
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
.kpi-value {
  font-size: 24px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
  color: var(--el-text-color-primary);
}
.kpi-hint {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-placeholder);
}
.tone-primary .kpi-value {
  color: var(--el-color-primary);
}
.tone-primary .kpi-chip {
  color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 12%, transparent);
}
.tone-success .kpi-value {
  color: var(--el-color-success);
}
.tone-success .kpi-chip {
  color: var(--el-color-success);
  background: color-mix(in srgb, var(--el-color-success) 12%, transparent);
}
.tone-warning .kpi-value {
  color: var(--el-color-warning);
}
.tone-warning .kpi-chip {
  color: var(--el-color-warning);
  background: color-mix(in srgb, var(--el-color-warning) 14%, transparent);
}
.tone-danger .kpi-value {
  color: var(--el-color-danger);
}
.tone-danger .kpi-chip {
  color: var(--el-color-danger);
  background: color-mix(in srgb, var(--el-color-danger) 12%, transparent);
}
.tone-info .kpi-value {
  color: var(--el-text-color-secondary);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  white-space: nowrap;
  clip-path: inset(50%);
}
@media (max-width: 640px) {
  .kpi {
    padding: 10px 12px;
  }
  .kpi-value {
    font-size: 20px;
  }
  .kpi-chip {
    width: 26px;
    height: 26px;
  }
}
</style>
