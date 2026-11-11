<template>
  <span v-if="time" class="fresh-tag" :class="`is-${level}`" :title="fullTime(time)">
    <i class="fresh-tag__dot" />
    {{ prefix }}{{ text }}
    <em v-if="level === 'stale' && markStale" class="fresh-tag__old">旧</em>
  </span>
  <span v-else class="fresh-tag is-unknown">{{ emptyText }}</span>
</template>

<script setup lang="ts">
import { ageText, freshness } from "@/utils/position";
import { clock, fullTime } from "@/utils/time";

/**
 * 「多久以前」：新的绿点、有点旧的橙点、过时的灰字并标「旧」。悬停看完整时间。
 * 规则见 utils/position.ts 的 freshness。默认跟全站时钟每秒刷新；传了 now 就用传的。
 */
const props = withDefaults(
  defineProps<{
    time?: string | null;
    periodSec?: number | null;
    prefix?: string;
    markStale?: boolean;
    emptyText?: string;
    now?: number;
  }>(),
  {
    time: "",
    periodSec: null,
    prefix: "",
    markStale: true,
    emptyText: "—",
    now: undefined,
  }
);
// 没传 now 就跟全站时钟走，每秒刷新
const now = computed(() => props.now ?? clock.value);
const level = computed(() => freshness(props.time, props.periodSec, now.value));
const text = computed(() => ageText(props.time, now.value));
</script>

<style scoped>
.fresh-tag {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.fresh-tag__dot {
  width: 6px;
  height: 6px;
  background: currentcolor;
  border-radius: 50%;
}
.is-fresh {
  color: var(--status-ok);
}
.is-aging {
  color: var(--status-warn);
}
.is-stale,
.is-unknown {
  color: var(--status-stale);
}
.is-fresh,
.is-aging {
  /* 字用正文色，只有点是状态色 */
  color: var(--el-text-color-regular);
}
.is-fresh .fresh-tag__dot {
  background: var(--status-ok);
}
.is-aging .fresh-tag__dot {
  background: var(--status-warn);
}
.is-unknown .fresh-tag__dot {
  display: none;
}
.fresh-tag__old {
  padding: 0 4px;
  font-size: 11px;
  font-style: normal;
  line-height: 16px;
  color: var(--status-stale);
  border: 1px solid currentcolor;
  border-radius: 3px;
}
</style>
