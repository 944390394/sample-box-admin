<template>
  <div class="flow" role="tablist" aria-label="检测流转">
    <template v-for="(step, i) in steps" :key="step.key">
      <button
        v-if="step.clickable !== false"
        type="button"
        role="tab"
        class="flow-step"
        :class="[`tone-${step.tone || 'default'}`, { active: active === step.key }]"
        :aria-selected="active === step.key"
        @click="emit('stepClick', step.key)"
      >
        <span class="flow-value">{{ step.value.toLocaleString() }}</span>
        <span class="flow-label">{{ step.label }}</span>
      </button>
      <div v-else class="flow-step static" :class="`tone-${step.tone || 'default'}`">
        <span class="flow-value">{{ step.value.toLocaleString() }}</span>
        <span class="flow-label">{{ step.label }}</span>
      </div>
      <span v-if="i < steps.length - 1" class="flow-arrow" aria-hidden="true">→</span>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { FlowStep } from "./types";
defineProps<{ steps: FlowStep[]; active?: string }>();
const emit = defineEmits<{ stepClick: [key: string] }>();
</script>

<style scoped>
.flow {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.flow-step {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  padding: 12px 16px;
  font: inherit;
  text-align: left;
  cursor: pointer;
  background: var(--content-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--card-radius);
  transition:
    border-color var(--motion-fast, 150ms),
    box-shadow var(--motion-fast, 150ms);
}
.flow-step:focus-visible {
  outline: var(--focus-ring, 2px solid var(--el-color-primary));
  outline-offset: 1px;
}
.flow-step.active {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 1px var(--el-color-primary) inset;
}
.flow-step.static {
  cursor: default;
}
.flow-value {
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}
.flow-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.tone-primary .flow-value {
  color: var(--el-color-primary);
}
.tone-warning .flow-value {
  color: var(--el-color-warning);
}
.tone-success .flow-value {
  color: var(--el-color-success);
}
.flow-arrow {
  align-self: center;
  font-size: 16px;
  color: var(--el-text-color-placeholder);
}
@media (max-width: 640px) {
  .flow {
    flex-wrap: wrap;
  }
  .flow-arrow {
    display: none;
  }
  .flow-step {
    flex: 1 1 40%;
  }
}
</style>
