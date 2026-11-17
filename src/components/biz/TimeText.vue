<template>
  <span class="time-text" :title="value ? fullTime(value) : ''">{{ text }}</span>
</template>

<script setup lang="ts">
import { ago, fullTime, shortTime } from "@/utils/time";

/**
 * 时间显示：默认「x 分钟前」，悬停看完整时间。ISO 和服务器本地时间都能处理。
 * mode：ago 相对时间、short「10-29 21:23」、full 完整。
 */
const props = withDefaults(
  defineProps<{ value?: string | null; mode?: "ago" | "short" | "full" }>(),
  { value: "", mode: "ago" }
);
const text = computed(() => {
  if (!props.value) return "—";
  if (props.mode === "full") return fullTime(props.value);
  if (props.mode === "short") return shortTime(props.value);
  return ago(props.value);
});
</script>

<style scoped>
.time-text {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
