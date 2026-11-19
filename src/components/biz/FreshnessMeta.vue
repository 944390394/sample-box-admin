<template>
  <span class="fresh-meta">
    <span v-if="updatedAt" class="freshness" :class="{ stale }">
      <i class="dot" />
      更新于 {{ ageText(updatedAt.toISOString()) }}
      <em v-if="stale">旧</em>
    </span>
    <span v-if="!error" class="auto-hint">
      <i class="pulse" />
      每 {{ interval / 1000 }} 秒自动刷新
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ageText } from "@/utils/position";
import { clock } from "@/utils/time";

const props = withDefaults(
  defineProps<{ updatedAt?: Date | null; error?: string; interval?: number }>(),
  { updatedAt: null, error: "", interval: 5000 }
);
const stale = computed(
  () =>
    Boolean(props.error) ||
    (props.updatedAt ? clock.value - props.updatedAt.getTime() > 20000 : false)
);
</script>

<style scoped>
.fresh-meta {
  display: inline-flex;
  gap: 10px;
  align-items: center;
}
.freshness {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}
.freshness .dot {
  width: 6px;
  height: 6px;
  background: var(--status-ok);
  border-radius: 50%;
}
.freshness.stale .dot {
  background: var(--status-warn);
}
.freshness em {
  padding: 0 4px;
  font-size: 11px;
  font-style: normal;
  line-height: 16px;
  color: var(--status-stale);
  border: 1px solid currentcolor;
  border-radius: 3px;
}
.auto-hint {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
.pulse {
  width: 6px;
  height: 6px;
  background: var(--el-color-primary);
  border-radius: 50%;
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}
</style>
